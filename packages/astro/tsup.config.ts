import { defineConfig } from "tsup";

// One ESM entry: the integration (a default export that is a function, as `astro add` needs). `astro` is a type
// import only, so nothing is bundled.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  external: ["astro"],
});
