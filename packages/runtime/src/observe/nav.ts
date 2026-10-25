// Navigation observer: history.pushState/replaceState, popstate and hashchange become `nav` events. A popstate or
// hashchange to another route than the last navigation seen here is also reported as a traversal (back/forward; read
// by request triage only, CONTRACT §6). Where the Navigation API exists (`navigation.currentEntry.key`, read only: no
// listener of its own), a traversal lands on an entry seen at an earlier navigation, other than the last one; a new
// entry (a fragment navigation, a pushState, even when it pruned forward entries) has a fresh key, and
// location.replace("#x") keeps the key. Keys are kept for the last MAX_KEYS entries seen. Without it, the fallback:
// history.length has not grown since the last navigation (an unknown length counts as unchanged). A fragment
// navigation fires popstate too (Chromium) but adds an entry, and a click on the current hash link changes neither.
// Misread by the fallback (they count as traversals): location.replace("#x"), a fragment push once session history
// is at the browser's cap (Chrome: 50 entries), and any new entry made while forward entries exist (typically right
// after a back: a fragment navigation, or a pushState whose earlier patch dispatches popstate inside the call).

import { truncate } from "../util.js";

/** Navigation API entry keys remembered (Chrome keeps at most 50 session history entries). */
const MAX_KEYS = 64;

export function installNav(g: Record<string, unknown>, _rt: unknown, onNav: (route: string, traversal: boolean) => void): (() => void) | null {
  const hist = g.history as History | undefined;
  const loc = g.location as Location | undefined;
  const t = g as unknown as EventTarget;
  if (!hist || !loc || typeof t.addEventListener !== "function") return null;
  const route = () => truncate(`${loc.pathname ?? ""}${loc.search ?? ""}${loc.hash ?? ""}`, 80);
  /** The current entry's key (Navigation API), or undefined where it is missing or throws. */
  const key = (): string | undefined => {
    try {
      const k = (g.navigation as { currentEntry?: { key?: unknown } | null } | undefined)?.currentEntry?.key;
      return typeof k === "string" ? k : undefined;
    } catch {
      return undefined;
    }
  };
  /** Entry keys seen at a navigation, least recently seen first. */
  const keys = new Set<string>();
  const see = (k: string | undefined) => {
    if (k === undefined) return;
    keys.delete(k);
    keys.add(k);
    if (keys.size > MAX_KEYS) keys.delete(keys.values().next().value as string);
  };
  const push = hist.pushState;
  const replace = hist.replaceState;
  let disabled = false;
  let len = hist.length;
  let last = route();
  let lastKey = key();
  see(lastKey);
  // the listener for popstate and hashchange (`e` set), and the wrappers' report (no `e`: never a traversal)
  const onPop = (e?: Event) => {
    const r = route();
    const n = hist.length;
    const k = key();
    const traversal = !!e && r !== last && (k !== undefined && lastKey !== undefined ? keys.has(k) && k !== lastKey : !(n > len));
    len = n;
    last = r;
    lastKey = k;
    see(k);
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
