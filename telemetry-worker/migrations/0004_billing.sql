-- Paid plans (src/plans.ts, src/stripe.ts), forwarding (src/forward.ts) and export (src/export.ts). Additive only:
-- every existing row keeps working, and every account starts on the free plan.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- The plan and the Stripe ids. Never card data: Stripe holds that. `plan` is derived from the subscription's price
-- lookup_key and status on every Stripe event (src/stripe.ts); `current_period_end` is when the paid period ends
-- (renewal, or the end of a cancelled plan).
ALTER TABLE accounts ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE accounts ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE accounts ADD COLUMN subscription_id TEXT;
ALTER TABLE accounts ADD COLUMN subscription_status TEXT;
ALTER TABLE accounts ADD COLUMN current_period_end TEXT;
ALTER TABLE accounts ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX accounts_stripe_customer ON accounts (stripe_customer_id);
CREATE INDEX accounts_subscription ON accounts (subscription_id);

-- Stripe events already handled (webhooks are delivered at least once). Ids only; kept 30 days.
CREATE TABLE billing_events (
  id       TEXT PRIMARY KEY,                  -- evt_...
  type     TEXT NOT NULL,
  received TEXT NOT NULL
);
CREATE INDEX billing_events_received ON billing_events (received);

-- A Custom plan purchase, so the owner can start the training work: one row per subscription.
CREATE TABLE custom_requests (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  email           TEXT,
  subscription_id TEXT NOT NULL UNIQUE,
  created         TEXT NOT NULL,
  notified        TEXT                        -- when NOTIFY_WEBHOOK accepted the notice
);

-- Where an owned app's detections are forwarded (paid plans). `config` is AES-GCM ciphertext (INTEGRATIONS_KEY) of
-- the JSON settings, bound to the project id and kind; never stored in clear. One destination of each kind per app.
CREATE TABLE integrations (
  project_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('sentry', 'posthog', 'datadog', 'slack', 'webhook')),
  config     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created    TEXT NOT NULL,
  last_sent  TEXT,
  last_error TEXT,
  PRIMARY KEY (project_id, kind)
) WITHOUT ROWID;

-- Forwarding dedupe and the hourly cap: one row per (app, problem type and page, UTC hour) that was forwarded.
-- Kept 2 hours.
CREATE TABLE forward_log (
  project_id TEXT NOT NULL,
  signature  TEXT NOT NULL,                   -- diagnosis + "\t" + route
  hour       TEXT NOT NULL,                   -- YYYY-MM-DDTHH (UTC)
  PRIMARY KEY (project_id, hour, signature)
) WITHOUT ROWID;

-- Which stored batches belong to which app, for the export (R2 keys are by day, not by app). One row per batch from
-- an app in an account; the key is the batch under events/ (90 days) or, for an app on a paid plan, its copy under
-- export/<token>/ (kept as long as the plan's history). Swept with the dashboard data.
CREATE TABLE event_batches (
  token    TEXT NOT NULL,
  received TEXT NOT NULL,                     -- ISO time the batch was received
  key      TEXT NOT NULL,
  events   INTEGER NOT NULL,
  PRIMARY KEY (token, received, key)
) WITHOUT ROWID;
CREATE INDEX event_batches_received ON event_batches (received);

-- Export keys for GET /api/account/projects/<id>/events: `gce_` + 32 random bytes, stored as a SHA-256 hex. They
-- can read the export of the account's apps and nothing else.
CREATE TABLE export_keys (
  id         TEXT PRIMARY KEY,
  hash       TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  label      TEXT,
  created    TEXT NOT NULL,
  last_used  TEXT
);
CREATE INDEX export_keys_account ON export_keys (account_id);
