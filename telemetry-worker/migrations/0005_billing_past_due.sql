-- Overdue plans end in the worker (src/plans.ts PAST_DUE_GRACE_DAYS, src/stripe.ts), as a backstop to the Stripe
-- account's retry setting ("cancel the subscription if all retries fail"; written when the account was to be shared
-- with another business, whose setting GenClass could not rely on): a subscription past_due for more than 14 days, or
-- unpaid, leaves its account on Free whatever that setting says. Additive only.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- When GenClass first saw the account's subscription past_due (ISO time); NULL in every other status.
ALTER TABLE accounts ADD COLUMN past_due_since TEXT;
