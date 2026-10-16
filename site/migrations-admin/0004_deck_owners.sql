-- genclass.dev/pitch-deck: browser ids the founders marked as theirs on /admin/deck (src/deck.js; the worker also runs
-- this once per isolate). Their views stay in deck_views with owner = 1 and are left out of the owner's tables unless asked.
CREATE TABLE IF NOT EXISTS deck_owners (viewer TEXT PRIMARY KEY, at TEXT NOT NULL) WITHOUT ROWID;
