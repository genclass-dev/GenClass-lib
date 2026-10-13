-- GenClass accounts (D1 database `genclass-dashboard`): sign-in with passkeys, Google or GitHub; web and CLI
-- sessions; the device flow that signs the CLI in; apps owned by an account.
-- Additive only: new tables, three new nullable columns on `projects`, and an id for every existing project. Projects
-- created from a private dashboard link keep working through that link and can be claimed by an account.
-- Apply: npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote

-- One row per person. `email` is as typed at passkey sign-up (never verified by us) or as Google returned it;
-- email_verified is 1 only when Google said so. Accounts are never merged or linked because emails match.
CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,            -- 22 base62; also the passkeys' user handle
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  google_sub     TEXT UNIQUE,                 -- Google's stable account id (OIDC `sub`)
  github_id      TEXT UNIQUE,                 -- GitHub's numeric user id, as text
  github_login   TEXT,
  created        TEXT NOT NULL
);
CREATE INDEX accounts_email ON accounts (lower(email));

-- Passkeys: only public keys are stored.
CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,               -- credential id, base64url
  account_id  TEXT NOT NULL,
  public_key  TEXT NOT NULL,                  -- COSE_Key bytes, base64url
  alg         INTEGER NOT NULL,               -- -7 ES256 | -257 RS256
  sign_count  INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,                           -- JSON array as the browser reported it
  created     TEXT NOT NULL,
  last_used   TEXT
);
CREATE INDEX credentials_account ON credentials (account_id);

-- Sign-in sessions. Named auth_sessions because `sessions` already holds the per-page-load summary counters.
-- `hash` is the SHA-256 hex of the cookie value (web) or the bearer token (cli); the secret itself is never stored.
CREATE TABLE auth_sessions (
  id          TEXT PRIMARY KEY,               -- public id, for listing and revoking
  hash        TEXT NOT NULL UNIQUE,
  account_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('web', 'cli')),
  created     TEXT NOT NULL,
  expires     TEXT NOT NULL,
  revoked     TEXT,
  label       TEXT,
  last_used   TEXT
);
CREATE INDEX auth_sessions_account ON auth_sessions (account_id, kind);
CREATE INDEX auth_sessions_expires ON auth_sessions (expires);

-- Single-use WebAuthn challenges (5 minutes) and pending sign-ups that wait for a choice (10 minutes).
CREATE TABLE challenges (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                  -- 'register' | 'login' | 'pending'
  challenge   TEXT NOT NULL,
  account_id  TEXT,
  data        TEXT,                           -- JSON: the typed email (register), the provider identity (pending)
  expires     TEXT NOT NULL
);
CREATE INDEX challenges_expires ON challenges (expires);

-- The CLI's device flow (RFC 8628). Only a SHA-256 hex of the device code is stored.
CREATE TABLE device_codes (
  hash          TEXT PRIMARY KEY,
  user_code     TEXT NOT NULL,                -- ABCD-EFGH, no vowels, shown on genclass.dev/login/device
  account_id    TEXT,                         -- set on approval
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  client        TEXT,                         -- what the CLI said it is, e.g. "genclass-runtime 0.3.0"
  created       TEXT NOT NULL,
  expires       TEXT NOT NULL,
  last_poll     TEXT,
  poll_interval INTEGER NOT NULL DEFAULT 5
);
CREATE UNIQUE INDEX device_codes_user_code ON device_codes (user_code);
CREATE INDEX device_codes_expires ON device_codes (expires);

-- Apps: an owner (nullable: secret-link projects have none until claimed), a stable id for account URLs (the token
-- stays the public key), the time of the first batch (the Connect panel's "First event at"), and whether a private
-- dashboard link opens the app. Every project made before accounts has one (1, the default; /start and init without
-- an account keep making them); an app created in an account has none (0), and an owner can turn a link off (0).
ALTER TABLE projects ADD COLUMN account_id TEXT;
ALTER TABLE projects ADD COLUMN id TEXT;
ALTER TABLE projects ADD COLUMN first_event TEXT;
ALTER TABLE projects ADD COLUMN private_link INTEGER NOT NULL DEFAULT 1;
UPDATE projects SET id = lower(hex(randomblob(8))) WHERE id IS NULL;
-- Projects that already had traffic: the earliest detection still kept, else the last event. It can be later than
-- the real first batch (traffic without detections leaves no row in `recent`), but the first batch after the deploy
-- no longer becomes the "first event" of an app that has sent data for days.
UPDATE projects SET first_event = COALESCE(min((SELECT MIN(r.t) FROM recent r WHERE r.token = projects.token), last_event), last_event)
WHERE first_event IS NULL AND last_event IS NOT NULL;
CREATE UNIQUE INDEX projects_id ON projects (id);
CREATE INDEX projects_account ON projects (account_id);
