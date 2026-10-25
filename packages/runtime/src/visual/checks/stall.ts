// request-stalled (docs/runtime/VISUAL.md 3.24, issue 94): a fetch or XHR request still pending after
// visual.checks.stallMs (default 15 s), and whether a control the page disabled or marked busy around the time it
// started is still so (the button a handler disabled before a request that never answered). A measurement against a
// fixed threshold, like the other checks: it never raises a situation and never feeds the model. The engine
// (src/visual/engine.ts) keeps the times controls became busy and decides when to judge; this only judges.

import type { Draft } from "../draft.js";

/** A request in flight, as the bridge hands it over (src/visual/bridge.ts pending()). */
export interface PendingRequest {
  /** The runtime's op id: one finding per request. */
  id: string;
  /** "GET /api/items/:id" or "GET api.example.com/v1/forecast" (normalised path, no query). */
  sig: string;
  /** Clock time it started. */
  start: number;
}

export const STALL_MS = 15_000;
/** A handler often disables its button just before it sends: a control that became busy up to 1 s before counts. */
export const BUSY_LEAD_MS = 1000;
export const BUSY_ATTRS = ["disabled", "aria-busy", "aria-disabled"];
export const BUSY_SEL = '[disabled], [aria-busy="true"], [aria-disabled="true"]';

/** How the element is busy now, or null. */
export function busyState(el: Element): "disabled" | "aria-busy" | "aria-disabled" | null {
  return el.hasAttribute("disabled") ? "disabled" : el.getAttribute("aria-busy") === "true" ? "aria-busy" : el.getAttribute("aria-disabled") === "true" ? "aria-disabled" : null;
}

/** Method, host and path of a signature; a same-origin signature gets the page's host. */
export function parseSig(sig: string, pageHost: string): { method: string; host: string; path: string } {
  const sp = sig.indexOf(" ");
  const where = sig.slice(sp + 1);
  if (where.startsWith("/")) return { method: sig.slice(0, sp), host: pageHost, path: where };
  const i = where.indexOf("/");
  return { method: sig.slice(0, sp), host: i < 0 ? where : where.slice(0, i), path: i < 0 ? "/" : where.slice(i) };
}

export interface StallInput {
  req: PendingRequest;
  pageHost: string;
  now: number;
  stallMs: number;
  /** The control that became busy since the request started (or just before) and still is. */
  control: { el: Element; name: string; state: string; since: number } | null;
  /** The checks were watching controls when the request started (false: the chunk loaded later). */
  watched: boolean;
}

export function stallDraft(o: StallInput): Draft {
  const { method, host, path } = parseSig(o.req.sig, o.pageHost);
  const ms = o.now - o.req.start;
  const c = o.control;
  const s = (n: number) => `${(Math.round(n / 100) / 10).toFixed(1)} s`;
  const after = c ? (c.since >= o.req.start ? `${s(c.since - o.req.start)} after it started` : "just before it started") : "";
  return {
    kind: "request-stalled",
    el: c?.el ?? null,
    key: `request-stalled|${o.req.id}`,
    target: `${method} ${host}${path}`,
    severity: c ? "high" : "medium",
    measured: { method, host, path, pendingMs: Math.round(ms / 100) * 100, control: c ? c.state : o.watched ? "none" : "not watched" },
    threshold: { value: o.stallMs, unit: "ms pending", source: `visual.checks.stallMs (default ${STALL_MS})` },
    text: `${method} ${host}${path} has been pending for ${s(ms)} (threshold ${s(o.stallMs)})${
      c
        ? `, and ${c.name}, which became ${c.state} ${after}, still is: the page is waiting on a request that has not answered.`
        : `${o.watched ? "; no control the page disabled or marked busy since it started is still so" : ""}.`
    }`,
    fixText: "give the request a timeout (fetch(url, { signal: AbortSignal.timeout(10_000) }), or xhr.timeout) so the app's catch and finally run and the page recovers",
    details: [
      "Not checked: EventSource and WebSocket, a request on a background schedule the runtime learned (long polling), and an endpoint whose answers usually take longer than the threshold (learned 95th percentile).",
      `Ignore a host or path: GenClass.init({ visual: { ignore: [${JSON.stringify(host)}] } }).`,
    ],
  };
}
