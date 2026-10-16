// The pitch deck beacon (site/src/deck.js): validation, caps and idempotency, against a real SQLite database standing
// in for D1 (node:sqlite, Node 22.13+). Run: node --test site/check/deck.test.mjs (CI: .github/workflows/site.yml).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { BEACON_MAX_MS, SCHEMA, WALL_SLACK_MS, deckBeacon, deckViews, deviceClass, ensureSchema, parseBeacon } from "../src/deck.js";
import worker from "../src/worker.js";

/** A minimal D1 over node:sqlite: prepare/bind/run/all/first and batch() as one transaction. */
function d1() {
  const sql = new DatabaseSync(":memory:");
  const stmt = (q, params = []) => ({
    bind: (...p) => stmt(q, p),
    run: async () => { const r = sql.prepare(q).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: sql.prepare(q).all(...params) }),
    first: async () => sql.prepare(q).get(...params) ?? null,
    exec: () => sql.prepare(q).run(...params),
  });
  return {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec("BEGIN");
      try { const out = list.map((s) => s.exec()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
  };
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const VID = "AbCdEfGhIjKlMnOpQrStUv";
const beacon = (over = {}) => ({ v: 1, vid: VID, seq: 1, t: { 1: 4000 }, p: [1], m: 1, fs: 0, dl: 0, d: "2026-10", b: "ViewerViewerViewerVie1", ...over });
function post(body, { ua = UA, origin = "https://genclass.dev", ip = "203.0.113.9", raw } = {}) {
  const headers = { "content-type": "text/plain;charset=UTF-8", "user-agent": ua, "cf-connecting-ip": ip };
  if (origin) headers.origin = origin;
  const r = new Request("https://genclass.dev/pitch-deck/beacon", { method: "POST", headers, body: raw ?? JSON.stringify(body) });
  Object.defineProperty(r, "cf", { value: { country: "CA" } });
  return r;
}
const T0 = Date.parse("2026-10-15T12:00:00Z");
const views = (db) => db.sql.prepare("SELECT * FROM deck_views").all();
const times = (db) => Object.fromEntries(db.sql.prepare("SELECT slide, ms FROM deck_slide_time WHERE vid = ? ORDER BY slide").all(VID).map((r) => [r.slide, r.ms]));

describe("pitch deck beacon: validation", () => {
  it("accepts the viewer's beacon and normalises it", () => {
    const r = parseBeacon(beacon({ t: { 1: 1200, 3: 800 }, p: [1, 2, 3], m: 3, r: "Mail.Google.com", tp: 1, k: "tokenTokenToken12345" }));
    assert.equal(r.ok, true);
    assert.deepEqual([...r.beacon.ms], [[1, 1200], [3, 800]]);
    assert.deepEqual(r.beacon.path, [1, 2, 3]);
    assert.equal(r.beacon.max, 3);
    assert.equal(r.beacon.referrer, "mail.google.com");
    assert.equal(r.beacon.touch, true);
    assert.equal(r.beacon.token, "tokenTokenToken12345");
  });
  it("refuses malformed beacons", () => {
    for (const [why, b] of [
      ["array", []], ["null", null], ["version", beacon({ v: 2 })], ["short vid", beacon({ vid: "abc" })], ["vid chars", beacon({ vid: "AbCdEfGhIjKlMnOpQr<>Uv" })],
      ["seq 0", beacon({ seq: 0 })], ["seq float", beacon({ seq: 1.5 })], ["seq string", beacon({ seq: "1" })], ["seq huge", beacon({ seq: 1e7 })],
      ["slide 0", beacon({ t: { 0: 5 } })], ["slide 10", beacon({ t: { 10: 5 } })], ["slide name", beacon({ t: { x: 5 } })], ["slide 01", beacon({ t: { "01": 5 } })],
      ["negative ms", beacon({ t: { 1: -1 } })], ["float ms", beacon({ t: { 1: 1.5 } })], ["string ms", beacon({ t: { 1: "5" } })], ["t array", beacon({ t: [5] })],
      ["path not array", beacon({ p: "1,2" })], ["path slide 10", beacon({ p: [1, 10] })], ["path float", beacon({ p: [1.5] })], ["max 10", beacon({ m: 10 })],
    ]) assert.equal(parseBeacon(b).ok, false, why);
  });
  it("drops what is not an id, token or hostname instead of storing it", () => {
    const r = parseBeacon(beacon({ b: "not an id", k: "short", r: "http://x.com/a?b", d: "<script>" }));
    assert.equal(r.ok, true);
    assert.equal(r.beacon.viewer, null);
    assert.equal(r.beacon.token, null);
    assert.equal(r.beacon.referrer, null);
    assert.equal(r.beacon.deck, "");
  });
  it("caps each slide and the whole beacon at 15 s, and keeps at most 50 slide visits", () => {
    const one = parseBeacon(beacon({ t: { 2: 3_600_000 } }));
    assert.equal(one.beacon.ms.get(2), BEACON_MAX_MS);
    const many = parseBeacon(beacon({ t: { 1: 10000, 2: 10000, 3: 10000 } }));
    const sum = [...many.beacon.ms.values()].reduce((a, b) => a + b, 0);
    assert.ok(sum <= BEACON_MAX_MS && sum >= BEACON_MAX_MS - 3, String(sum));
    assert.equal(parseBeacon(beacon({ p: Array(80).fill(2) })).beacon.path.length, 50);
  });
  it("classifies devices from the user agent without keeping it", () => {
    assert.equal(deviceClass(UA), "desktop");
    assert.equal(deviceClass(UA, true), "tablet", "iPadOS sends a Mac user agent");
    assert.equal(deviceClass("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"), "phone");
    assert.equal(deviceClass("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36"), "phone");
    assert.equal(deviceClass("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/141.0 Safari/537.36"), "tablet");
  });
});

describe("pitch deck beacon: HTTP", () => {
  it("answers 405 to anything but POST, and the worker routes the path before the static assets", async () => {
    const env = { ADMIN_DB: d1(), ASSETS: { fetch: () => { throw new Error("assets must not be asked"); } } };
    const get = await worker.fetch(new Request("https://genclass.dev/pitch-deck/beacon"), env, { waitUntil() {} });
    assert.equal(get.status, 405);
    const ok = await worker.fetch(post(beacon()), env, { waitUntil() {} });
    assert.equal(ok.status, 204);
    assert.equal(views(env.ADMIN_DB).length, 1);
  });
  it("refuses bad JSON, oversized bodies and other origins; drops bots silently; rate-limits per IP", async () => {
    const db = d1();
    await ensureSchema(db);
    assert.equal((await deckBeacon(post(null, { raw: "{nope" }), { ADMIN_DB: db }, T0)).status, 400);
    assert.equal((await deckBeacon(post(beacon({ seq: -1 })), { ADMIN_DB: db }, T0)).status, 400);
    assert.equal((await deckBeacon(post(null, { raw: JSON.stringify(beacon({ pad: "x".repeat(3000) })) }), { ADMIN_DB: db }, T0)).status, 413);
    assert.equal((await deckBeacon(post(beacon(), { origin: "https://evil.example" }), { ADMIN_DB: db }, T0)).status, 403);
    for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1)", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 HeadlessChrome/141.0", "facebookexternalhit/1.1", ""]) {
      assert.equal((await deckBeacon(post(beacon(), { ua }), { ADMIN_DB: db }, T0)).status, 204, ua);
    }
    assert.equal(views(db).length, 0, "nothing stored for refused or bot beacons");
    const keys = [];
    const limited = { ADMIN_DB: db, DECK_LIMIT: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } };
    assert.equal((await deckBeacon(post(beacon()), limited, T0)).status, 429);
    assert.deepEqual(keys, ["deck:203.0.113.9"]);
    assert.equal(views(db).length, 0);
  });
});

describe("pitch deck beacon: storage", () => {
  it("creates the view from the first beacon with time, never from one without", async () => {
    const db = d1();
    await deckBeacon(post(beacon({ t: {} })), { ADMIN_DB: db }, T0);
    assert.equal(views(db).length, 0, "a page never on screen creates no view");
    await deckBeacon(post(beacon({ seq: 2, t: { 1: 2500 } })), { ADMIN_DB: db }, T0 + 3000);
    const [v] = views(db);
    assert.equal(v.total_ms, 2500);
    assert.equal(v.device, "desktop");
    assert.equal(v.country, "CA");
    assert.equal(v.link_id, null);
    assert.equal(v.viewer, "ViewerViewerViewerVie1");
    const stored = JSON.stringify(db.sql.prepare("SELECT * FROM deck_views").all()) + JSON.stringify(db.sql.prepare("SELECT * FROM deck_beacons").all());
    assert.ok(!stored.includes("203.0.113.9") && !stored.includes("Chrome/141"), "no IP address or user agent stored");
  });
  it("counts a repeated beacon once, and out-of-order beacons each once", async () => {
    const db = d1();
    const env = { ADMIN_DB: db };
    const b1 = beacon({ seq: 1, t: { 1: 4000 }, p: [1] });
    const b2 = beacon({ seq: 2, t: { 1: 1000, 2: 6000 }, p: [2], m: 2 });
    const b3 = beacon({ seq: 3, t: { 2: 500, 3: 9000 }, p: [3, 2, 3], m: 3, fs: 1 });
    for (const [b, at] of [[b1, 5000], [b1, 5100], [b3, 20000], [b2, 20100], [b3, 20200], [b2, 21000]]) {
      assert.equal((await deckBeacon(post(b), env, T0 + at)).status, 204);
    }
    assert.deepEqual(times(db), { 1: 5000, 2: 6500, 3: 9000 });
    const [v] = views(db);
    assert.equal(v.total_ms, 20500);
    assert.equal(v.max_slide, 3);
    assert.equal(v.fullscreen, 1);
    assert.equal(db.sql.prepare("SELECT COUNT(*) n FROM deck_beacons").get().n, 3);
    const visits = Object.fromEntries(db.sql.prepare("SELECT slide, visits FROM deck_slide_time").all().map((r) => [r.slide, r.visits]));
    assert.deepEqual(visits, { 1: 1, 2: 2, 3: 2 });
    const out = await deckViews(db);
    assert.deepEqual(out.views[0].path, [1, 2, 3, 2, 3], "visit order follows the sequence numbers, not arrival");
    assert.deepEqual(out.views[0].ms, [5000, 6500, 9000, 0, 0, 0, 0, 0, 0]);
  });
  it("never lets a view's total outgrow the wall time since its first beacon plus the slack", async () => {
    const db = d1();
    for (let seq = 1; seq <= 40; seq++) await deckBeacon(post(beacon({ seq, t: { 4: 15000 }, p: [] })), { ADMIN_DB: db }, T0 + seq);
    const [v] = views(db);
    assert.ok(v.total_ms <= 15000 + WALL_SLACK_MS + 40, String(v.total_ms));
    assert.equal(times(db)[4], v.total_ms, "the slide rows and the total agree");
  });
  it("keeps the migration file and the worker's schema identical", () => {
    const file = readFileSync(new URL("../migrations-admin/0003_deck.sql", import.meta.url), "utf8");
    const stmts = file.split("\n").filter((l) => l && !l.startsWith("--")).join(" ").split(";").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(stmts, SCHEMA);
  });
});

describe("pitch deck page", () => {
  const page = readFileSync(new URL("../public/pitch-deck.html", import.meta.url), "utf8");
  it("is a standalone, unbranded, unindexed page whose asset versions match the files", async () => {
    assert.match(page, /<title>Pitch deck<\/title>/);
    assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
    assert.doesNotMatch(page, /<script>|<script [^>]*>[^<]/, "no inline script");
    const { createHash } = await import("node:crypto");
    for (const f of ["viewer.js", "viewer.css", "nojs.css"]) {
      const v = createHash("sha1").update(readFileSync(new URL(`../public/pitch-deck/${f}`, import.meta.url))).digest("hex").slice(0, 8);
      assert.ok(page.includes(`/pitch-deck/${f}?v=${v}`), `${f}?v= must be ${v}`);
    }
    assert.equal((page.match(/<figure class="slide/g) || []).length, 9);
    assert.ok(!readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8").includes("pitch-deck"));
    const res = await worker.fetch(new Request("https://genclass.dev/pitch-deck"), { ASSETS: { fetch: async () => new Response(page, { headers: { "content-type": "text/html" } }) } }, { waitUntil() {} });
    assert.match(res.headers.get("content-security-policy"), /script-src 'self';/);
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  });
});
