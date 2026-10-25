-- What a developer's coding agent reported about an app's problems through @genclass/mcp (src/dashboard.ts
-- agentReport; docs/runtime/AGENT.md section 4.5): per finding, its kind and page, when it was found, the last replay
-- verdict, when a regression test was written and when the fix was proven (a replay that no longer reproduces it after
-- one that did). Sent only when the developer turns reporting on (GENCLASS_REPORT); ids, kinds, routes, verdicts and
-- times only, never page text. Kept 90 days like the rest (retention). Additive only.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
CREATE TABLE IF NOT EXISTS agent_reports (
  token TEXT NOT NULL,
  finding TEXT NOT NULL,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  found TEXT,
  replayed TEXT,
  reproduced INTEGER,
  reproduced_once INTEGER NOT NULL DEFAULT 0,
  tested TEXT,
  proven TEXT,
  updated TEXT NOT NULL,
  PRIMARY KEY (token, finding)
);
CREATE INDEX IF NOT EXISTS agent_reports_updated ON agent_reports (token, updated);
