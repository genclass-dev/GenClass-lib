// Sinks by name for the zero-code entries (README "See it where you already look"; OPTIONS-SPEC §4.11). Owner: INSTALL.
//
//   <meta name="genclass" content="sink=sentry+posthog">              (+ joins names: commas separate meta keys)
//   <script src=".../genclass.global.min.js" data-sink="sentry,posthog"></script>
//   window.GENCLASS_CONFIG = { sinks: ["sentry", "webhook:/genclass"] }
//   npx @genclass/runtime init --sink sentry
//
// Names: sentry, posthog, datadog, console-json, webhook:<url>. A name becomes a small proxy sink at init time; the
// adapter module (dist/sinks/<name>.js, loaded through the entry's loader: a lazy chunk for /auto, the CDN for the
// script tag) is fetched at idle and the records queued meanwhile are handed over, so the first-load bundle does not
// carry the adapters. A webhook URL also joins requests.ignore, so the sink's fetch fallback is never observed.

import type { InitOptions, Sink, SinkObject, SinkRecord } from "../types.js";

export const SINK_NAMES = ["sentry", "posthog", "datadog", "console-json", "webhook"] as const;
export type SinkName = (typeof SINK_NAMES)[number];

export interface SinkSpec {
  name: SinkName;
  /** webhook: the URL. */
  arg?: string;
}

/** A module of @genclass/runtime/sinks/<name>: its default export makes the sink (each takes its own options type). */
export interface SinkModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (options?: any) => SinkObject;
}
export type SinkLoader = (name: SinkName) => Promise<SinkModule>;

/** Records a proxy keeps while its adapter loads. */
const MAX_QUEUED = 200;

/** "sentry" | "console-json" | "webhook:/genclass" | "webhook=https://…" → spec; null for anything else. */
export function parseSinkSpec(s: unknown): SinkSpec | null {
  if (typeof s !== "string") return null;
  const m = /^\s*([A-Za-z][\w-]*)\s*(?:[:=]\s*(.*?))?\s*$/.exec(s);
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/[_\s]/g, "-").replace(/^consolejson$/, "console-json");
  if (!(SINK_NAMES as readonly string[]).includes(name)) return null;
  const arg = m[2]?.trim();
  if (name === "webhook" && !arg) return null;
  return arg ? { name: name as SinkName, arg } : { name: name as SinkName };
}

/** "sentry,posthog" / "sentry+posthog" / "sentry posthog" → the names (a webhook URL may hold none of those separators). */
export function parseSinkList(v: string): string[] {
  return String(v ?? "")
    .split(/[,+|\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function stripEvidence(r: SinkRecord): SinkRecord {
  if (!r.evidence) return r;
  const { evidence: _e, ...rest } = r;
  return rest;
}

/**
 * The proxy for a named sink: queues records until the adapter module has loaded, then forwards (honouring the
 * adapter's `kinds` and `evidence`); one warning when the module cannot load. Loading starts at idle, else on the
 * first record.
 */
export function lazySink(spec: SinkSpec, load: SinkLoader, warn: (message: string) => void, g: Record<string, unknown> = globalThis as never): SinkObject {
  let target: SinkObject | null = null;
  let failed = false;
  let queue: SinkRecord[] = [];
  let loading: Promise<void> | null = null;
  const options: Record<string, unknown> = spec.name === "webhook" ? { url: spec.arg } : {};

  const forward = (r: SinkRecord): void => {
    const t = target;
    if (!t) return;
    try {
      if (t.kinds && !t.kinds.includes(r.kind)) return;
      const p = t.send(t.evidence ? r : stripEvidence(r));
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => undefined);
    } catch {
      /* the adapter's own guard failed: never into the app */
    }
  };

  const ensure = (): Promise<void> => {
    if (!loading) {
      // the loader is called now, not in a microtask: a bundler's lazy chunk starts fetching at once (and a throwing
      // loader is a failed load, never an exception in the caller)
      let p: Promise<SinkModule>;
      try {
        p = Promise.resolve(load(spec.name));
      } catch (e) {
        p = Promise.reject(e);
      }
      loading = p
        .then((m) => {
          target = m.default(options);
          const q = queue;
          queue = [];
          for (const r of q) forward(r);
        })
        .catch((e: unknown) => {
          // the module did not load, or its factory threw: one warning, nothing queued any longer
          failed = true;
          target = null;
          queue = [];
          warn(`sink "${spec.name}" could not load (${(e as Error)?.message ?? e}); its records are dropped.`);
        });
    }
    return loading;
  };

  try {
    const ric = g.requestIdleCallback as ((fn: () => void, o?: { timeout: number }) => unknown) | undefined;
    if (typeof ric === "function") ric.call(g, () => void ensure(), { timeout: 10_000 });
  } catch {
    /* loads on the first record instead */
  }

  return {
    evidence: true,
    send(r: SinkRecord): void {
      if (failed) return;
      if (target) {
        forward(r);
        return;
      }
      if (queue.length < MAX_QUEUED) queue.push(r);
      void ensure();
    },
    async flush(): Promise<void> {
      if (failed) return;
      if (!target && (queue.length || loading)) await ensure();
      await target?.flush?.();
    },
  };
}

/**
 * Page-config `sinks` → InitOptions: strings become lazy adapters (unknown names: one warning, dropped), functions
 * and objects pass through, and each webhook URL joins `requests.ignore`. Returns `init` unchanged when the list is
 * empty or missing.
 */
export function applySinks(init: InitOptions, list: unknown, load: SinkLoader, warn: (message: string) => void, g: Record<string, unknown> = globalThis as never): InitOptions {
  if (!Array.isArray(list) || !list.length) return init;
  const sinks: Sink[] = [];
  const ignore: string[] = [];
  for (const s of list) {
    if (typeof s === "function" || (s && typeof s === "object")) {
      sinks.push(s as Sink);
      continue;
    }
    const spec = parseSinkSpec(s);
    if (!spec) {
      warn(`unknown sink "${String(s)}" (sinks by name: ${SINK_NAMES.join(", ")}, webhook:<url>); ignored.`);
      continue;
    }
    if (spec.name === "webhook" && spec.arg) ignore.push(spec.arg);
    sinks.push(lazySink(spec, load, warn, g));
  }
  const out: InitOptions = { ...init, sinks };
  if (ignore.length) out.requests = { ...(init.requests ?? {}), ignore: [...(init.requests?.ignore ?? []), ...ignore] };
  return out;
}
