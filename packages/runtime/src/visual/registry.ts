// Where the visual chunk comes from. The ESM build imports ./index.js (an app's bundler splits it into its own
// chunk); the script-tag build sets `loader` to fetch dist/visual/index.js from the script's base URL, as it does for
// the devtools overlay (src/cdn/global.ts).

import type { VisualChunk } from "./host.js";

export const visualRegistry: { loader?: () => Promise<VisualChunk> } = {};
