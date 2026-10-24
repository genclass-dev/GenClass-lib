import { defineConfig } from "tsup";

// Two ESM entries: the library (`@genclass/mcp`: the store, the bridge, the MCP server, the tools) and the command
// (`bin/genclass-mcp.mjs` imports dist/cli.js). No splitting: each entry is one file. Nothing is external because
// nothing is imported besides Node built-ins.
export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  treeshake: true,
});
