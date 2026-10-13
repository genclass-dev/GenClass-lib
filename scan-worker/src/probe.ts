// Page-side helpers for the race probe and the GenClass runtime bootstrap. Like checks.ts, the functions here are
// serialised with toString() and run in the scanned page: self-contained, DOM through `any`.

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Finds what the probe will touch: the first visible search-like input, and the most prominent submit button of a
 * same-origin form whose submit would POST (method=post, or a form with neither method nor action, which scripts
 * usually handle). Forms with a password or card field are skipped. The chosen form gets the attribute
 * data-genclass-scan-form and, with `prepare`, novalidate, so the browser's own validation does not stop the submit
 * (the request is answered locally either way). Returns viewport coordinates after scrolling each target into view
 * only when asked (`scrollTo`: "search" | "button").
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
    try {
      if (new URL(form.action || g.location.href, g.location.href).origin !== g.location.origin) continue; // never a third party
    } catch (e) {
      continue;
    }
    if (form.querySelector("input[type=password], input[autocomplete^=cc-], input[name*=card i], input[name*=cvc i]")) continue;
    const btns = Array.prototype.slice.call(form.elements || []).filter((b: any) => {
      const tag = String(b.tagName);
      const type = String(b.getAttribute("type") || (tag === "BUTTON" ? "submit" : "")).toLowerCase();
      return (tag === "BUTTON" || tag === "INPUT") && (type === "submit" || type === "image") && !b.disabled;
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

/** The GenClass runtime bootstrap, run before any page script (evaluateOnNewDocument), top frame only. */
export function runtimeBootstrap(config: Record<string, unknown>, runtimeSource: string): string {
  const src = runtimeSource.replace(/\/\/# sourceMappingURL=\S+\s*$/gm, "");
  return `(function(){
  try { if (window.top !== window) return; } catch (e) { return; }
  var S = window.__gcScan = { detections: [], acts: [], error: null, started: Date.now() };
  window.GENCLASS_CONFIG = ${JSON.stringify(config)};
  try {
${src}
  } catch (e) { S.error = String((e && e.message) || e); }
  try {
    var rt = window.GenClass && window.GenClass.runtime;
    if (!rt) { S.error = S.error || "GenClass did not start"; return; }
    var cut = function (v, n) { v = String(v == null ? "" : v); return v.length > n ? v.slice(0, n) : v; };
    rt.on("detect", function (d) {
      S.detections.push({ id: d.id, trigger: d.trigger, subject: cut(d.subject, 140), diagnosis: d.diagnosis, p: d.diagnosisConfidence, action: d.action, ran: d.ran, executed: !!d.executed, latencyMs: d.latencyMs,
        reason: d.reason ? cut(d.reason, 160) : null, gateKind: d.gateKind || null, gain: typeof d.gain === "number" ? d.gain : null, margin: typeof d.margin === "number" ? d.margin : null,
        mass: typeof d.mass === "number" ? d.mass : null, threshold: typeof d.threshold === "number" ? d.threshold : null, candidate: d.candidate || null });
    });
    rt.on("act", function (a) {
      S.acts.push({ id: a.id, decisionId: a.decisionId, action: a.action, trigger: a.trigger, subject: cut(a.subject, 140), ok: !!a.ok, changed: cut(a.changed, 220), late: !!a.late });
    });
  } catch (e) { S.error = S.error || String((e && e.message) || e); }
})();`;
}

/** Page-side: the runtime's model status and what it recorded, as JSON. */
export const RUNTIME_STATE_SOURCE = `(() => {
  const S = window.__gcScan || null;
  const rt = window.GenClass && window.GenClass.runtime;
  const st = rt && rt.status ? rt.status : null;
  let hold = null; try { hold = rt ? rt.holdBudgetMs() : null; } catch (e) {}
  let decisions = 0; try { decisions = rt ? rt.decisions().length : 0; } catch (e) {}
  return JSON.stringify({
    present: !!rt, error: S ? S.error : "bootstrap did not run", mode: rt ? rt.mode : null,
    status: st ? { state: st.state, phase: st.phase || null, device: st.device || null, variant: st.variant || null, loadMs: st.loadMs || null, error: st.error ? String(st.error).slice(0, 200) : null, version: st.version || null, effectiveMode: st.effectiveMode || null } : null,
    holdBudgetMs: hold, decisions,
    detections: S ? S.detections : [], acts: S ? S.acts : [],
    visibility: document.visibilityState,
  });
})()`;
