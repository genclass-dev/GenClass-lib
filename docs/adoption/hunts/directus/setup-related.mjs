// Adds articles.related: a self M2O with the "Navigate to item" link (enableLink), chained 1->2->3->4->5->6->1.
const API = "http://127.0.0.1:8055";
const login = await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "hunt-admin-pw" }) })).json();
const token = login.data.access_token;
async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
await call("POST", "/fields/articles", { field: "related", type: "integer", meta: { interface: "select-dropdown-m2o", special: ["m2o"], width: "full", sort: 7, note: "Next article in the series", options: { template: "{{title}}", enableLink: true } }, schema: {} });
await call("POST", "/relations", { collection: "articles", field: "related", related_collection: "articles", schema: { on_delete: "SET NULL" } });
for (let i = 1; i <= 6; i++) await call("PATCH", `/items/articles/${i}`, { related: (i % 6) + 1 });
await call("PATCH", "/fields/articles/author", { meta: { options: { template: "{{name}}", enableLink: true } } });
console.log(JSON.stringify((await call("GET", "/items/articles?fields=id,title,related")).data));
