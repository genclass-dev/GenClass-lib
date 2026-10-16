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
/** Views listed on /admin/deck, newest first. */
export const ADMIN_VIEWS = 500;

const ID = /^[A-Za-z0-9_-]{16,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const DECK = /^[A-Za-z0-9_.-]{1,24}$/;
const COUNTRY = /^[A-Z0-9]{2}$/;
/** Crawlers, link unfurlers and headless browsers that run JavaScript. Real in-app browsers (LinkedInApp, Twitter for
 *  iPhone, Telegram's) do not match: only "...bot" names, renderers and automation do. */
export const BOT_UA = /bot\b|bot\/|crawler|spider|slurp|headless|lighthouse|pagespeed|inspectiontool|pagerenderer|prerender|phantomjs|puppeteer|playwright|selenium|webdriver|preview|facebookexternalhit|embedly|iframely|python-|curl\/|wget\//i;

/** The tables (site/migrations-admin/0003_deck.sql has the same statements; a test keeps them equal). deck_links (named
 *  share links, ?k=<token>) and deck_views.owner (the founders' own browsers) are filled by a follow-up; until then
 *  every view is a direct-link view. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS deck_links (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS deck_views (vid TEXT PRIMARY KEY, viewer TEXT, link_id INTEGER, deck TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, started_ms INTEGER NOT NULL, last_at TEXT NOT NULL, total_ms INTEGER NOT NULL DEFAULT 0, max_slide INTEGER NOT NULL DEFAULT 0, fullscreen INTEGER NOT NULL DEFAULT 0, download INTEGER NOT NULL DEFAULT 0, device TEXT, country TEXT, referrer TEXT, owner INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS deck_views_started ON deck_views (started_ms)`,
  `CREATE INDEX IF NOT EXISTS deck_views_link ON deck_views (link_id, started_ms)`,
  `CREATE INDEX IF NOT EXISTS deck_views_viewer ON deck_views (viewer)`,
  `CREATE TABLE IF NOT EXISTS deck_slide_time (vid TEXT NOT NULL, slide INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (vid, slide)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS deck_beacons (vid TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '', PRIMARY KEY (vid, seq)) WITHOUT ROWID`,
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
    // a view starts with the first beacon that carries time (a page that was never on screen creates nothing)
    db.prepare(`INSERT INTO deck_views (vid, viewer, link_id, deck, started_at, started_ms, last_at, total_ms, max_slide, fullscreen, download, device, country, referrer, owner)
      SELECT ?1, ?3, (SELECT id FROM deck_links WHERE token = ?4), ?5, ?6, ?8, ?6, ?7, ?9, ?10, ?11, ?12, ?13, ?14, ?15
      WHERE ${fresh} AND (?7 > 0 OR ${exists})
      ON CONFLICT (vid) DO UPDATE SET last_at = excluded.last_at, total_ms = deck_views.total_ms + excluded.total_ms,
        max_slide = MAX(deck_views.max_slide, excluded.max_slide), fullscreen = MAX(deck_views.fullscreen, excluded.fullscreen),
        download = MAX(deck_views.download, excluded.download)`)
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
/** The newest views with their per-slide milliseconds and order of slide visits, for /admin/deck. */
export async function deckViews(db) {
  await ensureSchema(db);
  const scope = `SELECT vid FROM deck_views ORDER BY started_ms DESC LIMIT ${ADMIN_VIEWS}`;
  const q = (sql) => db.prepare(sql).all().then((r) => r.results || []);
  const [views, times, paths] = await Promise.all([
    q(`SELECT v.vid, v.viewer, v.link_id, l.name link_name, v.started_at, v.last_at, v.total_ms, v.max_slide, v.fullscreen, v.download,
         v.device, v.country, v.referrer, v.owner FROM deck_views v LEFT JOIN deck_links l ON l.id = v.link_id
       ORDER BY v.started_ms DESC LIMIT ${ADMIN_VIEWS}`),
    q(`SELECT vid, slide, ms FROM deck_slide_time WHERE vid IN (${scope})`),
    q(`SELECT vid, path FROM deck_beacons WHERE vid IN (${scope}) AND path <> '' ORDER BY vid, seq`),
  ]);
  const ms = new Map(views.map((v) => [v.vid, Array(SLIDES).fill(0)]));
  for (const r of times) { const a = ms.get(r.vid); if (a && r.slide >= 1 && r.slide <= SLIDES) a[r.slide - 1] = Number(r.ms) || 0; }
  const path = new Map();
  for (const r of paths) path.set(r.vid, (path.get(r.vid) || []).concat(String(r.path).split(",").filter(Boolean).map(Number)));
  const seen = new Map();
  for (const v of [...views].reverse()) if (v.viewer) seen.set(v.viewer, (seen.get(v.viewer) || 0) + 1);
  const nth = new Map();
  return {
    generatedAt: new Date().toISOString(), slides: SLIDES, limit: ADMIN_VIEWS,
    views: [...views].reverse().map((v) => {
      const k = v.viewer ? (nth.get(v.viewer) || 0) + 1 : 1;
      if (v.viewer) nth.set(v.viewer, k);
      return {
        at: v.started_at, lastAt: v.last_at, link: v.link_id === null ? null : v.link_name, browser: v.viewer ? v.viewer.slice(0, 6) : null,
        visit: k, visits: v.viewer ? seen.get(v.viewer) : 1, device: v.device, country: v.country, referrer: v.referrer,
        totalMs: Number(v.total_ms) || 0, maxSlide: v.max_slide, fullscreen: !!v.fullscreen, download: !!v.download, owner: !!v.owner,
        ms: ms.get(v.vid), path: path.get(v.vid) || [],
      };
    }).reverse(),
  };
}

/** GET /admin/api/deck; handleAdmin has already checked the session. */
export async function deckAdminApi(request, env) {
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" };
  if (request.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: { ...headers, allow: "GET" } });
  if (!env.ADMIN_DB) return Response.json({ error: "ADMIN_DB is not bound" }, { status: 503, headers });
  return Response.json(await deckViews(env.ADMIN_DB), { headers });
}
