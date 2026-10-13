// Sinks by name for the zero-code entries (README "See it where you already look"; OPTIONS-SPEC §4.11).
// Owner: INSTALL.
//
//   <meta name="genclass" content="sink=sentry+posthog">              (+ joins names: commas separate meta keys)
//   <script src=".../genclass.global.min.js" data-sink="sentry,posthog"></script>
//   window.GENCLASS_CONFIG = { sinks: ["sentry", "webhook:/genclass"] }
//   npx @genclass/runtime init --sink sentry
//
// Names: sentry, posthog, datadog, console-json, webhook:<url>. This module is the part in the first load, and it is
// kept small on purpose: `applySinks` turns the names of a page configuration into ONE proxy sink (`namedSinks`) that
// queues records until the entry's resolver has loaded the adapters, at idle or on the first record, then hands the
// queue over. The name table, the parsing of a name and the adapters are behind the resolver (cdn/sinks-fanout.ts):
// a lazy chunk of /auto (cdn/sinks-load.ts), and for the script tag dist/sinks/<name>.js from the CDN.
// test/bundle.test.ts keeps them out of the first load of /auto and of the main entry.
//
// A webhook URL also joins requests.ignore here, at init, so the sink's fetch fallback is never observed.
// Never throws into the app: a resolver that throws or rejects is one console warning, and the queue is dropped.

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
 * The proxy for the named sinks: queues records (at most 200) until `resolve` has loaded the adapters, then forwards
 * them all and every later record. Loading starts at idle (requestIdleCallback), else on the first record; `flush()`
 * waits for it. A failed load is one warning; its records are dropped from then on.
 */
export function namedSinks(names: string[], resolve: SinkResolver, warn: (message: string) => void, g: Record<string, unknown> = globalThis as never): SinkObject {
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
  try {
    (g.requestIdleCallback as ((fn: () => void, o?: { timeout: number }) => unknown) | undefined)?.call(g, () => void load(), { timeout: 10_000 });
  } catch {
    /* loads on the first record instead */
  }
  return {
    evidence: true,
    send(r: SinkRecord): void {
      if (target) target.send(r);
      else {
        if (queue.length < MAX_QUEUED) queue.push(r);
        void load();
      }
    },
    flush: (): Promise<void> => (target || loading || queue.length ? load().then(() => target?.flush?.()) : Promise.resolve()),
  };
}

/**
 * Page-config `sinks` → InitOptions: the names become one `namedSinks` proxy, functions and objects pass through
 * (GenClass.init checks them), blanks are skipped, and each webhook URL joins `requests.ignore`. Returns `init`
 * unchanged when the list is empty or not a list. An unknown name warns once the resolver has loaded.
 */
export function applySinks(init: InitOptions, list: unknown, resolve: SinkResolver, warn: (message: string) => void, g: Record<string, unknown> = globalThis as never): InitOptions {
  if (!Array.isArray(list) || !list.length) return init;
  const sinks: Sink[] = [];
  const names: string[] = [];
  const ignore: string[] = [];
  for (const s of list) {
    if (typeof s === "string") {
      const v = s.trim();
      if (!v) continue;
      names.push(v);
      const u = webhookUrl(v);
      if (u) ignore.push(u);
    } else if (s) sinks.push(s as Sink);
  }
  if (names.length) sinks.push(namedSinks(names, resolve, warn, g));
  const out: InitOptions = { ...init, sinks };
  if (ignore.length) out.requests = { ...init.requests, ignore: [...(init.requests?.ignore ?? []), ...ignore] };
  return out;
}
