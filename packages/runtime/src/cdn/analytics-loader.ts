// The script tag's loader for the interaction analytics chunk (src/cdn/global.ts; docs/runtime/ANALYTICS.md section
// 4.1). The tag loads dist/analytics/index.js by URL from its base, so a self-hosted dist/ can hold files of two
// releases, or none: the loader passes the tag's version to the chunk, which warns once when its own differs, and a
// chunk that does not load says so on the console (once per load; the runtime then reports reason "error"). In the
// script-tag build only: the ESM entries' first load does not carry it.

import type { AnalyticsChunk } from "../analytics/index.js";

/** Wraps `load` (the chunk's import by URL): the tag's `version` goes to the chunk; a failed import warns via `warn`. */
export function analyticsLoader(load: () => Promise<AnalyticsChunk>, version: string, url: string, warn: (m: string) => void): () => Promise<AnalyticsChunk> {
  return () =>
    load().then(
      (m) => ({ startAnalytics: (rt, t, ignored, data) => m.startAnalytics(rt, t, ignored, data, version) }),
      (e: unknown) => {
        warn(`[GenClass] analytics: ${url} (@genclass/runtime ${version}) did not load; nothing is recorded. Serve every file of this version's dist/.`);
        throw e;
      },
    );
}
