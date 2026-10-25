// Builds one production bundle per strategy page into .out/build/<id>.js (esbuild; Svelte through its compiler,
// Vue with the template compiler included, React in production mode). No GenClass code is bundled: the server adds
// the script tag to the page's <head> for the GenClass conditions, so the app code is the same in every condition.

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { compile } from "svelte/compiler";
import { STRATEGIES } from "./lib/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, ".out/build");
const require = createRequire(import.meta.url);

const sveltePlugin = {
  name: "svelte",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const { js, warnings } = compile(source, { filename: args.path, generate: "client", dev: false, css: "injected" });
      return { contents: js.code, loader: "js", warnings: warnings.map((w) => ({ text: w.message })) };
    });
  },
};

export async function build() {
  mkdirSync(OUT, { recursive: true });
  await esbuild.build({
    entryPoints: Object.fromEntries(STRATEGIES.map((s) => [s.id, join(HERE, "src", s.file)])),
    outdir: OUT,
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2022",
    jsx: "automatic",
    alias: { vue: require.resolve("vue/dist/vue.esm-bundler.js") },
    define: {
      "process.env.NODE_ENV": '"production"',
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
    plugins: [sveltePlugin],
    logLevel: "warning",
  });
  copyFileSync(join(HERE, "src/style.css"), join(OUT, "style.css"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build();
  console.log(`built ${STRATEGIES.length} pages into ${OUT}`);
}
