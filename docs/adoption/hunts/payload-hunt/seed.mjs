// Seeds the Payload app through its REST API: first user, 20 categories, 300 posts (the list-view scenarios need a
// few hundred documents so search and sort change the visible rows). Idempotent enough: skips what exists.
const BASE = process.env.PAYLOAD_URL ?? "http://localhost:3000";
const USER = { email: "dev@payloadcms.com", password: "test1234" };

async function j(path, init = {}, token) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `JWT ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

let r = await j("/api/users/first-register", { method: "POST", body: JSON.stringify(USER) });
console.log("first-register", r.status, typeof r.body === "object" ? (r.body.errors?.[0]?.message ?? "ok") : r.body.slice(0, 100));
r = await j("/api/users/login", { method: "POST", body: JSON.stringify(USER) });
if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
const token = r.body.token;
const userId = r.body.user.id;
console.log("login ok, user", userId);

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu", "react", "reactive", "reactor", "reaction"];

const cats = await j("/api/categories?limit=1", {}, token);
let catIds = [];
if (cats.body.totalDocs >= 20) {
  const all = await j("/api/categories?limit=100", {}, token);
  catIds = all.body.docs.map((d) => d.id);
  console.log("categories exist", catIds.length);
} else {
  for (let i = 0; i < 20; i++) {
    const c = await j("/api/categories", { method: "POST", body: JSON.stringify({ name: `Category ${WORDS[i]}` }) }, token);
    if (c.status !== 201) throw new Error(`category ${i}: ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
    catIds.push(c.body.doc.id);
  }
  console.log("categories created", catIds.length);
}

const posts = await j("/api/posts?limit=1", {}, token);
if (posts.body.totalDocs >= 300) {
  console.log("posts exist", posts.body.totalDocs);
} else {
  const start = posts.body.totalDocs;
  for (let i = start; i < 300; i++) {
    // deterministic titles: "react 017 charlie", "reactor 018 delta", ... so a typed prefix narrows the list step by step
    const w1 = WORDS[(i * 7) % WORDS.length];
    const w2 = WORDS[(i * 13 + 5) % WORDS.length];
    const p = await j(
      "/api/posts?draft=false",
      {
        method: "POST",
        body: JSON.stringify({
          title: `${w1} ${String(i).padStart(3, "0")} ${w2}`,
          summary: `Post number ${i} about ${w1} and ${w2}.`,
          category: catIds[i % catIds.length],
          author: userId,
          views: (i * 37) % 1000,
          _status: "published",
        }),
      },
      token,
    );
    if (p.status !== 201) throw new Error(`post ${i}: ${p.status} ${JSON.stringify(p.body).slice(0, 300)}`);
    if (i % 50 === 0) console.log("posts", i);
  }
  console.log("posts created");
}
const final = await j("/api/posts?limit=1", {}, token);
console.log("totalDocs", final.body.totalDocs);
