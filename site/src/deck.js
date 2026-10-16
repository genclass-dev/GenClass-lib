// genclass.dev/pitch-deck: the reading-time beacon (POST /pitch-deck/beacon) and the data behind /admin/deck.
// A beacon carries the milliseconds each slide was on screen (page visible and window focused) since the previous
// beacon of the same page load, with a sequence number. One D1 batch (a transaction) applies it and records
// (view id, sequence), and every statement in it is guarded by that record, so a repeated beacon changes nothing.
// Stored: random ids, slide times, the order of slide visits, device class, country and referrer host. Never an IP
// address, a user agent or a cookie. Views are created only by the viewer's script after the deck was on screen, so a
// link preview that does not run JavaScript creates none; known crawler and headless user agents are dropped too.

/** Slides in the deck at /pitch-deck (site/public/pitch-deck.html). Beacons naming any other slide are refused. */
export const SLIDES = 9;
/** A beacon body is about 200 bytes; anything over this is refused. */
export const BEACON_MAX_BYTES = 2048;
/** The viewer sends at least every 10 s while it counts, so one beacon carries at most this much time (sanity cap). */
export const BEACON_MAX_MS = 15000;
/** A view's total never grows past the wall time since its first beacon plus this (forged or replayed sequences). */
export const WALL_SLACK_MS = 30000;
/** Slide visits kept per beacon (the order of visits; holding an arrow key can produce many). */
export const PATH_MAX = 50;
/** Views listed on /admin/deck for one filter, newest first. */
export const ADMIN_VIEWS = 500;
/** Views the aggregates cover (all links), newest first. */
export const AGG_VIEWS = 5000;

const ID = /^[A-Za-z0-9_-]{16,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const DECK = /^[A-Za-z0-9_.-]{1,24}$/;
const COUNTRY = /^[A-Z0-9]{2}$/;
/** Crawlers, link unfurlers and headless browsers that run JavaScript. Real in-app browsers (LinkedInApp, Twitter for
 *  iPhone, Telegram's) do not match: only "...bot" names, renderers and automation do. */
export const BOT_UA = /bot\b|bot\/|crawler|spider|slurp|headless|lighthouse|pagespeed|inspectiontool|pagerenderer|prerender|phantomjs|puppeteer|playwright|selenium|webdriver|preview|facebookexternalhit|embedly|iframely|python-|curl\/|wget\//i;

/** The tables (site/migrations-admin/0003_deck.sql and 0004_deck_owners.sql have the same statements; a test keeps them
 *  equal). deck_links: named share links (genclass.dev/pitch-deck?k=<token>). deck_owners: browser ids the founders marked
 *  as theirs on /admin/deck; their views are stored with deck_views.owner = 1 and left out unless asked for. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS deck_links (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS deck_views (vid TEXT PRIMARY KEY, viewer TEXT, link_id INTEGER, deck TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, started_ms INTEGER NOT NULL, last_at TEXT NOT NULL, total_ms INTEGER NOT NULL DEFAULT 0, max_slide INTEGER NOT NULL DEFAULT 0, fullscreen INTEGER NOT NULL DEFAULT 0, download INTEGER NOT NULL DEFAULT 0, device TEXT, country TEXT, referrer TEXT, owner INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS deck_views_started ON deck_views (started_ms)`,
  `CREATE INDEX IF NOT EXISTS deck_views_link ON deck_views (link_id, started_ms)`,
  `CREATE INDEX IF NOT EXISTS deck_views_viewer ON deck_views (viewer)`,
  `CREATE TABLE IF NOT EXISTS deck_slide_time (vid TEXT NOT NULL, slide INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (vid, slide)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS deck_beacons (vid TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '', PRIMARY KEY (vid, seq)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS deck_owners (viewer TEXT PRIMARY KEY, at TEXT NOT NULL) WITHOUT ROWID`,
];

// Once per database object per isolate: a deploy works before the migration is applied, and applying it later is a
// no-op (every statement is IF NOT EXISTS).
const ready = new WeakMap();
export function ensureSchema(db) {
  let p = ready.get(db);
  if (!p) {
    p = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { ready.delete(db); throw e; });
    ready.set(db, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------- the beacon
/** "phone", "tablet" or "desktop" from a user agent (read, never stored). iPadOS sends a Mac user agent, so the
 *  viewer's touch hint (more than one touch point) turns a Mac into a tablet. */
export function deviceClass(ua, touch = false) {
  const s = String(ua || "");
  if (/iPad|Tablet|PlayBook|Silk|Kindle|SM-T\d|Android(?!.*Mobile)/i.test(s)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(s)) return "phone";
  if (touch && /Macintosh/.test(s)) return "tablet";
  return "desktop";
}

const bad = (error) => ({ ok: false, error });
const sumOf = (m) => { let n = 0; for (const v of m.values()) n += v; return n; };
/** Scales per-slide times down so they add up to at most `cap` (whole milliseconds, never up). */
export function capTotal(ms, cap) {
  const total = sumOf(ms);
  if (total <= cap) return ms;
  const f = Math.max(0, cap) / total;
  const out = new Map();
  for (const [s, v] of ms) { const w = Math.floor(v * f); if (w > 0) out.set(s, w); }
  return out;
}

/**
 * Validates a beacon body. Shape (all keys short; the viewer is site/public/pitch-deck/viewer.js):
 *   { v: 1, vid, seq, t: { "<slide>": ms }, p: [slides entered, in order], m: max slide reached, fs: 0|1, dl: 0|1,
 *     d: deck id, b?: viewer id, k?: share-link token, r?: referrer host, tp?: 1 (touch), o?: 1 (founder's browser) }
 * Structural errors refuse the beacon; times are capped (each slide and the beacon at BEACON_MAX_MS).
 */
export function parseBeacon(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return bad("body");
  if (o.v !== 1) return bad("v");
  if (typeof o.vid !== "string" || !ID.test(o.vid)) return bad("vid");
  if (!Number.isInteger(o.seq) || o.seq < 1 || o.seq > 1e6) return bad("seq");
  const t = o.t === undefined ? {} : o.t;
  if (!t || typeof t !== "object" || Array.isArray(t)) return bad("t");
  const keys = Object.keys(t);
  if (keys.length > SLIDES) return bad("t");
  let ms = new Map();
  for (const key of keys) {
    const s = Number(key), v = t[key];
    if (!/^[1-9][0-9]?$/.test(key) || s > SLIDES) return bad("slide");
    if (!Number.isInteger(v) || v < 0) return bad("ms");
    if (v > 0) ms.set(s, Math.min(v, BEACON_MAX_MS));
  }
  ms = capTotal(ms, BEACON_MAX_MS);
  const p = o.p === undefined ? [] : o.p;
  if (!Array.isArray(p)) return bad("p");
  const path = [];
  for (const s of p.slice(0, PATH_MAX)) {
    if (!Number.isInteger(s) || s < 1 || s > SLIDES) return bad("p");
    path.push(s);
  }
  if (o.m !== undefined && (!Number.isInteger(o.m) || o.m < 0 || o.m > SLIDES)) return bad("m");
  const max = Math.max(o.m || 0, ...path, ...ms.keys(), 0);
  const ref = typeof o.r === "string" ? o.r.toLowerCase().replace(/\.$/, "") : "";
  return {
    ok: true,
    beacon: {
      vid: o.vid, seq: o.seq, ms, path, max,
      fs: o.fs === 1 ? 1 : 0, dl: o.dl === 1 ? 1 : 0, touch: o.tp === 1, owner: o.o === 1 ? 1 : 0,
      viewer: typeof o.b === "string" && ID.test(o.b) ? o.b : null,
      token: typeof o.k === "string" && TOKEN.test(o.k) ? o.k : null,
      referrer: HOST.test(ref) ? ref : null,
      deck: typeof o.d === "string" && DECK.test(o.d) ? o.d : "",
    },
  };
}

/** Applies one parsed beacon (idempotent per vid and seq). `now` is the server's wall clock in ms. */
export async function applyBeacon(db, b, { now, device = null, country = null }) {
  await ensureSchema(db);
  const iso = new Date(now).toISOString();
  let ms = b.ms;
  const view = await db.prepare("SELECT started_ms, total_ms FROM deck_views WHERE vid = ?1").bind(b.vid).first();
  if (view) ms = capTotal(ms, now - Number(view.started_ms) + WALL_SLACK_MS - Number(view.total_ms));
  const total = sumOf(ms);
  const visits = new Map();
  for (const s of b.path) visits.set(s, (visits.get(s) || 0) + 1);
  const touched = [...new Set([...ms.keys(), ...visits.keys()])].sort((x, y) => x - y);
  const fresh = "NOT EXISTS (SELECT 1 FROM deck_beacons WHERE vid = ?1 AND seq = ?2)";
  const exists = "EXISTS (SELECT 1 FROM deck_views WHERE vid = ?1)";
  const stmts = [
    // a view starts with the first beacon that carries time (a page that was never on screen creates nothing); its link
    // is the token's link unless that link is disabled (then "direct link"); a founder's browser is flagged, not dropped
    db.prepare(`INSERT INTO deck_views (vid, viewer, link_id, deck, started_at, started_ms, last_at, total_ms, max_slide, fullscreen, download, device, country, referrer, owner)
      SELECT ?1, ?3, (SELECT id FROM deck_links WHERE token = ?4 AND disabled = 0), ?5, ?6, ?8, ?6, ?7, ?9, ?10, ?11, ?12, ?13, ?14,
        CASE WHEN ?15 = 1 OR EXISTS (SELECT 1 FROM deck_owners WHERE viewer = ?3) THEN 1 ELSE 0 END
      WHERE ${fresh} AND (?7 > 0 OR ${exists})
      ON CONFLICT (vid) DO UPDATE SET last_at = excluded.last_at, total_ms = deck_views.total_ms + excluded.total_ms,
        max_slide = MAX(deck_views.max_slide, excluded.max_slide), fullscreen = MAX(deck_views.fullscreen, excluded.fullscreen),
        download = MAX(deck_views.download, excluded.download), owner = MAX(deck_views.owner, excluded.owner)`)
      .bind(b.vid, b.seq, b.viewer, b.token, b.deck, iso, total, now, b.max, b.fs, b.dl, device, country, b.referrer, b.owner),
  ];
  for (const s of touched) {
    stmts.push(db.prepare(`INSERT INTO deck_slide_time (vid, slide, ms, visits) SELECT ?1, ?3, ?4, ?5 WHERE ${fresh} AND ${exists}
      ON CONFLICT (vid, slide) DO UPDATE SET ms = deck_slide_time.ms + excluded.ms, visits = deck_slide_time.visits + excluded.visits`)
      .bind(b.vid, b.seq, s, ms.get(s) || 0, visits.get(s) || 0));
  }
  stmts.push(db.prepare(`INSERT INTO deck_beacons (vid, seq, at, ms, path) SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${exists} ON CONFLICT (vid, seq) DO NOTHING`)
    .bind(b.vid, b.seq, iso, total, b.path.join(",")));
  await db.batch(stmts);
}

const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };

/** POST /pitch-deck/beacon. Always answers without a body; sendBeacon ignores the answer anyway. */
export async function deckBeacon(request, env, now = Date.now()) {
  const reply = (status, extra) => new Response(null, { status, headers: { ...NO_STORE, ...extra } });
  if (request.method !== "POST") return reply(405, { allow: "POST" });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return reply(403);
  const ua = request.headers.get("user-agent") || "";
  if (!ua || BOT_UA.test(ua)) return reply(204);
  if (Number(request.headers.get("content-length") || 0) > BEACON_MAX_BYTES) return reply(413);
  if (env.DECK_LIMIT) {
    const { success } = await env.DECK_LIMIT.limit({ key: "deck:" + (request.headers.get("cf-connecting-ip") || "?") });
    if (!success) return reply(429);
  }
  let text;
  try { text = await request.text(); } catch { return reply(400); }
  if (text.length > BEACON_MAX_BYTES) return reply(413);
  let body;
  try { body = JSON.parse(text); } catch { return reply(400); }
  const parsed = parseBeacon(body);
  if (!parsed.ok) return reply(400);
  if (!env.ADMIN_DB) return reply(503);
  const cc = request.cf && typeof request.cf.country === "string" && COUNTRY.test(request.cf.country) ? request.cf.country : null;
  try {
    await applyBeacon(env.ADMIN_DB, parsed.beacon, { now, device: deviceClass(ua, parsed.beacon.touch), country: cc });
  } catch (e) {
    console.error("deck beacon failed", e && e.message);
    return reply(500);
  }
  return reply(204);
}

// ---------------------------------------------------------------------------------------------- the owner's view
const ID22 = /^[A-Za-z0-9_-]{22}$/;
/** A share-link token: 16 random bytes, base64url (22 characters). It says nothing about the link's name. */
export function newToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const cleanName = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "");
export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Creates, renames, disables or enables a share link: { action: "create", name } | { action: "rename", id, name } |
 * { action: "disable" | "enable", id }. A disabled link's token no longer attributes new views (they count as the
 * direct link, the deck itself stays public); its past views keep its name.
 */
export async function deckLinkAction(db, body, now = Date.now()) {
  await ensureSchema(db);
  const action = body && body.action;
  const one = (id) => db.prepare("SELECT id, token, name, created_at, disabled FROM deck_links WHERE id = ?1").bind(id).first();
  if (action === "create") {
    const name = cleanName(body.name);
    if (!name) return { status: 400, body: { error: "Give the link a name." } };
    const token = newToken();
    await db.prepare("INSERT INTO deck_links (token, name, created_at) VALUES (?1, ?2, ?3)").bind(token, name, new Date(now).toISOString()).run();
    return { status: 201, body: { link: await db.prepare("SELECT id, token, name, created_at, disabled FROM deck_links WHERE token = ?1").bind(token).first() } };
  }
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id < 1 || !(await one(id))) return { status: 404, body: { error: "Unknown link." } };
  if (action === "rename") {
    const name = cleanName(body.name);
    if (!name) return { status: 400, body: { error: "Give the link a name." } };
    await db.prepare("UPDATE deck_links SET name = ?2 WHERE id = ?1").bind(id, name).run();
  } else if (action === "disable" || action === "enable") {
    await db.prepare("UPDATE deck_links SET disabled = ?2 WHERE id = ?1").bind(id, action === "disable" ? 1 : 0).run();
  } else {
    return { status: 400, body: { error: "Unknown action." } };
  }
  return { status: 200, body: { link: await one(id) } };
}

/**
 * Marks (on) or unmarks a browser id as the founders' own: its past and future views are flagged deck_views.owner = 1
 * and left out of every table and aggregate unless the page asks for them. Nothing is deleted.
 */
export async function deckOwnerAction(db, body, now = Date.now()) {
  await ensureSchema(db);
  const viewer = body && body.viewer;
  if (typeof viewer !== "string" || !ID22.test(viewer)) return { status: 400, body: { error: "No browser id." } };
  if (body.on) {
    await db.batch([
      db.prepare("INSERT INTO deck_owners (viewer, at) VALUES (?1, ?2) ON CONFLICT (viewer) DO NOTHING").bind(viewer, new Date(now).toISOString()),
      db.prepare("UPDATE deck_views SET owner = 1 WHERE viewer = ?1").bind(viewer),
    ]);
  } else {
    await db.batch([
      db.prepare("DELETE FROM deck_owners WHERE viewer = ?1").bind(viewer),
      db.prepare("UPDATE deck_views SET owner = 0 WHERE viewer = ?1").bind(viewer),
    ]);
  }
  return { status: 200, body: { viewer, ours: !!body.on } };
}

/** Views, unique browsers, time and per-slide reach, median/mean time and drop-off for a set of views. */
export function aggregate(views, slides = SLIDES) {
  const per = Array.from({ length: slides }, (_, i) => ({ slide: i + 1, reached: 0, left: 0, times: [] }));
  const totals = [];
  let last = null;
  for (const v of views) {
    totals.push(v.totalMs);
    v.ms.forEach((ms, i) => { if (v.seen[i]) { per[i].reached++; if (ms > 0) per[i].times.push(ms); } });
    if (v.last >= 1 && v.last <= slides) per[v.last - 1].left++;
    if (!last || v.lastAt > last) last = v.lastAt;
  }
  const n = views.length;
  return {
    views: n,
    browsers: new Set(views.map((v) => v.viewer || v.vid)).size,
    totalMs: totals.reduce((a, b) => a + b, 0),
    medianMs: median(totals),
    meanMs: mean(totals),
    completed: n ? per[slides - 1].reached : 0,
    lastView: last,
    perSlide: per.map((p) => ({
      slide: p.slide, reached: p.reached, reachedShare: n ? p.reached / n : 0, medianMs: median(p.times), meanMs: mean(p.times),
      left: p.left, dropOff: n ? p.left / n : 0,
    })),
  };
}

/**
 * Everything /admin/deck shows. link: "all" | "direct" | a link id (filters the views table and the per-slide
 * aggregates); own: include the founders' own views. Per-link summaries always cover every link.
 */
export async function deckStats(db, { link = "all", own = false } = {}) {
  await ensureSchema(db);
  const ownSql = own ? "" : "WHERE v.owner = 0";
  const scope = `SELECT v.vid FROM deck_views v ${ownSql} ORDER BY v.started_ms DESC LIMIT ${AGG_VIEWS}`;
  const q = (sql) => db.prepare(sql).all().then((r) => r.results || []);
  const [links, rows, times, lasts, owners] = await Promise.all([
    q("SELECT id, token, name, created_at, disabled FROM deck_links ORDER BY disabled, id DESC"),
    q(`SELECT v.vid, v.viewer, v.link_id, v.started_at, v.started_ms, v.last_at, v.total_ms, v.max_slide, v.fullscreen, v.download,
         v.device, v.country, v.referrer, v.owner FROM deck_views v ${ownSql} ORDER BY v.started_ms DESC LIMIT ${AGG_VIEWS}`),
    q(`SELECT vid, slide, ms, visits FROM deck_slide_time WHERE vid IN (${scope})`),
    // where each view ended: the last slide entered, from its newest beacon that entered one
    q(`SELECT b.vid, b.path FROM deck_beacons b JOIN (SELECT vid, MAX(seq) seq FROM deck_beacons WHERE path <> '' AND vid IN (${scope}) GROUP BY vid) m
         ON m.vid = b.vid AND m.seq = b.seq`),
    q("SELECT COUNT(*) n FROM deck_owners"),
  ]);
  const byVid = new Map();
  const views = rows.map((r) => {
    const v = { vid: r.vid, viewer: r.viewer, linkId: r.link_id, at: r.started_at, lastAt: r.last_at, totalMs: Number(r.total_ms) || 0,
      maxSlide: r.max_slide, fullscreen: !!r.fullscreen, download: !!r.download, device: r.device, country: r.country, referrer: r.referrer,
      owner: !!r.owner, ms: Array(SLIDES).fill(0), seen: Array(SLIDES).fill(false), last: r.max_slide };
    byVid.set(r.vid, v);
    return v;
  });
  for (const t of times) {
    const v = byVid.get(t.vid);
    if (!v || t.slide < 1 || t.slide > SLIDES) continue;
    v.ms[t.slide - 1] = Number(t.ms) || 0;
    v.seen[t.slide - 1] = Number(t.visits) > 0 || Number(t.ms) > 0;
  }
  for (const l of lasts) { const v = byVid.get(l.vid); const p = String(l.path).split(",").filter(Boolean); if (v && p.length) v.last = Number(p[p.length - 1]); }

  const linkName = new Map(links.map((l) => [l.id, l]));
  const keyOf = (v) => (v.linkId === null || v.linkId === undefined ? "direct" : String(v.linkId));
  const groups = new Map();
  for (const v of views) { const k = keyOf(v); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); }
  const selected = link === "all" ? views : groups.get(String(link)) || [];

  // the newest views of the selection, with their visit order and repeat visits by the same browser
  const shown = selected.slice(0, ADMIN_VIEWS);
  const paths = shown.length
    ? await db.prepare(`SELECT vid, path FROM deck_beacons WHERE vid IN (${shown.map((_, i) => "?" + (i + 1)).join(",")}) AND path <> '' ORDER BY vid, seq`)
      .bind(...shown.map((v) => v.vid)).all().then((r) => r.results || [])
    : [];
  const pathOf = new Map();
  for (const r of paths) pathOf.set(r.vid, (pathOf.get(r.vid) || []).concat(String(r.path).split(",").filter(Boolean).map(Number)));
  // repeat visits: the n-th view by the same browser (oldest first), out of all its views in scope
  const visitsOf = new Map(), nth = new Map();
  for (const v of [...views].reverse()) {
    if (!v.viewer) continue;
    const k = (visitsOf.get(v.viewer) || 0) + 1;
    visitsOf.set(v.viewer, k);
    nth.set(v.vid, k);
  }

  const summary = (k) => {
    const l = k === "direct" ? null : linkName.get(Number(k));
    return { key: k, id: l ? l.id : null, name: l ? l.name : "direct link", token: l ? l.token : null, createdAt: l ? l.created_at : null,
      disabled: l ? !!l.disabled : false, ...aggregate(groups.get(k) || []) };
  };
  return {
    generatedAt: new Date().toISOString(), slides: SLIDES, limit: ADMIN_VIEWS, aggLimit: AGG_VIEWS,
    filter: { link: String(link), own: !!own }, ourBrowsers: Number((owners[0] || {}).n) || 0,
    links: [...links.map((l) => summary(String(l.id))), summary("direct")],
    selection: aggregate(selected),
    views: shown.map((v) => {
      const l = v.linkId === null || v.linkId === undefined ? null : linkName.get(v.linkId);
      return {
        at: v.at, lastAt: v.lastAt, link: l ? l.name : v.linkId ? "(deleted link)" : null, linkDisabled: l ? !!l.disabled : false,
        browser: v.viewer ? v.viewer.slice(0, 6) : null, visit: v.viewer ? nth.get(v.vid) : 1, visits: v.viewer ? visitsOf.get(v.viewer) : 1,
        device: v.device, country: v.country, referrer: v.referrer, totalMs: v.totalMs, maxSlide: v.maxSlide, fullscreen: v.fullscreen,
        download: v.download, owner: v.owner, ms: v.ms, path: pathOf.get(v.vid) || [],
      };
    }),
  };
}

/** /admin/api/deck (GET), /admin/api/deck/links and /admin/api/deck/owner (POST, same-origin JSON). handleAdmin has
 *  already checked the session. */
export async function deckAdminApi(request, env, url, path) {
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" };
  const json = (body, status = 200) => Response.json(body, { status, headers });
  if (!env.ADMIN_DB) return json({ error: "ADMIN_DB is not bound" }, 503);
  if (path === "/admin/api/deck") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const link = url.searchParams.get("link") || "all";
    return json(await deckStats(env.ADMIN_DB, { link: /^(all|direct|[1-9]\d{0,8})$/.test(link) ? link : "all", own: url.searchParams.get("own") === "1" }));
  }
  if (path !== "/admin/api/deck/links" && path !== "/admin/api/deck/owner") return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  // same-origin JSON only: the session cookie is SameSite=Strict, and a cross-site form cannot send JSON
  if (request.headers.get("origin") !== url.origin || !(request.headers.get("content-type") || "").includes("application/json")) return json({ error: "forbidden" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const r = path === "/admin/api/deck/links" ? await deckLinkAction(env.ADMIN_DB, body) : await deckOwnerAction(env.ADMIN_DB, body);
  return json(r.body, r.status);
}
