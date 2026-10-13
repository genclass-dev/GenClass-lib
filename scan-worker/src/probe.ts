// Page-side helpers for the race probe and the GenClass runtime bootstrap. Like checks.ts, the functions here are
// serialised with toString() and run in the scanned page: self-contained, DOM through `any`.

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Finds what the probe will touch: the first visible search-like input, and the most prominent submit button of a
 * same-origin form whose submit would POST (method=post, or a form with neither method nor action, which scripts
 * usually handle). Forms with a password or card field are skipped, and so are forms and buttons that would submit
 * into another window or tab (a target or formtarget other than _self, a <base target>), buttons inside a link, and
 * buttons whose formaction points at another origin: a new window is a new browser target that the request checks
 * do not cover. The chosen form gets the attribute data-genclass-scan-form and, with `prepare`, novalidate, so the
 * browser's own validation does not stop the submit (the request is answered locally either way; the report says
 * the form was submitted empty). Returns viewport coordinates after scrolling each target into view only when asked
 * (`scrollTo`: "search" | "button").
 */
export function probeTargets(options?: any): any {
  const o = options || {};
  const g: any = globalThis as any;
  const doc: any = g.document;
  const vis = (el: any) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const cs = g.getComputedStyle(el);
    if (cs.visibility !== "visible" || cs.display === "none" || cs.pointerEvents === "none") return null;
    let op = 1;
    for (let cur = el, i = 0; cur && cur.nodeType === 1 && i < 40; cur = cur.parentElement, i++) op *= parseFloat(g.getComputedStyle(cur).opacity || "1");
    return op > 0.1 ? r : null;
  };
  const short = (el: any) => {
    const tag = String(el.tagName).toLowerCase();
    if (el.id && /^[A-Za-z][\w-]{0,40}$/.test(el.id)) return tag + "#" + el.id;
    const name = el.getAttribute("name");
    if (name && /^[\w-]{1,30}$/.test(name)) return tag + "[name=" + name + "]";
    const cls = String(el.getAttribute("class") || "").split(/\s+/).filter((c: string) => /^[A-Za-z][\w-]{0,30}$/.test(c)).slice(0, 2);
    const type = el.getAttribute("type");
    return tag + (type ? "[type=" + type + "]" : "") + (cls.length ? "." + cls.join(".") : "");
  };
  const label = (el: any) => String(el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const SEARCHY = /search|query|^q$|find|lookup|filter|keyword/i;

  let search: any = null;
  const inputs = doc.querySelectorAll("input, [role=searchbox], [role=combobox]");
  for (let k = 0; k < inputs.length && !search; k++) {
    const el = inputs[k];
    if (el.disabled || el.readOnly) continue;
    const type = String(el.getAttribute("type") || "text").toLowerCase();
    if (el.tagName === "INPUT" && type !== "search" && type !== "text") continue;
    const hay = [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("role"), el.getAttribute("class"), el.getAttribute("type")].join(" ");
    if (type !== "search" && !SEARCHY.test(hay) && !/searchbox|combobox/.test(String(el.getAttribute("role")))) continue;
    if (!vis(el)) continue;
    search = el;
  }

  const selfTarget = (t: any) => {
    const v = String(t || "").trim().toLowerCase();
    return v === "" || v === "_self" || v === "_top" || v === "_parent";
  };
  const baseEl = doc.querySelector("base[target]");
  const baseTarget = baseEl ? baseEl.getAttribute("target") : "";
  const sameOrigin = (u: any) => {
    try {
      return new URL(u || g.location.href, g.location.href).origin === g.location.origin;
    } catch (e) {
      return false;
    }
  };

  let button: any = null;
  let buttonForm: any = null;
  let best = 0;
  let tier = 3;
  for (const form of Array.prototype.slice.call(doc.forms, 0, 50)) {
    const method = String(form.getAttribute("method") || "").toLowerCase();
    const action = form.getAttribute("action");
    let t = 3;
    if (method === "post") t = 1;
    else if (!method && !action) t = 2;
    if (t > 2) continue;
    if (!sameOrigin(form.action)) continue; // never a third party
    if (!selfTarget(form.getAttribute("target") || baseTarget)) continue; // never into another window
    if (form.querySelector("input[type=password], input[autocomplete^=cc-], input[name*=card i], input[name*=cvc i]")) continue;
    const btns = Array.prototype.slice.call(form.elements || []).filter((b: any) => {
      const tag = String(b.tagName);
      const type = String(b.getAttribute("type") || (tag === "BUTTON" ? "submit" : "")).toLowerCase();
      if (!((tag === "BUTTON" || tag === "INPUT") && (type === "submit" || type === "image") && !b.disabled)) return false;
      if (b.hasAttribute("formtarget") && !selfTarget(b.getAttribute("formtarget"))) return false;
      if (b.hasAttribute("formaction") && !sameOrigin(b.formAction)) return false;
      return !(b.closest && b.closest("a[href]"));
    });
    for (const b of btns) {
      const r = vis(b);
      if (!r) continue;
      const area = r.width * r.height;
      if (t < tier || (t === tier && area > best)) {
        tier = t;
        best = area;
        button = b;
        buttonForm = form;
      }
    }
  }

  if (buttonForm && o.prepare) {
    buttonForm.setAttribute("data-genclass-scan-form", "1");
    buttonForm.noValidate = true;
  }
  const at = (el: any) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  };
  if (o.scrollTo === "search" && search) search.scrollIntoView({ block: "center", inline: "nearest" });
  if (o.scrollTo === "button" && button) button.scrollIntoView({ block: "center", inline: "nearest" });
  return {
    search: search ? { selector: short(search), at: at(search) } : null,
    button: button
      ? { selector: short(button), label: label(button), at: at(button), method: String(buttonForm.getAttribute("method") || "(script)").toLowerCase(), form: short(buttonForm) }
      : null,
  };
}

/**
 * The GenClass runtime bootstrap, run before any page script (evaluateOnNewDocument), top frame only. What the runtime
 * reports is kept in this closure, not on window, and read back through window[stateName]() (non-writable, defined
 * before the page's own scripts run) with the JSON.stringify of that moment: the page can neither rewrite what GenClass
 * saw nor fake a GenClass action.
 */
export function runtimeBootstrap(config: Record<string, unknown>, runtimeSource: string, stateName = "__gcScanState"): string {
  const src = runtimeSource.replace(/\/\/# sourceMappingURL=\S+\s*$/gm, "");
  return `(function(){
  try { if (window.top !== window) return; } catch (e) { return; }
  var J = JSON.stringify, S = { detections: [], acts: [], error: null, started: Date.now() }, rt = null;
  window.GENCLASS_CONFIG = ${JSON.stringify(config)};
  try {
${src}
  } catch (e) { S.error = String((e && e.message) || e); }
  var cut = function (v, n) { v = String(v == null ? "" : v); return v.length > n ? v.slice(0, n) : v; };
  var num = function (v) { return typeof v === "number" && isFinite(v) ? v : null; };
  try {
    rt = window.GenClass && window.GenClass.runtime;
    if (!rt) { S.error = S.error || "GenClass did not start"; }
    else {
      rt.on("detect", function (d) {
        if (S.detections.length >= 50) return;
        S.detections.push({ id: cut(d.id, 40), trigger: cut(d.trigger, 40), subject: cut(d.subject, 140), diagnosis: cut(d.diagnosis, 40), p: num(d.diagnosisConfidence), action: cut(d.action, 40), ran: cut(d.ran, 40), executed: !!d.executed, latencyMs: num(d.latencyMs),
          reason: d.reason ? cut(d.reason, 160) : null, gateKind: d.gateKind ? cut(d.gateKind, 40) : null, gain: num(d.gain), margin: num(d.margin), mass: num(d.mass), threshold: num(d.threshold), candidate: d.candidate ? cut(d.candidate, 40) : null });
      });
      rt.on("act", function (a) {
        if (S.acts.length >= 50) return;
        S.acts.push({ id: cut(a.id, 40), decisionId: cut(a.decisionId, 40), action: cut(a.action, 40), trigger: cut(a.trigger, 40), subject: cut(a.subject, 140), ok: !!a.ok, changed: cut(a.changed, 220), late: !!a.late });
      });
    }
  } catch (e) { S.error = S.error || String((e && e.message) || e); }
  try {
    Object.defineProperty(window, ${JSON.stringify(stateName)}, { writable: false, configurable: false, enumerable: false, value: function () {
      var st = null, hold = null, decisions = 0;
      try { var s = rt && rt.status; if (s) st = { state: cut(s.state, 40), phase: s.phase ? cut(s.phase, 40) : null, device: s.device ? cut(s.device, 20) : null, variant: s.variant ? cut(s.variant, 20) : null, loadMs: num(s.loadMs), error: s.error ? cut(s.error, 200) : null, version: s.version ? cut(s.version, 40) : null, effectiveMode: s.effectiveMode ? cut(s.effectiveMode, 20) : null }; } catch (e) {}
      try { hold = rt ? num(rt.holdBudgetMs()) : null; } catch (e) {}
      try { decisions = rt ? rt.decisions().length : 0; } catch (e) {}
      return J({ present: !!rt, error: S.error, mode: rt ? cut(rt.mode, 20) : null, status: st, holdBudgetMs: hold, decisions: decisions, detections: S.detections, acts: S.acts, visibility: document.visibilityState });
    } });
  } catch (e) {}
})();`;
}

/** Page-side: the runtime's model status and what it recorded, as JSON, from the bootstrap's closure. */
export function runtimeStateSource(stateName = "__gcScanState"): string {
  const k = JSON.stringify(stateName);
  return `(() => typeof window[${k}] === "function" ? window[${k}]() : '{"present":false,"error":"bootstrap did not run","detections":[],"acts":[]}')()`;
}
