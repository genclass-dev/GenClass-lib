// Seeds a local Umami with 50 websites and 50 users through its own API, so the list pages have content to search.
// Idempotent: existing names are skipped. Usage: node docs/adoption/hunts/umami/seed.mjs
// Environment: UMAMI_URL (default http://localhost:3000), UMAMI_USER / UMAMI_PASSWORD (default admin / umami).

const APP = (process.env.UMAMI_URL ?? "http://localhost:3000").replace(/\/$/, "");
const login = await fetch(`${APP}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.UMAMI_USER ?? "admin", password: process.env.UMAMI_PASSWORD ?? "umami" }),
});
const { token, user } = await login.json();
if (!token) throw new Error(`login failed: ${login.status}`);
const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
const api = async (method, path, body) => {
  const r = await fetch(`${APP}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

// 5 x 5 x 2 = 50 names each, so a search narrows step by step ("shop" 10, "shop st" 6, "shop stu" 2).
const sites = [];
for (const a of ["shop", "blog", "docs", "news", "mail"])
  for (const b of ["store", "studio", "stats", "site", "space"])
    for (const n of [1, 2]) sites.push({ name: `${a} ${b} ${n}`, domain: `${a}-${b}-${n}.example.com` });
const users = [];
for (const a of ["anna", "andre", "ben", "bella", "carl"])
  for (const b of ["smith", "stone", "stark", "sato", "silva"])
    for (const n of [1, 2]) users.push(`${a}_${b}_${n}`);

const haveSites = new Set((await api("GET", `/users/${user.id}/websites?pageSize=200`)).data.map((w) => w.name));
let made = 0;
for (const s of sites) if (!haveSites.has(s.name)) (await api("POST", "/websites", s), made++);
const haveUsers = new Set((await api("GET", `/admin/users?pageSize=200`)).data.map((u) => u.username));
let madeU = 0;
for (const u of users) if (!haveUsers.has(u)) (await api("POST", "/users", { username: u, password: "hunt-password-1", role: "user" }), madeU++);
console.log(JSON.stringify({ websitesCreated: made, usersCreated: madeU, userId: user.id }));
