// Outside-in fault injection for the visual crawl: applies recipes from research/visual/injectors.json to a correct
// page that crawl.mjs has loaded, and labels the exact elements with data-bench-fault (space-separated recipe ids).
// Nothing here edits a repo demo, compat app or template (AGENTS.md rule 4): recipes run in the crawled page only,
// through page.evaluate, after the clean views of that load were extracted.
//
// What runs here: recipes whose phase is "after-load" (125 of 163), in Chromium, at the recipe's emulation
// (viewport, colour scheme, reduced motion, classic scrollbars). The other phases need a second load (before-load,
// network, init) or real input on a live site (on-interaction: opening dialogs and menus), and are left to a later
// stage with its own politeness rules; chooseRecipes() never returns them unless asked.
//
// Helpers given to each operation follow injectors.json "helpers": sel, id, seed, pick, pickMany, tallest, mark,
// markAll, markPage, css, deleteRules, setText, textNodes, resolvedBackground, enableAppDarkMode,
// rewriteDarkRulesToMedia, photoUrl, lightPhotoUrl. pick and pickMany choose with a seeded RNG among visible
// candidates (VISUAL.md 2.1) and throw NotApplicable when there are too few; the recipe is then recorded as not
// applicable, not as a fault.

import { readFile } from "node:fs/promises";

/** Load and lightly validate injectors.json. */
export async function loadRecipes(path) {
  const j = JSON.parse(await readFile(path, "utf8"));
  const list = j.injectors || [];
  for (const r of list) if (!r.id || !r.operation || !r.label) throw new Error(`bad recipe ${r.id || "?"}`);
  return list;
}

/** Which device load a recipe belongs to: "phone" for touch or a viewport under 600 px wide, else "desktop". */
export function deviceOf(recipe) {
  const env = recipe.env || {};
  if (env.hasTouch) return "phone";
  if (env.viewport && env.viewport[0] < 600) return "phone";
  return "desktop";
}

/** Recipes the crawl can run: the given phases, Chromium only. */
export function runnable(recipes, phases = ["after-load"]) {
  return recipes.filter((r) => phases.includes(r.phase) && (!r.env || !r.env.browser || r.env.browser === "chromium"));
}

/**
 * Choose 1 to `max` recipes for one load on `device`: the first at random (a control with probability
 * `controlShare`), the rest only with the same emulation, never two with the same catalog id.
 */
export function chooseRecipes(recipes, device, rand, { max = 3, controlShare = 0.15 } = {}) {
  const pool = recipes.filter((r) => deviceOf(r) === device);
  const faults = pool.filter((r) => r.kind === "fault");
  const controls = pool.filter((r) => r.kind === "control");
  const from = controls.length && rand() < controlShare ? controls : faults;
  if (!from.length) return [];
  const first = from[Math.floor(rand() * from.length)];
  const envKey = JSON.stringify(first.env || {});
  const k = 1 + Math.floor(rand() * max);
  const out = [first];
  const same = faults.filter((r) => r !== first && JSON.stringify(r.env || {}) === envKey && r.catalog_id !== first.catalog_id);
  while (out.length < k && same.length) {
    const i = Math.floor(rand() * same.length);
    const r = same.splice(i, 1)[0];
    if (!out.some((o) => o.catalog_id === r.catalog_id)) out.push(r);
  }
  return out;
}

/**
 * Recipes whose effect the undo journal cannot reverse (CSSOM edits, stylesheet.disabled, timers, listeners, media
 * playback state). crawl.mjs runs them only in the last injection round of a load.
 */
export function finalOnly(recipe) {
  return /deleteRules|rewriteDarkRulesToMedia|insertRule|deleteRule\(|replaceSync|adoptedStyleSheets|styleSheets|\.disabled\s*=|setTimeout|setInterval|requestAnimationFrame|addEventListener\(|\.pause\(|\.play\(|currentTime|history\.|location\b/.test(recipe.operation);
}

/**
 * Choose the recipes for one injection round on `device`, balanced by family: with probability `controlShare` the
 * first is a control, else a fault whose family is drawn with weight 1 / (applied faults of that family so far + 3),
 * so families that apply rarely (no visible target) are tried more often. Up to `max` recipes per round, the rest
 * with the same emulation, distinct catalog ids, none used earlier in this load (`used`). `final` allows finalOnly
 * recipes. `counts` is shared across the process: {family: applied faults}.
 */
export function chooseRound(recipes, device, rand, counts, { max = 3, controlShare = 0.15, final = false, used = new Set() } = {}) {
  const pool = recipes.filter((r) => deviceOf(r) === device && !used.has(r.id) && (final || !finalOnly(r)));
  const faults = pool.filter((r) => r.kind === "fault");
  const controls = pool.filter((r) => r.kind === "control");
  const byFamily = (list) => {
    const m = new Map();
    for (const r of list) {
      if (!m.has(r.family)) m.set(r.family, []);
      m.get(r.family).push(r);
    }
    return m;
  };
  const drawFault = (list) => {
    const fam = byFamily(list);
    if (!fam.size) return null;
    const ks = [...fam.keys()];
    const w = ks.map((k) => 1 / ((counts[k] || 0) + 3));
    let x = rand() * w.reduce((a, b) => a + b, 0);
    let k = ks[ks.length - 1];
    for (let i = 0; i < ks.length; i++) {
      x -= w[i];
      if (x <= 0) {
        k = ks[i];
        break;
      }
    }
    const rs = fam.get(k);
    return rs[Math.floor(rand() * rs.length)];
  };
  let first = null;
  if (controls.length && rand() < controlShare) first = controls[Math.floor(rand() * controls.length)];
  else first = drawFault(faults);
  if (!first) return [];
  const envKey = JSON.stringify(first.env || {});
  const k = 1 + Math.floor(rand() * max);
  const out = [first];
  let same = faults.filter((r) => r !== first && JSON.stringify(r.env || {}) === envKey && r.catalog_id !== first.catalog_id);
  while (out.length < k && same.length) {
    const r = drawFault(same);
    same = same.filter((x) => x !== r && x.catalog_id !== r.catalog_id);
    if (!out.some((o) => o.catalog_id === r.catalog_id)) out.push(r);
  }
  return out;
}

/** The emulation a set of recipes needs (they share one env by construction). */
export function envOf(recipes) {
  return (recipes[0] && recipes[0].env) || {};
}

/** Page-side helper runtime: defines globalThis.__visionInject(list, seed) -> results. Needs extract.js first. */
export const PAGE_RUNTIME = String.raw`
(function (root) {
  "use strict";
  class NotApplicable extends Error {}
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(s, base) {
    let h = base >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h;
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    try {
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    } catch (e) {}
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let n = el; n; n = n.parentElement) if (n.getAttribute && (n.getAttribute("aria-hidden") === "true" || n.hasAttribute("inert"))) return false;
    return true;
  }
  let photoCache = null;
  function photo(light) {
    const c = document.createElement("canvas");
    c.width = 800;
    c.height = 500;
    const g = c.getContext("2d");
    const gr = g.createLinearGradient(0, 0, 800, 500);
    if (light) {
      gr.addColorStop(0, "#f8fafc");
      gr.addColorStop(1, "#e2e8f0");
    } else {
      gr.addColorStop(0, "#334155");
      gr.addColorStop(0.5, "#64748b");
      gr.addColorStop(1, "#0f172a");
    }
    g.fillStyle = gr;
    g.fillRect(0, 0, 800, 500);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = "rgba(" + (light ? "255,255,255" : "15,23,42") + "," + (0.05 + (i % 7) / 30) + ")";
      g.beginPath();
      g.arc((i * 137) % 800, (i * 89) % 500, 20 + (i % 9) * 6, 0, Math.PI * 2);
      g.fill();
    }
    return c.toDataURL("image/jpeg", 0.8);
  }
  // Undo journal for multi-round injection. Every DOM change a recipe makes synchronously (attributes, text,
  // inserted or removed nodes) is recorded by a MutationObserver and drained with takeRecords() before any page
  // script can run; __visionUndo() replays the records backwards. CSSOM edits, stylesheet.disabled, timers and
  // listeners are not recorded, so crawl.mjs runs recipes that use them (finalOnly) only in a load's last round.
  root.__visionInject = function (list, seed, opts) {
    opts = opts || {};
    const mo = new MutationObserver(() => {});
    mo.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
    const adopted = document.adoptedStyleSheets ? document.adoptedStyleSheets.slice() : null;
    let results;
    try {
      if (opts.classicScrollbars) {
        const s = document.createElement("style");
        s.textContent = "::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#999}";
        (document.head || document.documentElement).appendChild(s);
      }
      results = injectAll(list, seed);
    } finally {
      const records = mo.takeRecords();
      mo.disconnect();
      root.__visionJournal = { records, adopted };
      root.__visionMarked = Array.from(document.querySelectorAll("[data-bench-fault]")).filter((el) => el.tagName !== "STYLE");
      for (const el of root.__visionMarked) el.__benchLab = el.getAttribute("data-bench-fault") || "";
    }
    return results;
  };
  root.__visionUndo = function () {
    const j = root.__visionJournal;
    if (!j) return { ok: false, n: 0 };
    let bad = 0;
    for (let k = j.records.length - 1; k >= 0; k--) {
      const r = j.records[k];
      try {
        if (r.type === "attributes") {
          if (r.oldValue === null) r.target.removeAttributeNS(r.attributeNamespace, r.attributeName);
          else if (r.attributeNamespace) r.target.setAttributeNS(r.attributeNamespace, r.attributeName, r.oldValue);
          else r.target.setAttribute(r.attributeName, r.oldValue);
        } else if (r.type === "characterData") {
          r.target.data = r.oldValue;
        } else {
          for (let i = r.addedNodes.length - 1; i >= 0; i--) {
            const n = r.addedNodes[i];
            if (n.parentNode === r.target) r.target.removeChild(n);
          }
          const next = r.nextSibling && r.nextSibling.parentNode === r.target ? r.nextSibling : null;
          for (let i = 0; i < r.removedNodes.length; i++) r.target.insertBefore(r.removedNodes[i], next);
        }
      } catch (e) {
        bad++;
      }
    }
    try {
      if (j.adopted) document.adoptedStyleSheets = j.adopted;
    } catch (e) {
      bad++;
    }
    const n = j.records.length;
    root.__visionJournal = null;
    return { ok: bad === 0, n, bad };
  };
  /** Viewport boxes of the elements the last injection marked (labels taken at injection time). */
  root.__visionMarkedBoxes = function () {
    return (root.__visionMarked || []).map((el) => {
      const r = el.isConnected ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      return { lab: el.__benchLab || "", page: el === document.documentElement ? 1 : 0, x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    });
  };
  /** A cheap layout signature: element count and the rounded boxes of the first 400 elements. */
  root.__visionSig = function () {
    const els = document.getElementsByTagName("*");
    const boxes = [];
    for (let i = 0; i < els.length && boxes.length < 400; i++) {
      const r = els[i].getBoundingClientRect();
      boxes.push(((Math.round(r.left / 4) * 73856093) ^ (Math.round(r.top / 4) * 19349663) ^ (Math.round(r.width / 4) * 83492791) ^ Math.round(r.height / 4)) >>> 0);
    }
    return { n: els.length, boxes };
  };
  function injectAll(list, seed) {
    const results = [];
    const lib = root.__visionLib;
    for (const item of list) {
      const id = item.id;
      const sel = item.select || "";
      const rand = rng(hashSeed(id, seed));
      const choose = (arr) => arr[Math.floor(rand() * arr.length)];
      const cands = (selector, rootEl) => {
        let els = [];
        try {
          els = Array.from((rootEl || document).querySelectorAll(selector || "*"));
        } catch (e) {
          throw new NotApplicable("bad selector");
        }
        return els.filter(visible);
      };
      const markOne = (el) => {
        if (!el || !el.setAttribute) return;
        const cur = (el.getAttribute("data-bench-fault") || "").split(" ").filter(Boolean);
        if (cur.indexOf(id) < 0) cur.push(id);
        el.setAttribute("data-bench-fault", cur.join(" "));
      };
      const h = {
        sel,
        id,
        seed,
        pick(selector, rootEl) {
          const c = cands(selector, rootEl);
          if (!c.length) throw new NotApplicable("no visible target");
          return choose(c);
        },
        pickMany(selector, min, max, rootEl) {
          const c = cands(selector, rootEl);
          if (c.length < min) throw new NotApplicable("too few visible targets");
          const n = Math.min(c.length, min + Math.floor(rand() * (max - min + 1)));
          for (let i = 0; i < n; i++) {
            const j = i + Math.floor(rand() * (c.length - i));
            const t = c[i];
            c[i] = c[j];
            c[j] = t;
          }
          return c.slice(0, n);
        },
        tallest(selector) {
          const c = cands(selector);
          if (!c.length) throw new NotApplicable("no visible target");
          return c.reduce((a, b) => (b.getBoundingClientRect().height > a.getBoundingClientRect().height ? b : a));
        },
        mark: markOne,
        markAll(selector) {
          for (const el of cands(selector)) markOne(el);
        },
        markPage() {
          markOne(document.documentElement);
        },
        css(text) {
          const s = document.createElement("style");
          s.setAttribute("data-bench-fault", id);
          s.textContent = text;
          (document.head || document.documentElement).appendChild(s);
          if (!s.sheet) {
            // a CSP that blocks inline style elements: fall back to a constructed sheet
            s.remove();
            const sh = new CSSStyleSheet();
            sh.replaceSync(text);
            document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sh]);
          }
        },
        deleteRules(pred) {
          const walk = (list, owner) => {
            for (let i = list.length - 1; i >= 0; i--) {
              const r = list[i];
              if (r.cssRules && !(r instanceof CSSStyleRule)) walk(r.cssRules, r);
              else if (pred(r)) owner.deleteRule(i);
            }
          };
          for (const s of Array.from(document.styleSheets)) {
            try {
              walk(s.cssRules, s);
            } catch (e) {}
          }
        },
        setText(el, text) {
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = w.nextNode())) if (n.nodeValue && n.nodeValue.trim()) {
            n.nodeValue = text;
            return;
          }
          el.textContent = text;
        },
        textNodes(el) {
          const out = [];
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = w.nextNode())) if (n.nodeValue && n.nodeValue.trim()) out.push(n);
          return out;
        },
        resolvedBackground(el) {
          const layers = [];
          for (let n = el; n && n.nodeType === 1 && layers.length < 32; n = n.parentElement) {
            const cs = getComputedStyle(n);
            layers.push({ color: lib.parseColor(cs.backgroundColor), image: cs.backgroundImage !== "none", media: /^(IMG|VIDEO|CANVAS|PICTURE)$/.test(n.tagName), filter: cs.filter !== "none" || cs.backdropFilter !== "none" });
          }
          const r = lib.resolveLayers(layers, [255, 255, 255, 1]);
          if (r.status > 1) throw new NotApplicable("background unknown");
          return "rgb(" + r.rgb.map(Math.round).join(", ") + ")";
        },
        enableAppDarkMode() {
          document.documentElement.classList.add("dark");
          document.documentElement.setAttribute("data-theme", "dark");
          document.documentElement.style.colorScheme = "dark";
        },
        rewriteDarkRulesToMedia() {
          const moved = [];
          const walk = (list, owner) => {
            for (let i = list.length - 1; i >= 0; i--) {
              const r = list[i];
              if (r instanceof CSSStyleRule && /\.dark\b/.test(r.selectorText)) {
                const selText = r.selectorText.replace(/:is\(\.dark \*\)|\.dark\s*/g, "").trim() || ":root";
                moved.push("@media (prefers-color-scheme: dark){" + selText + "{" + r.style.cssText + "}}");
                owner.deleteRule(i);
              } else if (r.cssRules && !(r instanceof CSSStyleRule)) walk(r.cssRules, r);
            }
          };
          for (const s of Array.from(document.styleSheets)) {
            try {
              walk(s.cssRules, s);
            } catch (e) {}
          }
          if (moved.length) h.css(moved.join("\n"));
        },
        get photoUrl() {
          return photoCache || (photoCache = photo(false));
        },
        get lightPhotoUrl() {
          return photo(true);
        },
      };
      const res = { id, kind: item.kind, catalog_id: item.catalog_id, applied: false, reason: "", marked: 0 };
      try {
        item.fn(h);
        res.applied = true;
      } catch (e) {
        res.reason = e instanceof NotApplicable ? "n/a: " + e.message : "error: " + String((e && e.message) || e).slice(0, 120);
      }
      let marked = [];
      try {
        marked = Array.from(document.querySelectorAll('[data-bench-fault~="' + id + '"]')).filter((el) => el.tagName !== "STYLE");
      } catch (e) {}
      res.marked = marked.length;
      if (res.applied && res.marked === 0 && item.label && item.label.attribute !== "page") {
        res.applied = false;
        res.reason = "n/a: nothing marked";
      }
      if (!res.applied && res.marked > 0) {
        // the operation threw after changing the page: drop its labels and flag the view, so training can skip it
        res.partial = true;
        for (const el of marked) {
          const rest = (el.getAttribute("data-bench-fault") || "").split(" ").filter((x) => x && x !== id);
          if (rest.length) el.setAttribute("data-bench-fault", rest.join(" "));
          else el.removeAttribute("data-bench-fault");
        }
        res.marked = 0;
      }
      results.push(res);
    }
    return results;
  }
})(globalThis);
`;

/**
 * The expression page.evaluate runs to apply `recipes`: each operation becomes a function of the helper object, so
 * the page never needs eval (a page CSP without unsafe-eval cannot block it).
 */
export function injectionScript(recipes, seed, opts = {}) {
  const items = recipes.map((r) => {
    const params = "{ sel, id, seed, pick, pickMany, tallest, mark, markAll, markPage, css, deleteRules, setText, textNodes, resolvedBackground, enableAppDarkMode, rewriteDarkRulesToMedia, photoUrl, lightPhotoUrl }";
    // photoUrl and lightPhotoUrl are getters; destructuring reads them only when the operation names them
    const needsPhoto = /\bphotoUrl\b|\blightPhotoUrl\b/.test(r.operation);
    const p = needsPhoto ? params : params.replace(", photoUrl, lightPhotoUrl", "");
    return `{ id: ${JSON.stringify(r.id)}, kind: ${JSON.stringify(r.kind)}, catalog_id: ${JSON.stringify(r.catalog_id)}, select: ${JSON.stringify(r.select || "")}, label: ${JSON.stringify(r.label)}, fn: function (${p}) { ${r.operation}\n } }`;
  });
  return `globalThis.__visionInject([${items.join(",\n")}], ${seed >>> 0}, ${JSON.stringify(opts)})`;
}
