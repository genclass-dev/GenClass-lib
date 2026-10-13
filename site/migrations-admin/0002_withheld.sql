-- Per page load (sid): routine decisions whose records runtime 0.3.0 withheld (decisionSample, maxDecisions), from the
-- cumulative summary.telemetry counts already added to the decision totals. ingest() also creates it if missing.
CREATE TABLE IF NOT EXISTS withheld (sid TEXT PRIMARY KEY, n INTEGER NOT NULL, at TEXT NOT NULL);
