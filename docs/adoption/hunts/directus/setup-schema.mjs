// Creates the hunt schema on a fresh Directus (sqlite): authors, tags, articles (M2O author, autocomplete topic).
const API = "http://127.0.0.1:8055";
const login = await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "hunt-admin-pw" }) })).json();
const token = login.data.access_token;
async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
const pk = { field: "id", type: "integer", meta: { hidden: true, interface: "input", readonly: true }, schema: { is_primary_key: true, has_auto_increment: true } };
await call("POST", "/collections", { collection: "authors", meta: { icon: "person", display_template: "{{name}}" }, schema: {}, fields: [pk, { field: "name", type: "string", meta: { interface: "input" }, schema: {} }] });
await call("POST", "/collections", { collection: "tags", meta: { icon: "label" }, schema: {}, fields: [pk, { field: "name", type: "string", meta: { interface: "input" }, schema: {} }] });
await call("POST", "/collections", {
  collection: "articles", meta: { icon: "article", display_template: "{{title}}" }, schema: {},
  fields: [
    pk,
    { field: "title", type: "string", meta: { interface: "input", width: "full", sort: 2 }, schema: {} },
    { field: "summary", type: "text", meta: { interface: "input-multiline", width: "full", sort: 3 }, schema: {} },
    { field: "status", type: "string", meta: { interface: "select-dropdown", width: "half", sort: 4, options: { choices: [{ text: "Draft", value: "draft" }, { text: "Review", value: "review" }, { text: "Published", value: "published" }] } }, schema: { default_value: "draft" } },
    { field: "topic", type: "string", meta: { interface: "input-autocomplete-api", width: "half", sort: 5, options: { url: "/items/tags?filter[name][_istarts_with]={{value}}&fields=name&limit=10", resultsPath: "data", textPath: "name", valuePath: "name" } }, schema: {} },
  ],
});
await call("POST", "/fields/articles", { field: "author", type: "integer", meta: { interface: "select-dropdown-m2o", special: ["m2o"], width: "full", sort: 6, options: { template: "{{name}}" }, display: "related-values", display_options: { template: "{{name}}" } }, schema: {} });
await call("POST", "/relations", { collection: "articles", field: "author", related_collection: "authors", schema: { on_delete: "SET NULL" } });
const authors = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Edsger Dijkstra", "Barbara Liskov"];
await call("POST", "/items/authors", authors.map((name) => ({ name })));
const tags = ["react", "reactive", "reactor", "realtime", "redis", "regex", "rest", "rust", "ruby", "routing", "vue", "vite", "vitest", "sqlite", "svelte", "solid", "security", "search", "schema", "sdk"];
await call("POST", "/items/tags", tags.map((name) => ({ name })));
const articles = [
  { title: "Alpha: launch checklist", summary: "Alpha body: the steps before a launch.", status: "draft", topic: "rest", author: 1 },
  { title: "Bravo: incident review", summary: "Bravo body: what failed on Tuesday.", status: "review", topic: "redis", author: 2 },
  { title: "Charlie: pricing page", summary: "Charlie body: the new tiers.", status: "published", topic: "vue", author: 3 },
  { title: "Delta: onboarding email", summary: "Delta body: the welcome sequence.", status: "draft", topic: "sdk", author: 4 },
  { title: "Echo: security notes", summary: "Echo body: the token rotation plan.", status: "review", topic: "security", author: 5 },
  { title: "Foxtrot: roadmap", summary: "Foxtrot body: the next two quarters.", status: "published", topic: "schema", author: 1 },
];
await call("POST", "/items/articles", articles);
console.log(JSON.stringify((await call("GET", "/items/articles?fields=id,title,author")).data));
