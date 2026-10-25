import { defineConfig } from "tsup";

// One ESM file, as the Svelte CLI loads community add-ons: `sv` is a peer dependency the CLI provides at run time
// (external), and everything else, @sveltejs/sv-utils included, is bundled, so the add-on runs with the parsers it
// was tested with and installs nothing of its own.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  external: ["sv"],
  noExternal: ["@sveltejs/sv-utils"],
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  minify: false,
  treeshake: true,
});
