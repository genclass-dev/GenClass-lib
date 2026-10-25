-- The closed-loop log (src/dashboard.ts agentReport; docs/runtime/AGENT.md section 4.5): what a developer's coding
-- agent did about the app's problems through @genclass/mcp, mirrored from that server's own log when the developer
-- turns reporting on (GENCLASS_REPORT). One row per step, in the order they arrived: a finding made (found), its
-- evidence read (explain), a replay armed (armed), a replay verdict (replay, reproduced 1 or 0), a regression test
-- written (test), an explore report (explore: page loads compared and race findings made) and a clear on the
-- developer's machine (cleared: what). Ids, kinds, normalised page paths, verdicts, counts and times only, never page
-- text. At most 500 rows per app (the oldest go first), 90 days (retention). agent_reports gains when the evidence was
-- first read (explained) and how many replays reproduced the finding (reproduced_n: more than one means the agent tried
-- a fix and the bug was still there, which the dashboard draws as "round again"). Additive only.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
CREATE TABLE IF NOT EXISTS agent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  at TEXT NOT NULL,
  t TEXT NOT NULL,
  finding TEXT,
  kind TEXT,
  route TEXT,
  reproduced INTEGER,
  runs INTEGER,
  races INTEGER,
  what TEXT,
  received TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_log_token_at ON agent_log (token, at);
CREATE INDEX IF NOT EXISTS agent_log_at ON agent_log (at);
ALTER TABLE agent_reports ADD COLUMN explained TEXT;
ALTER TABLE agent_reports ADD COLUMN reproduced_n INTEGER NOT NULL DEFAULT 0;
