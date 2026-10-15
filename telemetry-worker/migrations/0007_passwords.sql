-- Email and password sign-in (src/auth.ts, src/password.ts). Additive only: two new tables; no existing row or column
-- changes, and every existing account keeps signing in as before (it has no password until it adds one on /account).
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- One password per account. `email` is the username: trimmed and lowercased, unique among passwords, never verified
-- (GenClass has no email sender yet), and never used to join accounts. `hash` is a versioned string,
-- $pbkdf2-sha256$v=1$i=600000,l=100000$<salt>$<hash> (src/password.ts); the password itself is never stored.
-- failed / failed_at / next_try are the per-account delay after wrong passwords: the wrong ones in a row (counted only
-- from browsers the account does not trust; the count starts again after a day without one), the last of them, and
-- the time before which no password for this account is checked (30 s after the 5th, doubling to 15 minutes). Never a
-- lockout: see password_devices.
CREATE TABLE passwords (
  account_id  TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL,
  created     TEXT NOT NULL,
  updated     TEXT NOT NULL,                 -- when it was last set or changed
  last_used   TEXT,                          -- the last correct password at sign-in
  failed      INTEGER NOT NULL DEFAULT 0,
  failed_at   TEXT,
  next_try    TEXT
);

-- Browsers where an account's password was right (the __Host-gc_device cookie; only its SHA-256 hex is stored). Such a
-- browser skips the account's delay for up to 5 wrong passwords in a row, so someone guessing elsewhere cannot keep the
-- owner out. The cookie is rotated at every correct password; a password change forgets every browser of the account;
-- rows unused for 400 days go in the daily sweep.
CREATE TABLE password_devices (
  hash        TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  created     TEXT NOT NULL,
  last_used   TEXT NOT NULL,
  failed      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hash, account_id)
);
CREATE INDEX password_devices_account ON password_devices (account_id);
CREATE INDEX password_devices_used ON password_devices (last_used);
