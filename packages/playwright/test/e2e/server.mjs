// The app server of the fixture's end-to-end check (run.mjs): the buggy search page of the MCP server's e2e
// (packages/mcp/test/e2e/app/app.js), served the way race.e2e.mjs serves it, with two differences that this check
// needs and says so here:
//   - the import map resolves `@genclass/runtime` to the page's own GenClass, the script-tag build the fixture
//     injected (window.GenClass): the app's `GenClass.init(...)` then returns the fixture's runtime and its
//     `rt.atom("search", ...)` registers the store there, the way an app integrated through the script tag does. A
//     real ESM runtime next to the fixture's would be a second runtime whose registered stores the fixture does not
//     see (the fixture sees what automatic discovery finds: React, Redux and Zustand state).
//   - `@genclass/runtime/agent` resolves to a stub whose connectAgent does nothing: it is the link to the MCP bridge,
//     which this check does not run (the fixture connects the agent entry itself, with every hold off).
// The page's own logic (app.js) is untouched. `?fixed=1` serves the fixed variant (window.__FIXED__). The backend
// answers /api/search in 40 ms, in order: on its own the race never shows; the fixture's chaos is what reorders.
//
// Usage: node server.mjs [port]   (prints "listening <url>" on stdout; port 0 picks a free one)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appJs = resolve(here, "../../../mcp/test/e2e/app/app.js");
const port = Number(process.argv[2] ?? process.env.GENCLASS_E2E_PORT ?? 0);

const SHIM_RUNTIME = `// the page's GenClass: the script-tag build the fixture injected before this module ran
export const GenClass = {
  init: (o) => window.GenClass.init(o),
  get runtime() { return window.GenClass.runtime; },
};
`;
const SHIM_AGENT = `// the MCP bridge link is not part of this check (the fixture connects the agent entry itself)
export function connectAgent() { return null; }
`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [`${q} one`, `${q} two`] }));
    }, 40);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const fixed = url.searchParams.get("fixed") === "1";
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Search</title>
<script type="importmap">{"imports":{"@genclass/runtime":"/rt/index.js","@genclass/runtime/agent":"/rt/agent.js"}}</script>
${fixed ? "<script>window.__FIXED__ = true</script>" : ""}
<input id="q" aria-label="Search" autocomplete="off"><h2 id="for"></h2><ul id="results"></ul>
<script type="module" src="/app.js"></script>`);
    return;
  }
  const js = (body) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(body);
  };
  if (url.pathname === "/app.js") return js(readFileSync(appJs));
  if (url.pathname === "/rt/index.js") return js(SHIM_RUNTIME);
  if (url.pathname === "/rt/agent.js") return js(SHIM_AGENT);
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`listening http://127.0.0.1:${server.address().port}`);
});
