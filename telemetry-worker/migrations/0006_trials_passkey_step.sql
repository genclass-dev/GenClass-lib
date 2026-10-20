-- Trials, GenClass's own grants, and the passkey step at sign-in (src/plans.ts accountAccess, src/trial.ts,
-- src/auth.ts). Additive only: every existing account has no trial, no grant, and every existing session counts as
-- not recently confirmed with a passkey. Written for the paid plan of that time; since the plans changed on
-- 2026-10-20 the trial and the grant give Individual's entitlements (the hosted closed-loop MCP), and the dashboard
-- is free for every account. The columns and their meaning are unchanged.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- One trial per account, without a card: started from the billing or account page (or the pricing page) while the
-- trial's plan is on sale. While trial_ends_at is in the future the account has that plan's entitlements; afterwards
-- Free's, unless a paid plan or a grant applies. trial_started_at stays set for good, so a second trial cannot start.
-- The length comes from the TRIAL_DAYS var (wrangler.toml).
ALTER TABLE accounts ADD COLUMN trial_started_at TEXT;
ALTER TABLE accounts ADD COLUMN trial_ends_at TEXT;
-- GenClass's own grant of the trial's plan (the owner's apps, a partner): set only by hand with a D1 update
-- (telemetry-worker/README.md, "Trials and grants"). That plan's entitlements until this time; NULL (the default)
-- means none.
ALTER TABLE accounts ADD COLUMN comp_until TEXT;

-- When this session last proved a passkey: a passkey sign-in, the passkey step after Google or GitHub, or a fresh
-- confirmation on the account page. Adding a passkey to an account that has one, and removing one, need it within
-- the last 5 minutes.
ALTER TABLE auth_sessions ADD COLUMN passkey_at TEXT;
