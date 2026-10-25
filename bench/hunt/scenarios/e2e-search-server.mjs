#!/usr/bin/env node
// The e2e search page as an app the harness does not own: the same search box and the same in-order 40 ms backend as
// packages/mcp/test/e2e (docs/runtime/AGENT.md section 7), but with no GenClass in the page at all. Its state lives in
// a closure, not in a store, so GenClass discovers nothing: the verdict rests on page text and request counts, as it
// would for any app whose state GenClass does not see. Two pages:
//
//   /             buggy: each response writes the results, so an older answer can land last
//   /fixed        fixed: only the answer to the latest query is kept
//   /form         a second planted bug for scenarios/double-click-submit.mjs: a Save button that sends one POST per
//                 click while the first is still in flight (the list is reset on every load of the page)
//   /form-fixed   fixed: the button is disabled while a save is in flight
//   /form-nav     the same buggy Save, then a full navigation to /done once the save answered (the shape of most
//                 server-rendered forms: a scenario's steps that end on another document)
//   /go           a redirect to / (exercises the harness's document rewrite across a redirect)
//
//   node bench/hunt/scenarios/e2e-search-server.mjs [--port 0] [--fixed]      prints the URL
//
// --fixed serves the fixed variants at / and /form too (the same paths), so a regression test generated from the
// buggy page can be run unchanged against the fix, as in the e2e.

import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 0;
const fixedAll = process.argv.includes("--fixed");
let items = [];
const FORM = (fixed, nav = false) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Items${fixed ? " (fixed)" : ""}</title></head>
<body>
<form id="f"><input id="title" aria-label="Title" autocomplete="off" value="Hunt"><button type="submit" id="save">Save</button></form>
<p id="status"></p><ul id="items"></ul>
<script>
(() => {
  const FIXED = ${fixed ? "true" : "false"};
  const NAV = ${nav ? "true" : "false"};
  const form = document.querySelector("#f");
  const button = document.querySelector("#save");
  const list = document.querySelector("#items");
  const status = document.querySelector("#status");
  let saving = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (FIXED) { if (saving) return; saving = true; button.disabled = true; }
    status.textContent = "Saving";
    const res = await fetch("/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: document.querySelector("#title").value }) });
    const data = await res.json();
    if (NAV) return location.assign("/done?items=" + data.items.length);
    list.replaceChildren(...data.items.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
    status.textContent = "Saved";
    if (FIXED) { saving = false; button.disabled = false; }
  });
})();
</script>
</body></html>`;
const PAGE = (fixed) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Search${fixed ? " (fixed)" : ""}</title></head>
<body>
<input id="q" aria-label="Search" autocomplete="off"><h2 id="for"></h2><ul id="results"></ul>
<script>
(() => {
  const FIXED = ${fixed ? "true" : "false"};
  const input = document.querySelector("#q");
  const list = document.querySelector("#results");
  const heading = document.querySelector("#for");
  let latest = 0;
  let results = [];
  const render = () => {
    list.replaceChildren(...results.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
    heading.textContent = results.length ? "Results for " + results[0].split(" ")[0] : "";
  };
  input.addEventListener("input", async () => {
    const q = input.value;
    const id = ++latest;
    const res = await fetch("/api/search?q=" + encodeURIComponent(q));
    const data = await res.json();
    if (FIXED && id !== latest) return; // the fix: ignore answers to older queries
    results = data.items;
    render();
  });
})();
</script>
</body></html>`;

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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE(fixedAll));
  }
  if (url.pathname === "/fixed") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE(true));
  }
  if (url.pathname === "/form" || url.pathname === "/form-fixed" || url.pathname === "/form-nav") {
    items = []; // one list per page load, so every run starts the same
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(FORM(fixedAll || url.pathname === "/form-fixed", url.pathname === "/form-nav"));
  }
  if (url.pathname === "/done") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Saved</title></head><body><p id="status">Saved: ${Number(url.searchParams.get("items")) || 0} item(s)</p></body></html>`);
  }
  if (url.pathname === "/api/items" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let title = "item";
      try {
        title = String(JSON.parse(body).title ?? "item");
      } catch {
        /* keep the default */
      }
      items.push(title);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items }));
      }, 120);
    });
    return;
  }
  if (url.pathname === "/go") {
    res.writeHead(302, { location: "/" });
    return res.end();
  }
  res.writeHead(404).end();
});
server.listen(port, "127.0.0.1", () => {
  const u = `http://127.0.0.1:${server.address().port}`;
  console.log(fixedAll ? `e2e pages, fixed variants everywhere: ${u}/ and ${u}/form` : `e2e search page: ${u}/ (buggy), ${u}/fixed (fixed); double submit: ${u}/form (buggy), ${u}/form-fixed (fixed)`);
});
