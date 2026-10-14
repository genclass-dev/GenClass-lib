// Outside-in fault injection for the visual crawl: applies recipes from research/visual/injectors.json to a correct
// page that crawl.mjs has loaded, and labels the exact elements. Nothing here edits a repo demo, compat app or
// template (AGENTS.md rule 4): recipes run in the crawled page only, through page.evaluate, after the natural views
// of that load were extracted.
//
// v2 (traceless injection). The v1 model learned the recipes' traces (inline style attributes, data-bench-fault,
// bench-* classes) instead of the bugs. In v2 a recipe leaves no inline style attribute, no data-* or class marker on
// the elements it breaks:
// - Labels live in a JS-side WeakMap (globalThis.__visionLabels, element -> space-separated recipe ids) that the
//   extractor reads; nothing is written to the DOM to label an element.
// - Every style a recipe writes goes through one constructed stylesheet in document.adoptedStyleSheets (no node in
//   the DOM). The recipes' operations are unchanged; after each recipe returns (synchronously, before any page script
//   runs) the scrubber turns what it wrote into rules of that sheet:
//     inline style changes on existing elements -> rules for a structural selector of the element (id anchor or
//       :nth-child path, computed again at the end of the round), the attribute restored to its old value;
//     inline styles of nodes the recipe created -> the same, the attribute removed;
//     bench-* marker classes and [data-bench-fault~=id] selectors in css() text -> :is(<structural selectors>) of
//       the elements that carried them, the classes removed;
//     other class or data-* changes (an unbacked Tailwind class, a renamed token) -> the computed-style difference
//       they made on the element and its descendants, written as rules, the attributes restored.
//   Then it checks that no style, class or data-* attribute differs from its value before the recipe; a recipe that
//   still leaves one gets `trace` set and its view is dropped from training (like `partial`).
// - CSSOM edits (deleteRules, rewriteDarkRulesToMedia) are journaled and re-inserted by the undo; stylesheet.disabled
//   is snapshotted per round. The undo restores adoptedStyleSheets and empties the injected sheet.
// - Other attribute changes are the fault itself (an svg without viewBox, a disabled button, a removed aria-label, a
//   placeholder instead of a label) and stay; they are reported per recipe in `attrs`.
// Recipes that cannot be traceless, or that make the page request anything (third-party content or extra requests
// to the host), are dropped from training: DROPPED below lists each with the reason.
//
// What runs here: recipes whose phase is "after-load", in Chromium. A recipe's emulation is mapped onto the natural
// views the crawl has (desktop 1366x768 or phone 390x844 in the same desktop context, light or dark); viewport
// sizes, classic scrollbars and reduced motion are not emulated, and recipes whose fault needs them are dropped.
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

/** Which device view a recipe belongs to: "phone" for touch or a viewport under 600 px wide, else "desktop". */
export function deviceOf(recipe) {
  const env = recipe.env || {};
  if (env.hasTouch) return "phone";
  if (env.viewport && env.viewport[0] < 600) return "phone";
  return "desktop";
}

/** The colour scheme a recipe runs in (the only emulation v2 keeps besides the device view). */
export function schemeOf(recipe) {
  return recipe.env && recipe.env.colorScheme === "dark" ? "dark" : "light";
}

/** Recipes the crawl can run: the given phases, Chromium only. */
export function runnable(recipes, phases = ["after-load"]) {
  return recipes.filter((r) => phases.includes(r.phase) && (!r.env || !r.env.browser || r.env.browser === "chromium"));
}

/**
 * Runnable recipes v2 drops from training, with the reason. Three kinds: the recipe makes the page request something
 * (third-party content, or an extra request to the crawled host); its fault cannot be made traceless (a timer or
 * observer writes after the scrubber ran, a data-* attribute is the whole fault, the root element's attributes change);
 * or its fault needs an emulation the crawl's natural views do not have.
 */
export const DROPPED = {
  "image-invented-unsplash": "request: points an img at images.unsplash.com (third-party)",
  "image-dead-placeholder-host": "request: points an img at source.unsplash.com (third-party)",
  "image-css-background-404": "request: a CSS background URL on the crawled host (an extra request to the site)",
  "control-image-lazy-offscreen": "request: an img URL on the crawled host (an extra request to the site)",
  "embed-youtube-dead-id": "request: a YouTube embed (third-party)",
  "embed-maps-placeholder-key": "request: a Google static-maps image (third-party)",
  "control-embed-live-video": "request: a YouTube embed (third-party)",
  "control-maps-query-embed": "request: a Google Maps embed (third-party)",
  "video-autoplay-unmuted": "request: video.load() fetches the media again; playback state cannot be undone",
  "video-source-dead-sample": "request: a video on commondatastorage.googleapis.com (third-party)",
  "control-video-muted-autoplay": "request: play() fetches media; playback state cannot be undone",
  "control-video-controls": "request: seeking (currentTime) fetches media",
  "embed-rickroll-placeholder": "request: a YouTube embed (third-party)",
  "control-embed-real-video": "request: a YouTube embed (third-party)",
  "builder-badge-and-title": "request: a favicon link to /vite.svg on the crawled host; also edits the document title",
  "bootstrap4-attrs-on-5": "trace: the fault is a data-* attribute rename with no effect at rest",
  "control-bootstrap-both-attrs": "trace: the control is a data-* attribute with no effect at rest",
  "shift-late-banner": "trace: a timer inserts and styles the banner after the scrubber ran; the undo cannot see it",
  "reveal-threshold-unreachable": "trace: an IntersectionObserver callback can write an inline style after the scrubber ran",
  "control-reveal-completes": "trace: its IntersectionObserver callback writes an inline style after the scrubber ran",
  "wheel-hijack": "trace: a wheel listener on window; nothing changes at rest and the listener cannot be removed",
  "dark-variant-media-only": "trace: the fault needs the app's dark class on the root element; nothing changes at rest in a light view",
  "rtl-flip": "trace: sets the dir attribute on the root element (page-level label only)",
  "sticky-broken-wrapper": "trace: reparents every body child into a new wrapper (depth and structure of the whole page change); the fault only shows when scrolling",
  "overflow-100vw-classic": "emulation: needs classic scrollbars; the crawl's Chromium hides scrollbars in every view",
  "scrollbar-double": "emulation: needs classic scrollbars; also reparents every body child",
  "control-scroller-scrollbar-visible": "emulation: differs from its fault only by a classic scrollbar, which no view shows",
  "breakpoint-small-range": "emulation: the fault exists only at 992 to 995 px wide; no view has that width",
  "sticky-stack": "emulation: a landscape phone (568x320); the phone view is portrait",
  "motion-infinite-decoration": "emulation: the fault is ignoring prefers-reduced-motion: reduce, which no view emulates",
};

/**
 * Trainable recipes whose effect reaches elements they do not label, across the page: the root font size, every
 * stylesheet, a sideways-scrolling page (the layout viewport widens), a reflowed or hidden app root, a fixed overlay
 * over every element, a restyled subtree. Their views keep their labelled rows (and page labels) for training but
 * give no `clean` rows: those elements are changed by the fault and unlabelled, so they are neither negatives nor a
 * fair provenance check. Chosen from the v2 provenance audit (train/provenance.py byRecipeSolo, run 1 on the
 * 2026-10-14 crawl: ROC AUC of the views where the recipe was the only one applied, at least 0.57); every other
 * recipe scored 0.47 to 0.57 there.
 */
export const SPREAD = {
  "stylesheets-disabled": "every stylesheet disabled (0.977)",
  "text-scale-200": "root font size 200% and global spacing (0.952)",
  "overflow-nowrap-row": "the page scrolls sideways (0.923)",
  "overflow-wide-pre": "the page scrolls sideways (0.919)",
  "layout-fixed-sidebar": "a section moved into a fixed-width row: the page scrolls sideways (0.916)",
  "text-tiny-mobile": "body, p and li font size 11px on the phone (0.889)",
  "overflow-iframe-fixed": "the page scrolls sideways (0.874)",
  "overflow-fixed-width": "the page scrolls sideways (0.850)",
  "blowout-grid-1fr": "a blown-out grid: the page scrolls sideways (0.826)",
  "overflow-decorative-blob": "the page scrolls sideways (0.822)",
  "blowout-long-string": "a nowrap string in a flex row: the page scrolls sideways (0.779)",
  "blank-root-emptied": "the app root emptied: the rest of the page reflows (0.702)",
  "layout-grid-fixed-columns": "a section forced into 3 columns: the page scrolls sideways (0.676)",
  "blank-root-hidden": "the app root hidden: the rest of the page reflows (0.646)",
  "icon-shrink": "a long label appended to a flex row: the content below moves (0.635)",
  "vite-template-centering": "body made a centring flex box: every element moves (0.616)",
  "class-subtree-unbacked": "every class in a subtree renamed: the whole subtree restyled, only its root labelled (0.600)",
  "jank-blur-stack": "a fixed full-viewport layer and backdrop filters (0.586)",
  "overlap-clone-offset": "an absolutely positioned clone appended to body (0.579)",
  "popup-no-focus": "a fixed overlay over every element (0.577)",
};

/** Recipes whose operation holds a URL only as text content (no request). */
export const TEXT_ONLY_URLS = new Set(["control-embed-id-in-code"]);

/** Runnable recipes minus DROPPED: what the v2 crawl injects. */
export function trainable(recipes, phases = ["after-load"]) {
  return runnable(recipes, phases).filter((r) => !DROPPED[r.id]);
}

/**
 * Static checks on a recipe's operation text, the reasons it could make a request or leave a trace that the scrubber
 * cannot remove. Every trainable recipe must return []; test/inject.test.mjs checks it over injectors.json.
 */
export function lint(recipe) {
  const op = recipe.operation || "";
  const out = [];
  if (/https?:\/\//.test(op) && !TEXT_ONLY_URLS.has(recipe.id)) out.push("url");
  if (/url\(\s*['"]?\//.test(op)) out.push("css-url-request");
  if (/\.src\s*=\s*['"`](?!data:)/.test(op) || /\.href\s*=/.test(op)) out.push("src-request");
  if (/\.load\(\)|\.play\(|currentTime/.test(op)) out.push("media-request");
  if (/setTimeout|setInterval|requestAnimationFrame|IntersectionObserver|MutationObserver|addEventListener\(\s*['"](wheel|scroll|resize)/.test(op)) out.push("late-write");
  if (/setAttribute\(\s*['"]data-|\.dataset\b/.test(op)) out.push("data-attribute");
  if (/\.dir\s*=|setAttribute\(\s*['"]dir['"]|document\.title|rel\s*=\s*['"]icon/.test(op)) out.push("root-or-head");
  if (recipe.env && recipe.env.reducedMotion) out.push("reduced-motion");
  return out;
}

/**
 * Choose 1 to `max` recipes for one load on `device` (v1 chooser, kept for the tests): the first at random (a control
 * with probability `controlShare`), the rest only with the same emulation, never two with the same catalog id.
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
 * Recipes whose effect the undo cannot reverse (timers, listeners, media playback state, a lost WebGL context,
 * direct CSSOM edits outside the journaled helpers). crawl.mjs runs them only in a load's last injection round. The
 * journaled helpers (deleteRules, rewriteDarkRulesToMedia) and stylesheet.disabled are undone in v2.
 */
export function finalOnly(recipe) {
  return /setTimeout|setInterval|requestAnimationFrame|addEventListener\(|IntersectionObserver|\.pause\(|\.play\(|\.load\(|currentTime|loseContext|history\.|location\b|insertRule|deleteRule\(|replaceSync|adoptedStyleSheets/.test(recipe.operation);
}

/**
 * Choose the recipes for one injection round on `device`, balanced by family: with probability `controlShare` the
 * first is a control, else a fault whose family is drawn with weight 1 / (applied faults of that family so far + 3),
 * so families that apply rarely (no visible target) are tried more often. Up to `max` recipes per round, the rest in
 * the same colour scheme, distinct catalog ids, none used earlier in this load (`used`). `final` allows finalOnly
 * recipes. `schemes` lists the colour schemes this host has natural views in (a dark round only where a natural dark
 * view of the same device exists). `counts` is shared across the process: {family: applied faults}.
 */
export function chooseRound(recipes, device, rand, counts, { max = 3, controlShare = 0.15, final = false, used = new Set(), schemes = ["light", "dark"] } = {}) {
  const pool = recipes.filter((r) => deviceOf(r) === device && !used.has(r.id) && (final || !finalOnly(r)) && schemes.includes(schemeOf(r)));
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
  const scheme = schemeOf(first);
  const k = 1 + Math.floor(rand() * max);
  const out = [first];
  let same = faults.filter((r) => r !== first && schemeOf(r) === scheme && r.catalog_id !== first.catalog_id);
  while (out.length < k && same.length) {
    const r = drawFault(same);
    same = same.filter((x) => x !== r && x.catalog_id !== r.catalog_id);
    if (!out.some((o) => o.catalog_id === r.catalog_id)) out.push(r);
  }
  return out;
}

/** The emulation a set of recipes needs in v2: only the colour scheme (they share one by construction). */
export function envOf(recipes) {
  return { colorScheme: recipes[0] ? schemeOf(recipes[0]) : "light" };
}

/**
 * Page-side runtime: defines globalThis.__visionInject(list, seed) -> results, __visionUndo(), __visionMarkedBoxes(),
 * __visionSig(), __visionResidue(), and the pure helpers in __visionInjectLib (cssPath, resolveMarkers, declText) for
 * the browser-free tests. Needs extract.js first (__visionLib).
 */
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

  // ---------------------------------------------------------------- structural selectors and rule text (pure)

  function esc(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    const t = String(s).replace(/[^\w-]/g, (c) => "\\" + c);
    return /^\d/.test(t) ? "\\3" + t[0] + " " + t.slice(1) : t;
  }
  /** A selector for el computed now: the nearest ancestor with a unique id, else :root or body, then a child path of
   * tag:nth-child(k). null when el is detached or inside a shadow root. */
  function cssPath(el) {
    const doc = el.ownerDocument;
    if (el === doc.documentElement) return ":root";
    const parts = [];
    for (let n = el; n; n = n.parentElement) {
      if (n === doc.documentElement) {
        parts.unshift(":root");
        break;
      }
      if (n === doc.body) {
        parts.unshift("body");
        break;
      }
      const id = n.getAttribute ? n.getAttribute("id") : null;
      if (id) {
        let one = false;
        try {
          one = doc.querySelectorAll("#" + esc(id)).length === 1;
        } catch (e) {}
        if (one) {
          parts.unshift("#" + esc(id));
          break;
        }
      }
      let k = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) k++;
      parts.unshift(esc(n.localName) + ":nth-child(" + k + ")");
      if (!n.parentElement) return null;
    }
    return parts.join(" > ");
  }
  /** :is(<selectors of the connected elements>), or :not(*) when none is left. */
  function selList(els) {
    const s = [];
    for (const el of els || []) {
      if (!el.isConnected) continue;
      const p = cssPath(el);
      if (p) s.push(p);
    }
    return s.length ? ":is(" + s.join(", ") + ")" : ":not(*)";
  }
  /** Replace the recipe markers in css() text with structural selectors: [data-bench-fault~="id"] by the elements
   * that recipe marked, .bench-* by the elements that carried the class. */
  function resolveMarkers(text, byRecipe, byClass) {
    return String(text)
      .replace(/\[data-bench-fault~=(["'])([^"']+)\1\]/g, (_, q, id) => selList(byRecipe.get(id)))
      .replace(/\.(bench-[A-Za-z0-9_-]+)/g, (_, tok) => selList(byClass.get(tok)));
  }
  /** {prop: value} -> "prop: value !important; ..." */
  function declText(m) {
    return Object.keys(m).map((p) => p + ": " + m[p] + " !important").join("; ");
  }
  root.__visionInjectLib = { cssPath, selList, resolveMarkers, declText };

  // ---------------------------------------------------------------- the round

  // R holds one injection round: labels (WeakMap element -> ids), created elements, the injected sheet's sources
  // (css() texts and per-element rules), the journals the undo replays. null between rounds.
  let R = null;
  let scratch = null;
  /** Longhand declarations of a style attribute value: {prop: [value, priority]}. */
  function decls(text) {
    if (!scratch) scratch = document.createElement("div");
    scratch.setAttribute("style", text || "");
    const st = scratch.style;
    const out = {};
    for (let i = 0; i < st.length; i++) {
      const p = st[i];
      out[p] = [st.getPropertyValue(p), st.getPropertyPriority(p)];
    }
    return out;
  }
  function elRule(el) {
    let m = R.elRules.get(el);
    if (!m) R.elRules.set(el, (m = {}));
    return m;
  }
  function addTo(map, key, el) {
    let s = map.get(key);
    if (!s) map.set(key, (s = new Set()));
    s.add(el);
  }
  /** Write the injected sheet: css() texts (markers resolved unless raw), then one rule per restyled element. */
  function rebuild(raw) {
    const out = [];
    for (const t of R.texts) out.push(raw ? t : resolveMarkers(t, R.byRecipe, R.byClass));
    for (const [el, m] of R.elRules) {
      if (!el.isConnected) continue;
      const sel = cssPath(el);
      const body = declText(m);
      if (sel && body) out.push(sel + " { " + body + "; }");
    }
    R.own.replaceSync(out.join("\n"));
  }
  function snapStyles(els) {
    const m = new Map();
    for (const e of els) {
      const cs = getComputedStyle(e);
      const o = {};
      for (let i = 0; i < cs.length; i++) {
        const p = cs[i];
        o[p] = cs.getPropertyValue(p);
      }
      m.set(e, o);
    }
    return m;
  }
  const DIFF_CAP = 800;
  /**
   * Turn what one recipe wrote into rules of the injected sheet (see the file header) and report what is left:
   * { trace: [...], attrs: [...] }. Runs with no MutationObserver attached, so its own restores are not journaled;
   * the undo replays the recipe's records to the same old values.
   */
  function scrub(recs) {
    const trace = [];
    const attrs = new Set();
    // created elements: added in these records (with their subtrees), not in the document at round start
    const made = [];
    for (const r of recs) {
      if (r.type !== "childList") continue;
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        const all = [n].concat(Array.from(n.getElementsByTagName("*")));
        for (const e of all) if (!R.before.has(e) && !R.created.has(e)) (R.created.add(e), made.push(e));
      }
    }
    // first old value per (existing element, attribute); created elements touched again
    const firstOld = new Map();
    const madeTouched = new Set(made);
    for (const r of recs) {
      if (r.type !== "attributes") continue;
      const t = r.target;
      if (R.created.has(t)) {
        madeTouched.add(t);
        continue;
      }
      let m = firstOld.get(t);
      if (!m) firstOld.set(t, (m = new Map()));
      if (!m.has(r.attributeName)) m.set(r.attributeName, r.oldValue);
    }
    for (const e of madeTouched) {
      const st = e.getAttribute("style");
      if (st != null) {
        const d = decls(st);
        const m = elRule(e);
        for (const p in d) m[p] = d[p][0];
        e.removeAttribute("style");
      }
      if (e.classList && e.classList.length)
        for (const c of Array.from(e.classList))
          if (/^bench-/.test(c)) {
            addTo(R.byClass, c, e);
            e.classList.remove(c);
          }
      if (e.hasAttribute("class") && !e.getAttribute("class")) e.removeAttribute("class");
      for (const a of Array.from(e.attributes)) if (/^data-bench/.test(a.name)) e.removeAttribute(a.name);
    }
    // existing elements
    const styleEls = [];
    const diffEls = [];
    for (const [t, m] of firstOld)
      for (const [a, old] of m) {
        const now = t.getAttribute(a);
        if (now === old) continue;
        if (a === "style") styleEls.push([t, old]);
        else if (a === "class") {
          const was = (old || "").split(/\s+/).filter(Boolean);
          const is = (now || "").split(/\s+/).filter(Boolean);
          const bench = is.filter((c) => /^bench-/.test(c) && was.indexOf(c) < 0);
          for (const c of bench) addTo(R.byClass, c, t);
          const rest = is.filter((c) => bench.indexOf(c) < 0);
          if (rest.join(" ") === was.join(" ")) {
            if (old === null) t.removeAttribute("class");
            else t.setAttribute("class", old);
          } else {
            t.setAttribute("class", rest.join(" "));
            diffEls.push([t, a, old]);
          }
        } else if (a.indexOf("data-") === 0) diffEls.push([t, a, old]);
        else attrs.add(a);
      }
    if (diffEls.length) {
      // class or data-* changes: emulate them by the computed-style difference on the element and its descendants
      const aff = new Set();
      for (const [t] of diffEls) {
        aff.add(t);
        if (aff.size <= DIFF_CAP) for (const d of t.getElementsByTagName("*")) aff.add(d);
      }
      if (aff.size > DIFF_CAP) trace.push("restyle-too-large:" + aff.size);
      else {
        const after = snapStyles(aff);
        for (const [t, a, old] of diffEls) {
          if (old === null) t.removeAttribute(a);
          else t.setAttribute(a, old);
        }
        const before = snapStyles(aff);
        for (const e of aff) {
          const A = after.get(e);
          const B = before.get(e);
          let m = null;
          for (const p in A)
            if (A[p] !== B[p]) {
              if (!m) m = elRule(e);
              m[p] = A[p];
            }
        }
      }
    }
    for (const [t, old] of styleEls) {
      const cur = t.getAttribute("style");
      const dn = decls(cur);
      const dold = decls(old);
      const m = elRule(t);
      for (const p in dn) if (!dold[p] || dold[p][0] !== dn[p][0] || dold[p][1] !== dn[p][1]) m[p] = dn[p][0];
      const removed = Object.keys(dold).filter((p) => !dn[p]);
      if (removed.length) {
        // a declaration the recipe removed: the value the sheets give without it (read while it is still absent)
        const cs = getComputedStyle(t);
        for (const p of removed) m[p] = cs.getPropertyValue(p);
      }
      if (!Object.keys(m).length) R.elRules.delete(t);
      if (old === null) t.removeAttribute("style");
      else t.setAttribute("style", old);
    }
    // what is left: style, class or data-* values that differ from before the recipe, on any element it touched
    for (const [t, m] of firstOld)
      for (const [a, old] of m) {
        if (a !== "style" && a !== "class" && a.indexOf("data-") !== 0) continue;
        if (t.getAttribute(a) !== old) trace.push(t.localName + "@" + a);
      }
    for (const e of madeTouched) {
      if (e.hasAttribute("style")) trace.push("new " + e.localName + "@style");
      for (const a of Array.from(e.attributes)) if (/^data-bench/.test(a.name)) trace.push("new " + e.localName + "@" + a.name);
      if (e.classList && Array.from(e.classList).some((c) => /^bench-/.test(c))) trace.push("new " + e.localName + "@class");
    }
    return { trace, attrs: Array.from(attrs) };
  }

  function markEl(el, id) {
    if (!el || el.nodeType !== 1) return;
    const cur = (R.labels.get(el) || "").split(" ").filter(Boolean);
    if (cur.indexOf(id) < 0) cur.push(id);
    R.labels.set(el, cur.join(" "));
    addTo(R.byRecipe, id, el);
    if (R.marked.indexOf(el) < 0) R.marked.push(el);
  }
  function unmark(id) {
    for (const el of R.byRecipe.get(id) || []) {
      const rest = (R.labels.get(el) || "").split(" ").filter((x) => x && x !== id);
      if (rest.length) R.labels.set(el, rest.join(" "));
      else {
        R.labels.delete(el);
        const k = R.marked.indexOf(el);
        if (k >= 0) R.marked.splice(k, 1);
      }
    }
    R.byRecipe.delete(id);
  }
  function disabledSig() {
    return Array.from(document.styleSheets).map((s) => (s.disabled ? 1 : 0)).join("");
  }

  root.__visionInject = function (list, seed) {
    const own = root.__visionOwnSheet || (root.__visionOwnSheet = new CSSStyleSheet());
    const adopted = document.adoptedStyleSheets ? document.adoptedStyleSheets.filter((s) => s !== own) : [];
    R = {
      labels: new WeakMap(),
      created: new WeakSet(),
      before: new WeakSet(document.getElementsByTagName("*")),
      marked: [],
      texts: [],
      elRules: new Map(),
      byRecipe: new Map(),
      byClass: new Map(),
      records: [],
      cssom: [],
      disabled: Array.from(document.styleSheets).map((s) => [s, s.disabled]),
      adopted,
      own,
    };
    root.__visionLabels = R.labels;
    root.__visionCreated = R.created;
    try {
      own.replaceSync("");
      document.adoptedStyleSheets = adopted.concat([own]);
    } catch (e) {
      const err = "error: no constructed stylesheet (" + String((e && e.message) || e).slice(0, 60) + ")";
      R = null;
      return list.map((item) => ({ id: item.id, kind: item.kind, catalog_id: item.catalog_id, applied: false, reason: err, marked: 0 }));
    }
    const results = injectAll(list, seed);
    try {
      rebuild(false);
    } catch (e) {}
    root.__visionMarked = R.marked.filter((el) => R.labels.has(el)).map((el) => ({ el, lab: R.labels.get(el) }));
    return results;
  };
  root.__visionUndo = function () {
    if (!R) return { ok: false, n: 0 };
    let bad = 0;
    for (let k = R.records.length - 1; k >= 0; k--) {
      const r = R.records[k];
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
    for (let k = R.cssom.length - 1; k >= 0; k--) {
      const c = R.cssom[k];
      try {
        c.owner.insertRule(c.text, Math.min(c.index, c.owner.cssRules.length));
      } catch (e) {
        bad++;
      }
    }
    for (const [s, d] of R.disabled) {
      try {
        if (s.disabled !== d) s.disabled = d;
      } catch (e) {
        bad++;
      }
    }
    try {
      R.own.replaceSync("");
      document.adoptedStyleSheets = R.adopted;
    } catch (e) {
      bad++;
    }
    const n = R.records.length;
    const cssom = R.cssom.length;
    R = null;
    root.__visionLabels = new WeakMap();
    root.__visionCreated = new WeakSet();
    return { ok: bad === 0, n, cssom, bad };
  };
  /** Viewport boxes of the elements the last injection marked (labels taken at injection time). */
  root.__visionMarkedBoxes = function () {
    return (root.__visionMarked || []).map((m) => {
      const el = m.el;
      const r = el.isConnected ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      return { lab: m.lab || "", page: el === document.documentElement ? 1 : 0, x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    });
  };
  /** What injection left in the page after an undo: the injected sheet still adopted, a round still open. */
  root.__visionResidue = function () {
    const own = root.__visionOwnSheet;
    const adopted = own && document.adoptedStyleSheets ? document.adoptedStyleSheets.indexOf(own) >= 0 : false;
    return { sheet: adopted ? 1 : 0, rules: own ? own.cssRules.length : 0, open: R ? 1 : 0 };
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
      const markOne = (el) => markEl(el, id);
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
          // into the injected sheet; markers stay literal until the scrubber resolves them after this recipe
          R.texts.push(String(text));
          rebuild(true);
        },
        deleteRules(pred) {
          const walk = (list, owner) => {
            for (let i = list.length - 1; i >= 0; i--) {
              const r = list[i];
              let hit = false;
              try {
                hit = !!pred(r);
              } catch (e) {}
              if (hit) {
                const text = r.cssText;
                owner.deleteRule(i);
                R.cssom.push({ owner, index: i, text });
              } else if (r.cssRules && !(r instanceof CSSStyleRule) && !(typeof CSSKeyframesRule !== "undefined" && r instanceof CSSKeyframesRule)) walk(r.cssRules, r);
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
          // v2: no class, attribute or inline style on the root. The round runs under the emulated
          // prefers-color-scheme: dark (the crawl sets it); the recipe applies only to a page that is dark on its own.
          const probe = document.elementFromPoint(innerWidth / 2, Math.min(innerHeight - 1, innerHeight * 0.6)) || document.body;
          const bg = h.resolvedBackground(probe);
          const c = lib.parseColor(bg);
          if (!c || lib.luminance(c) > 0.18) throw new NotApplicable("page is not dark under prefers-color-scheme: dark");
        },
        rewriteDarkRulesToMedia() {
          const moved = [];
          const walk = (list, owner) => {
            for (let i = list.length - 1; i >= 0; i--) {
              const r = list[i];
              if (r instanceof CSSStyleRule && /\.dark\b/.test(r.selectorText)) {
                const selText = r.selectorText.replace(/:is\(\.dark \*\)|\.dark\s*/g, "").trim() || ":root";
                moved.push("@media (prefers-color-scheme: dark){" + selText + "{" + r.style.cssText + "}}");
                const text = r.cssText;
                owner.deleteRule(i);
                R.cssom.push({ owner, index: i, text });
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
      const n0 = { texts: R.texts.length, cssom: R.cssom.length, dis: disabledSig() };
      const mo = new MutationObserver(() => {});
      mo.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
      try {
        item.fn(h);
        res.applied = true;
      } catch (e) {
        res.reason = e instanceof NotApplicable ? "n/a: " + e.message : "error: " + String((e && e.message) || e).slice(0, 120);
      }
      // drained before any page script can run; the scrubber's own restores are not journaled
      const recs = mo.takeRecords();
      mo.disconnect();
      for (const r of recs) R.records.push(r);
      let sc = { trace: [], attrs: [] };
      try {
        sc = scrub(recs);
      } catch (e) {
        sc.trace.push("scrub-error: " + String((e && e.message) || e).slice(0, 60));
      }
      if (sc.attrs.length) res.attrs = sc.attrs;
      res.marked = Array.from(R.byRecipe.get(id) || []).filter((el) => el.isConnected).length;
      if (res.applied && res.marked === 0 && item.label && item.label.attribute !== "page") {
        res.applied = false;
        res.reason = "n/a: nothing marked";
      }
      if (!res.applied) {
        // a recipe that threw (often NotApplicable after an early css() call) or marked nothing: take back what can
        // be taken back, its css() texts and journaled rule deletions; DOM changes stay and make the view partial
        R.texts.length = n0.texts;
        for (let k = R.cssom.length - 1; k >= n0.cssom; k--) {
          const c = R.cssom[k];
          try {
            c.owner.insertRule(c.text, Math.min(c.index, c.owner.cssRules.length));
          } catch (e) {}
        }
        R.cssom.length = n0.cssom;
      }
      try {
        rebuild(false);
      } catch (e) {
        sc.trace.push("sheet-error: " + String((e && e.message) || e).slice(0, 60));
      }
      const changed = recs.length > 0 || R.texts.length !== n0.texts || R.cssom.length !== n0.cssom || disabledSig() !== n0.dis || (res.applied && !!item.opaque);
      if (res.applied && !changed) {
        res.applied = false;
        res.reason = "n/a: nothing changed";
      }
      if (sc.trace.length) {
        // the scrubber could not make it traceless: the view is dropped from training
        res.trace = sc.trace.slice(0, 6);
        res.partial = true;
      }
      if (!res.applied && changed) res.partial = true; // it changed the page and then threw or marked nothing
      if (!res.applied || res.partial) {
        unmark(id);
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
 * the page never needs eval (a page CSP without unsafe-eval cannot block it). `opaque` marks recipes whose effect is
 * not a DOM or CSSOM change (a lost WebGL context), so "nothing changed" does not discard them.
 */
export function injectionScript(recipes, seed) {
  const items = recipes.map((r) => {
    const params = "{ sel, id, seed, pick, pickMany, tallest, mark, markAll, markPage, css, deleteRules, setText, textNodes, resolvedBackground, enableAppDarkMode, rewriteDarkRulesToMedia, photoUrl, lightPhotoUrl }";
    // photoUrl and lightPhotoUrl are getters; destructuring reads them only when the operation names them
    const needsPhoto = /\bphotoUrl\b|\blightPhotoUrl\b/.test(r.operation);
    const p = needsPhoto ? params : params.replace(", photoUrl, lightPhotoUrl", "");
    const opaque = /loseContext/.test(r.operation);
    return `{ id: ${JSON.stringify(r.id)}, kind: ${JSON.stringify(r.kind)}, catalog_id: ${JSON.stringify(r.catalog_id)}, select: ${JSON.stringify(r.select || "")}, label: ${JSON.stringify(r.label)}, opaque: ${opaque}, fn: function (${p}) { ${r.operation}\n } }`;
  });
  return `globalThis.__visionInject([${items.join(",\n")}], ${seed >>> 0})`;
}
