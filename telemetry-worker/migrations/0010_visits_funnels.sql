-- Interaction analytics, visits and funnels (src/dashboard.ts; docs/runtime/ANALYTICS.md section 1.2 and 3.1): only
-- from apps that turned analytics on. One row per visit: a hash of the app's token and the visit id the runtime keeps
-- for 30 minutes (never the id itself), when it started and was last seen, its entry and exit page, how many page views
-- it had, and the routes of its first 50 page views in order (each one between tabs, "\t/a\t\t/b\t"), which is what
-- entry and exit pages, pages per visit and funnels are counted from. Routes only, normalised by the runtime; nothing
-- else about the visitor. Kept 90 days (retention). `projects.funnels`: the app's funnels as JSON
-- ([{ "name", "steps": [route, ...] }], at most 5 of 2 to 6 steps), set on its dashboard. Additive only.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
CREATE TABLE IF NOT EXISTS visits (
  visit_hash TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  started TEXT NOT NULL,
  updated TEXT NOT NULL,
  entry TEXT NOT NULL,
  exit TEXT NOT NULL,
  pages INTEGER NOT NULL,
  routes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_token_started ON visits (token, started);
CREATE INDEX IF NOT EXISTS visits_started ON visits (started);
ALTER TABLE projects ADD COLUMN funnels TEXT;
