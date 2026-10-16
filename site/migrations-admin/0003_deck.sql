-- genclass.dev/pitch-deck reading time (src/deck.js; the worker also runs these once per isolate, IF NOT EXISTS).
-- deck_views: one row per page load (vid, random). viewer: random id kept in the browser (localStorage), groups repeat
-- visits. link_id: a named share link (deck_links, ?k=<token>), NULL for the direct link. No IP, user agent or cookie.
-- deck_slide_time: milliseconds each slide was on screen while the page was visible and the window focused.
-- deck_beacons: one row per applied beacon (vid, seq): makes a repeated beacon a no-op and keeps the visit order.
CREATE TABLE IF NOT EXISTS deck_links (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deck_views (vid TEXT PRIMARY KEY, viewer TEXT, link_id INTEGER, deck TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, started_ms INTEGER NOT NULL, last_at TEXT NOT NULL, total_ms INTEGER NOT NULL DEFAULT 0, max_slide INTEGER NOT NULL DEFAULT 0, fullscreen INTEGER NOT NULL DEFAULT 0, download INTEGER NOT NULL DEFAULT 0, device TEXT, country TEXT, referrer TEXT, owner INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS deck_views_started ON deck_views (started_ms);
CREATE INDEX IF NOT EXISTS deck_views_link ON deck_views (link_id, started_ms);
CREATE INDEX IF NOT EXISTS deck_views_viewer ON deck_views (viewer);
CREATE TABLE IF NOT EXISTS deck_slide_time (vid TEXT NOT NULL, slide INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (vid, slide)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS deck_beacons (vid TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '', PRIMARY KEY (vid, seq)) WITHOUT ROWID;
