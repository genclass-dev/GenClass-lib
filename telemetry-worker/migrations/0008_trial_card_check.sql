-- The $1 card check before a trial of Pro (src/stripe.ts cardCheck): when Stripe reports the trial's subscription, the
-- worker places a $1 authorization hold on its card and releases it at once; a card that cannot hold $1 gets no trial
-- (its subscription is cancelled) and the account may try another card. Additive only: every existing account has no
-- failed check.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- How many trial cards of this account failed the $1 check (the trial is refused after 3, against card testing), and
-- when the last one did (the billing page says so until a trial starts).
ALTER TABLE accounts ADD COLUMN trial_check_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN trial_check_failed_at TEXT;
