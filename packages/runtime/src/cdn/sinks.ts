// Sinks by name for the zero-code entries (README "See it where you already look"; OPTIONS-SPEC §4.11).
// Owner: INSTALL.
//
//   <meta name="genclass" content="sink=sentry+posthog">              (+ joins names: commas separate meta keys)
//   <script src=".../genclass.global.min.js" data-sink="sentry,posthog"></script>
//   window.GENCLASS_CONFIG = { sinks: ["sentry", "webhook:/genclass"] }
//   npx @genclass/runtime init --sink sentry
//
// Names: sentry, posthog, datadog, console-json (each optionally `:noevidence`), webhook:<url>. This module is the
// part in the first load, and it is kept small on purpose: `applySinks` turns the names of a page configuration into
// ONE proxy sink (`namedSinks`) that queues records until the entry's resolver has loaded the adapters, which starts
// on the first record (never before, so a page with `?genclass=off`, or a runtime that never reports, loads nothing),
// then hands the queue over. The name table, the parsing of a name and the adapters are behind the resolver
// (cdn/sinks-fanout.ts): a lazy chunk of /auto (cdn/sinks-load.ts), and for the script tag dist/sinks/<name>.js from
// the CDN. test/bundle.test.ts keeps them out of the first load of /auto and of the main entry.
//
// A webhook URL is resolved once, here at init, against document.baseURI (what sendBeacon and fetch would use), so a
// `<base>` injected later cannot move it; that endpoint (origin and path, any query) joins requests.ignore, so the
// sink's fetch fallback is never observed and no other endpoint of the app is (webhook:/collect never hides
// /collections). Never throws into the app: a resolver that throws or rejects is one console warning, and the queue
// is dropped.

import type { InitOptions, Sink, SinkObject, SinkRecord } from "../types.js";

/** The names of a page configuration → one sink that fans out to their adapters (cdn/sinks-fanout.ts). */
export type SinkResolver = (names: string[], warn: (message: string) => void) => Promise<SinkObject>;

/** Records the proxy keeps while the adapters load. */
const MAX_QUEUED = 200;

/** "sentry,posthog" / "sentry+posthog" / "sentry posthog" → the names (a webhook URL may hold none of those separators). */
export const parseSinkList = (v: string): string[] => String(v ?? "").split(/[,+|\s]+/).filter(Boolean);

/** "webhook:<url>" / "webhook=<url>" → the URL; undefined for anything else. */
export const webhookUrl = (s: string): string | undefined => /^\s*webhook\s*[:=]\s*(\S+)/i.exec(s)?.[1];

/**
 * The proxy for the named sinks: queues records (at most 200) until `resolve` has loaded the adapters, which starts on
 * the first record, then forwards them all and every later record; `flush()` waits for the load. A failed load is one
 * warning; its records are dropped from then on.
 */
export function namedSinks(names: string[], resolve: SinkResolver, warn: (message: string) => void): SinkObject {
  let target: SinkObject | undefined;
  let queue: SinkRecord[] = [];
  let loading: Promise<void> | undefined;
  const load = (): Promise<void> => {
    if (!loading) {
      // called now, not in a microtask: a bundler's lazy chunk starts fetching at once (a throw is a failed load)
      let p: Promise<SinkObject>;
      try {
        p = resolve(names, warn);
      } catch (e) {
        p = Promise.reject(e);
      }
      loading = Promise.resolve(p)
        .then((t) => {
          target = t;
          for (const r of queue.splice(0)) t.send(r);
        })
        .catch((e: unknown) => {
          target = { send() {} };
          queue = [];
          warn(`sinks ${names.join(", ")} could not load (${(e as Error)?.message ?? e}); their records are dropped.`);
        });
    }
    return loading;
  };
  return {
    evidence: true,
    send(r: SinkRecord): void {
      if (target) target.send(r);
      else {
        if (queue.length < MAX_QUEUED) queue.push(r);
        void load();
      }
    },
    flush: (): Promise<void> => (loading ? loading.then(() => target?.flush?.()) : Promise.resolve()),
  };
}

/**
 * Page-config `sinks` → InitOptions: the names become one `namedSinks` proxy, functions and objects pass through
 * (GenClass.init checks them), blanks are skipped. A webhook URL is made absolute against `g`'s document.baseURI (else
 * its location) and its endpoint joins `requests.ignore` as an exact match (origin and path). Returns `init` unchanged
 * when the list is empty or not a list. An unknown name warns once the resolver has loaded.
 *
 * Total: in /auto this runs while the app's entry module is being evaluated, before GenClass.init's own guard, so it
 * never throws. A `requests.ignore` that is not a list (one RegExp by mistake) stays as the page wrote it, for
 * GenClass.init to report as it would without sinks; any other failure is one warning and `init` back.
 */
export function applySinks(init: InitOptions, list: unknown, resolve: SinkResolver, warn: (message: string) => void, g: Record<string, unknown> = globalThis as never): InitOptions {
  try {
    if (!Array.isArray(list) || !list.length) return init;
    const sinks: Sink[] = [];
    const names: string[] = [];
    const ignore: NonNullable<NonNullable<InitOptions["requests"]>["ignore"]> = [];
    let base: string | undefined;
    try {
      base = (g.document as { baseURI?: string } | undefined)?.baseURI ?? (g.location as { href?: string } | undefined)?.href;
    } catch {
      /* no page: paths only */
    }
    // origin + path of a URL against the page (the path only without one); "" when it does not parse
    const endpoint = (u: string): string => {
      try {
        const x = new URL(u, base ?? "http://genclass.invalid/");
        return (base ? x.origin : "") + x.pathname;
      } catch {
        return "";
      }
    };
    for (const s of list) {
      if (typeof s === "string") {
        let v = s.trim();
        if (!v) continue;
        const u = webhookUrl(v);
        const key = u ? endpoint(u) : "";
        if (key) {
          if (base) v = `webhook:${new URL(u!, base).href}`;
          ignore.push((r: { url: string }) => endpoint(r.url) === key);
        }
        names.push(v);
      } else if (s) sinks.push(s as Sink);
    }
    if (names.length) sinks.push(namedSinks(names, resolve, warn));
    const out: InitOptions = { ...init, sinks };
    // an ignore that is not a list (one RegExp by mistake) stays as written: GenClass.init reports it, sinks or not
    const prev = init.requests?.ignore;
    if (ignore.length && Array.isArray(prev ?? [])) out.requests = { ...init.requests, ignore: [...(prev ?? []), ...ignore] };
    return out;
  } catch (e) {
    try {
      warn(`sinks could not load (${(e as Error)?.message ?? e}); their records are dropped.`);
    } catch {
      /* never into the app */
    }
    return init;
  }
}
