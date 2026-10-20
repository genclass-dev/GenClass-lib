// Navigation observer: history.pushState/replaceState, popstate and hashchange become `nav` events. A popstate or
// hashchange is also reported as a traversal (back/forward; read by request triage only, CONTRACT §6) when
// history.length has not grown since the last navigation seen here (an unknown length counts as unchanged) and the
// route differs from that one's: a fragment navigation fires popstate too (Chromium) but adds an entry, and a click on
// the current hash link changes neither. Not told apart: location.replace("#x"), and a fragment push once session
// history is at the browser's cap (Chrome: 50 entries); both count as traversals.

import { truncate } from "../util.js";

export function installNav(g: Record<string, unknown>, _rt: unknown, onNav: (route: string, traversal: boolean) => void): (() => void) | null {
  const hist = g.history as History | undefined;
  const loc = g.location as Location | undefined;
  const t = g as unknown as EventTarget;
  if (!hist || !loc || typeof t.addEventListener !== "function") return null;
  const route = () => truncate(`${loc.pathname ?? ""}${loc.search ?? ""}${loc.hash ?? ""}`, 80);
  const push = hist.pushState;
  const replace = hist.replaceState;
  let disabled = false;
  let len = hist.length;
  let last = route();
  // the listener for popstate and hashchange (`e` set), and the wrappers' report (no `e`: never a traversal)
  const onPop = (e?: Event) => {
    const r = route();
    const n = hist.length;
    const traversal = !!e && !(n > len) && r !== last;
    len = n;
    last = r;
    onNav(r, traversal);
  };
  const wrap = (orig: History["pushState"]) =>
    function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      if (disabled) return r;
      try {
        onPop();
      } catch {
        /* ignore */
      }
      return r;
    };
  const wp = typeof push === "function" ? wrap(push) : undefined;
  const wr = typeof replace === "function" ? wrap(replace) : undefined;
  try {
    if (wp) hist.pushState = wp;
    if (wr) hist.replaceState = wr;
  } catch {
    /* non-writable */
  }
  t.addEventListener("popstate", onPop);
  t.addEventListener("hashchange", onPop);
  return () => {
    disabled = true;
    try {
      if (wp && hist.pushState === wp) hist.pushState = push;
      if (wr && hist.replaceState === wr) hist.replaceState = replace;
    } catch {
      /* ignore */
    }
    t.removeEventListener("popstate", onPop);
    t.removeEventListener("hashchange", onPop);
  };
}
