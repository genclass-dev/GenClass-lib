// The resolver behind the zero-code sink names (cdn/sinks.ts): the name table, the parsing of one name and the
// fan-out to the adapters (@genclass/runtime/sinks/<name>). Owner: INSTALL.
//
// Never in the first load of /auto (it is reached through cdn/sinks-load.ts, a lazy chunk); the script tag carries it
// and loads the adapters themselves from the CDN (dist/sinks/<name>.js). Every adapter is made with its own options
// (a webhook gets its URL) and gets the records it asks for: its `kinds`, and the evidence only with `evidence`.
// Never throws: an unknown name or an adapter that cannot load is one warning each, and the others still work.

import type { SinkObject, SinkRecord } from "../types.js";

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
/** Loads the adapter module of a name: a lazy chunk for /auto (cdn/sinks-load.ts), dist/sinks/<name>.js from the CDN for the script tag. */
export type SinkLoader = (name: SinkName) => Promise<SinkModule>;

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

function stripEvidence(r: SinkRecord): SinkRecord {
  if (!r.evidence) return r;
  const { evidence: _e, ...rest } = r;
  return rest;
}

/**
 * The adapters for `names` (duplicates once), loaded through `load`, as one sink: each record goes to every adapter
 * that takes its kind, without the evidence unless the adapter asks for it; `flush()` flushes them all. Resolves once
 * every adapter has loaded or failed (an unknown name or a failed load is one `warn` each; the rest still get records).
 */
export async function fanout(names: string[], load: SinkLoader, warn: (message: string) => void): Promise<SinkObject> {
  const seen = new Set<string>();
  const jobs: Promise<SinkObject | null>[] = [];
  for (const s of names) {
    const spec = parseSinkSpec(s);
    if (!spec) {
      warn(`unknown sink "${s}" (the names are sentry, posthog, datadog, console-json and webhook:<url>); ignored.`);
      continue;
    }
    const key = `${spec.name}:${spec.arg ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(
      (async () => {
        try {
          const m = await load(spec.name);
          const t = m.default(spec.name === "webhook" ? { url: spec.arg } : {});
          if (!t || typeof t.send !== "function") throw new Error("not a sink");
          return t;
        } catch (e) {
          warn(`sink "${s}" could not load (${(e as Error)?.message ?? e}); its records are dropped.`);
          return null;
        }
      })(),
    );
  }
  const targets = (await Promise.all(jobs)).filter((t): t is SinkObject => !!t);
  return {
    evidence: true,
    send(r: SinkRecord): void {
      for (const t of targets) {
        try {
          if (t.kinds && !t.kinds.includes(r.kind)) continue;
          const p = t.send(t.evidence ? r : stripEvidence(r));
          if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => undefined);
        } catch {
          /* the adapter's own guard failed: never into the app */
        }
      }
    },
    async flush(): Promise<void> {
      for (const t of targets) {
        try {
          await t.flush?.();
        } catch {
          /* never into the app */
        }
      }
    },
  };
}
