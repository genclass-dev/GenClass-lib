// The zero-code start shared by @genclass/runtime/auto and /auto/{observe,guard,heal}. Owner: INSTALL.

import { registerDiscovery } from "../discover/index.js";
import { GenClass } from "../index.js";
import type { InitOptions, Runtime } from "../types.js";
import { devtoolsOptions, isKilled, mergeConfig, readMetaConfig, readWindowConfig, splitConfig, whenBody } from "./config.js";
import { applySinks, type SinkLoader, type SinkModule } from "./sinks.js";

/** What the zero-code entries add to GenClass.init()'s defaults. */
export const AUTO_DEFAULTS: InitOptions = { autoState: true };

/** The sink adapters as lazy chunks of this entry (one static path each, so every bundler splits them out). */
const SINK_CHUNKS: Record<string, () => Promise<SinkModule>> = {
  sentry: () => import("../sinks/sentry.js"),
  posthog: () => import("../sinks/posthog.js"),
  datadog: () => import("../sinks/datadog.js"),
  "console-json": () => import("../sinks/console-json.js"),
  webhook: () => import("../sinks/webhook.js"),
};

/** Loads a sink adapter by name (cdn/sinks.ts). */
export const loadSink: SinkLoader = (name) => {
  const f = SINK_CHUNKS[name];
  return f ? f() : Promise.reject(new Error(`unknown sink ${name}`));
};

/**
 * GenClass.init() with `defaults`, overridden by <meta name="genclass"> and window.GENCLASS_CONFIG; mounts the
 * devtools overlay when the page config asks for it. Outside a browser: GenClass.init()'s inert runtime.
 */
export function startAuto(defaults: InitOptions = {}): Runtime {
  // automatic state discovery (autoState): registered before GenClass.init runs
  registerDiscovery();
  const g = globalThis as unknown as { window?: unknown; document?: unknown; location?: Location; localStorage?: Storage; console?: Console };
  if (typeof g.window !== "object" || typeof g.document !== "object" || !g.document) return GenClass.init(defaults);
  const doc = g.document as Document;
  // automatic state discovery is on by default here (installed now, before the framework's modules run)
  const { init, devtools, sinks } = splitConfig(mergeConfig(AUTO_DEFAULTS, defaults, readMetaConfig(doc, { location: g.location, warn: (m) => g.console?.warn?.(m) }), readWindowConfig(g.window)));
  // sinks by name (meta tag, window.GENCLASS_CONFIG) become lazy adapters; a webhook URL joins requests.ignore
  const rt = GenClass.init(applySinks(init, sinks, loadSink, (m) => g.console?.warn?.(`[GenClass] ${m}`), globalThis as unknown as Record<string, unknown>));
  const dt = devtoolsOptions(devtools, g.location);
  if (dt && !isKilled(g)) {
    whenBody(doc, () => {
      import("../devtools/index.js").then(
        (m) => m.mountDevtools(rt, dt),
        (e: unknown) => g.console?.warn?.("[GenClass] Could not load the devtools overlay:", e),
      );
    });
  }
  return rt;
}
