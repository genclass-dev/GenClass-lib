// The resolver /auto imports on demand when its page configuration names a sink (cdn/auto-start.ts → cdn/sinks.ts).
// Owner: INSTALL. This module, the name table it pulls in (cdn/sinks-fanout.ts) and the adapters are never in the
// first load (test/bundle.test.ts); each adapter is a lazy chunk of its own (one static path each, so every bundler
// splits it out), and only the named ones are fetched.

import type { SinkObject } from "../types.js";
import { fanout, type SinkLoader, type SinkModule } from "./sinks-fanout.js";

const CHUNKS: Record<string, () => Promise<SinkModule>> = {
  sentry: () => import("../sinks/sentry.js"),
  posthog: () => import("../sinks/posthog.js"),
  datadog: () => import("../sinks/datadog.js"),
  "console-json": () => import("../sinks/console-json.js"),
  webhook: () => import("../sinks/webhook.js"),
};

/** Loads a sink adapter module by name. */
export const loadSink: SinkLoader = (name) => {
  const f = CHUNKS[name];
  return f ? f() : Promise.reject(new Error(`unknown sink ${name}`));
};

/** The names → one sink over their adapters (cdn/sinks-fanout.ts fanout over the chunks above). */
export const resolve = (names: string[], warn: (message: string) => void): Promise<SinkObject> => fanout(names, loadSink, warn);
