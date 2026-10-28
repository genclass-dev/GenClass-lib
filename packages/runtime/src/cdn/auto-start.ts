// The zero-code start shared by @genclass/runtime/auto and /auto/{observe,guard,heal}. Owner: INSTALL.

import { registerDiscovery } from "../discover/index.js";
import { GenClass } from "../index.js";
import type { InitOptions, Runtime } from "../types.js";
import { devtoolsOptions, isKilled, mergeConfig, readMetaConfig, readWindowConfig, splitConfig, whenBody } from "./config.js";
import { applySinks, type SinkResolver } from "./sinks.js";

/** What the zero-code entries add to GenClass.init()'s defaults. */
export const AUTO_DEFAULTS: InitOptions = { autoState: true };

/** Sink names → their adapters, through a lazy chunk of this entry (cdn/sinks-load.ts: never in the first load). */
export const resolveSinks: SinkResolver = (names, warn) => import("./sinks-load.js").then((m) => m.resolve(names, warn));

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
  const { init, devtools, sinks } = splitConfig(mergeConfig(AUTO_DEFAULTS, defaults, readMetaConfig(doc, { location: g.location, warn: (m) => g.console?.warn?.(m) }), readWindowConfig(g.window, (m) => g.console?.warn?.(m))));
  // sinks by name (meta tag, window.GENCLASS_CONFIG) become one lazy proxy; a webhook URL joins requests.ignore
  const rt = GenClass.init(applySinks(init, sinks, resolveSinks, (m) => g.console?.warn?.(`[GenClass] ${m}`), globalThis as unknown as Record<string, unknown>));
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
