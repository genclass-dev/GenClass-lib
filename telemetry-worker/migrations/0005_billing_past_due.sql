-- Overdue plans end in the worker (src/plans.ts PAST_DUE_GRACE_DAYS, src/stripe.ts). GenClass bills through a Stripe
-- account it shares with Polar Parts, so it cannot rely on the account-wide retry setting ("cancel the subscription
-- if all retries fail") to end a plan that is not paid: a subscription past_due for more than 14 days, or unpaid,
-- leaves its account on Free whatever that setting says. Additive only.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- When GenClass first saw the account's subscription past_due (ISO time); NULL in every other status.
ALTER TABLE accounts ADD COLUMN past_due_since TEXT;
