const BASE = process.env.PAYLOAD_URL ?? "http://localhost:3000";
const r = await fetch(BASE + "/api/users/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dev@payloadcms.com", password: "test1234" }) });
const { token } = await r.json();
const h = { "content-type": "application/json", authorization: `JWT ${token}` };
const have = await (await fetch(BASE + "/api/pages?limit=1", { headers: h })).json();
if (have.totalDocs < 3) for (let i = 0; i < 3; i++) {
  const p = await fetch(BASE + "/api/pages?draft=false", { method: "POST", headers: h, body: JSON.stringify({ title: `Page ${i}`, body: `Body ${i}`, _status: "published" }) });
  console.log("page", i, p.status);
}
console.log("pages", (await (await fetch(BASE + "/api/pages?limit=1", { headers: h })).json()).totalDocs);
