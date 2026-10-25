// Interaction analytics: the first-load stub (docs/runtime/ANALYTICS.md section 2). It answers runtime.analytics and,
// once the app turned analytics on (InitOptions.analytics or runtime.analytics.start()) while telemetry runs with the
// app's token or a custom endpoint, imports the chunk (src/analytics/index.ts) that records. Off means nothing: no
// listener, no import. Everything else lives in the chunk, so this file stays small (test/bundle.test.ts). A chunk that
// does not load warns, once per load (nothing is recorded); the chunk warns when its version is not the runtime's.

import type { RuntimeImpl } from "../runtime.js";
import type { AnalyticsStatus } from "../types.js";
import type { AnalyticsChunk, AnalyticsController } from "./index.js";
import { ignoredEvent } from "../observe/dom-user.js";
import { DATA_LIKE, type TelemetryClient } from "../telemetry/client.js";
import { DEFAULT_TELEMETRY_ENDPOINT } from "../telemetry/config.js";
import { RUNTIME_VERSION } from "../version.js";

/**
 * Where the chunk comes from. The ESM build imports ./index.js (an app's bundler splits it into its own chunk); the
 * script-tag build sets `loader` to fetch dist/analytics/index.js from the script's base URL (src/cdn/global.ts).
 */
export const analyticsRegistry: { loader?: () => Promise<AnalyticsChunk> } = {};

/** Called by createRuntime (src/index.ts) after telemetry started. `on`: InitOptions.analytics. */
export function startAnalytics(rt: RuntimeImpl, on: unknown): AnalyticsStatus {
  let c: AnalyticsController | null | undefined;
  // bumped by stop() and destroy: a chunk that finishes loading after them does not start
  let gen = 0;
  const warn = (m: string) => (rt.global.console as Console | undefined)?.warn?.("[GenClass] analytics" + m);
  const s = {
    enabled: false,
    reason: "option" as string | undefined,
    start(): boolean {
      const t = rt.telemetry;
      if (!s.enabled) {
        s.reason = !t?.enabled ? "telemetry-off" : t.token || t.endpoint != DEFAULT_TELEMETRY_ENDPOINT ? undefined : "no-token";
        if (!s.reason) {
          s.enabled = true;
          const n = ++gen;
          (analyticsRegistry.loader ?? (() => import("./index.js") as Promise<AnalyticsChunk>))().then(
            (m) => void (n == gen && (c = m.startAnalytics(rt, t as TelemetryClient, ignoredEvent, DATA_LIKE, RUNTIME_VERSION))),
            () => {
              s.enabled = false;
              s.reason = "error";
              warn(` ${RUNTIME_VERSION} did not load; nothing is recorded.`);
            },
          );
        }
      }
      return s.enabled;
    },
    stop(): void {
      gen++;
      c?.stop();
      c = null;
      if (s.enabled) {
        s.enabled = false;
        s.reason = "stopped";
      }
    },
  };
  rt.addTeardown(() => gen++);
  if (on === true && !s.start() && s.reason == "no-token")
    warn(": true needs the app's token; nothing is recorded.");
  return s;
}
