// Functions that run INSIDE the browser (page.addInitScript, page.evaluate, page.waitForFunction). Playwright
// serialises them with toString(), so each one is self-contained: no imports, no module-level helpers, no
// references to anything outside its own body. They never throw into the page: every failure is recorded and
// swallowed. `any` is deliberate here: the page's objects are untyped by construction.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RuntimeSnapshot } from "./types.js";

/** What the init script leaves on the page (window.__genclassPlaywright). */
export interface InjectState {
  url: string;
  ok: boolean;
  error: string;
}

/**
 * Init script (install "inject"): sets window.GENCLASS_CONFIG, then loads the script-tag build synchronously
 * (XMLHttpRequest, async false) and runs it with an indirect eval, so GenClass.init() has run before the page's
 * own scripts (the same point a first-in-<head> script tag gives). Top frame and http(s) documents only.
 */
export function initScript(cfg: { url: string; config: Record<string, unknown> }): void {
  const w = window as any;
  try {
    if (window !== window.top) return;
    if (!/^https?:$/.test(location.protocol)) return;
    w.GENCLASS_CONFIG = Object.assign({}, w.GENCLASS_CONFIG || {}, cfg.config);
    const st = (w.__genclassPlaywright = { url: cfg.url, ok: false, error: "" });
    const xhr = new XMLHttpRequest();
    xhr.open("GET", cfg.url, false);
    xhr.send(null);
    if (xhr.status !== 200) {
      st.error = "HTTP " + xhr.status + " for " + cfg.url;
      return;
    }
    const src = xhr.responseText;
    if (!src) {
      st.error = "empty response for " + cfg.url;
      return;
    }
    (0, eval)(src + "\n//# sourceURL=" + cfg.url);
    st.ok = !!(w.GenClass && w.GenClass.runtime);
    if (!st.ok) st.error = "the script ran but window.GenClass.runtime is not set";
  } catch (e: any) {
    try {
      w.__genclassPlaywright = Object.assign(w.__genclassPlaywright || { url: cfg.url, ok: false }, { ok: false, error: String((e && e.message) || e) });
    } catch {
      /* nothing to record on */
    }
  }
}

/** page.evaluate: the init script's record, or null when it did not run on this page. */
export function pageInjectState(): InjectState | null {
  try {
    const s = (window as any).__genclassPlaywright;
    return s && typeof s === "object" ? { url: String(s.url || ""), ok: !!s.ok, error: String(s.error || "") } : null;
  } catch {
    return null;
  }
}

/**
 * page.waitForFunction: the model's state once it is terminal (ready, error, skipped, off, disabled, unloaded),
 * else null (no runtime yet, or still loading).
 */
export function pageReadyState(handles: string[]): string | null {
  try {
    const w = window as any;
    let rt: any = null;
    for (const h of handles) {
      let o: any = w;
      for (const k of h.split(".")) {
        if (o == null) break;
        o = o[k];
      }
      if (o && typeof o.audit === "function") {
        rt = o;
        break;
      }
    }
    if (!rt) return null;
    const s = rt.status && rt.status.state;
    if (s === "ready" || s === "error" || s === "skipped" || s === "off" || s === "disabled" || s === "unloaded") return String(s);
    return null;
  } catch {
    return null;
  }
}

/** page.evaluate: how much the runtime has recorded so far (to tell when it is quiet), or null without a runtime. */
export function pageActivity(handles: string[]): { audit: number; inflight: number; decisions: number } | null {
  try {
    const w = window as any;
    let rt: any = null;
    for (const h of handles) {
      let o: any = w;
      for (const k of h.split(".")) {
        if (o == null) break;
        o = o[k];
      }
      if (o && typeof o.audit === "function") {
        rt = o;
        break;
      }
    }
    if (!rt) return null;
    let inflight = 0;
    try {
      inflight = rt.inflight().filter((o: any) => o && (o.kind === "fetch" || o.kind === "xhr")).length;
    } catch {
      inflight = 0;
    }
    let decisions = 0;
    try {
      decisions = rt.decisions().length;
    } catch {
      decisions = 0;
    }
    return { audit: rt.audit().length, inflight, decisions };
  } catch {
    return null;
  }
}

/** page.evaluate: everything the report needs from the runtime, as plain JSON, or null without a runtime. */
export function pageSnapshot(handles: string[]): RuntimeSnapshot | null {
  try {
    const w = window as any;
    let rt: any = null;
    let handle = "";
    for (const h of handles) {
      let o: any = w;
      for (const k of h.split(".")) {
        if (o == null) break;
        o = o[k];
      }
      if (o && typeof o.audit === "function" && typeof o.decisions === "function") {
        rt = o;
        handle = h;
        break;
      }
    }
    if (!rt) return null;
    const json = (x: unknown): any => {
      try {
        return JSON.parse(JSON.stringify(x));
      } catch {
        return null;
      }
    };
    const decisions: any[] = [];
    try {
      for (const d of rt.decisions()) {
        let message: string | undefined;
        let timeline: string[] | undefined;
        try {
          const e = rt.explain(d.id);
          if (e) {
            message = String(e.message || "");
            timeline = Array.isArray(e.timeline) ? e.timeline.slice(0, 30).map(String) : undefined;
          }
        } catch {
          /* explanation no longer kept */
        }
        decisions.push({
          id: String(d.id),
          trigger: String(d.trigger),
          subject: String(d.subject),
          at: Number(d.at) || 0,
          diagnosis: String(d.diagnosis),
          diagnosisConfidence: Number(d.diagnosisConfidence) || 0,
          action: String(d.action),
          confidence: Number(d.confidence) || 0,
          executed: !!d.executed,
          ran: String(d.ran),
          tier: String(d.tier),
          reason: d.reason === undefined ? undefined : String(d.reason),
          candidate: d.candidate === undefined ? undefined : String(d.candidate),
          effectiveMode: d.effectiveMode === undefined ? undefined : String(d.effectiveMode),
          latencyMs: Number(d.latencyMs) || 0,
          facts: Array.isArray(d.facts) ? d.facts.map(String) : [],
          message,
          timeline,
        });
      }
    } catch {
      /* decisions() failed: reported empty */
    }
    const interventions: any[] = [];
    try {
      for (const a of rt.interventions()) {
        interventions.push({
          id: String(a.id),
          decisionId: String(a.decisionId),
          action: String(a.action),
          tier: String(a.tier),
          trigger: String(a.trigger),
          subject: String(a.subject),
          at: Number(a.at) || 0,
          ok: !!a.ok,
          error: a.error === undefined ? undefined : String(a.error),
          changed: String(a.changed || ""),
          late: a.late === undefined ? undefined : !!a.late,
          dropped: Array.isArray(a.dropped) ? a.dropped.map(String) : undefined,
        });
      }
    } catch {
      /* interventions() failed: reported empty */
    }
    let gates: any = null;
    try {
      gates = json(rt.gates());
    } catch {
      gates = null;
    }
    let summary: any = null;
    try {
      summary = json(rt.summary());
    } catch {
      summary = null;
    }
    let audit: any[] = [];
    try {
      audit = json(rt.audit()) || [];
    } catch {
      audit = [];
    }
    let status: any = {};
    try {
      status = json(rt.status) || {};
    } catch {
      status = {};
    }
    return {
      handle,
      href: String(location.href),
      title: String(document.title || ""),
      mode: rt.mode,
      status,
      gates,
      summary,
      audit,
      decisions,
      interventions,
    };
  } catch {
    return null;
  }
}
