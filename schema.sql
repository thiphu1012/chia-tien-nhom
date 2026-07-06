-- Tally — expense splitter schema (Cloudflare D1 / SQLite)
-- Money is stored as integer cents to avoid floating-point drift.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,        -- Telegram user id
  first_name  TEXT,
  username    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,           -- uuid
  chat_id     INTEGER,                    -- Telegram chat it was created from (nullable)
  title       TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT '$',
  created_by  INTEGER NOT NULL,           -- Telegram user id
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id          TEXT PRIMARY KEY,           -- uuid
  event_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  user_id     INTEGER,                    -- linked Telegram user, once claimed (nullable)
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,          -- uuid
  event_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_by      TEXT NOT NULL,             -- participant id
  created_by   INTEGER NOT NULL,          -- Telegram user id (only this user may edit/delete)
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS splits (
  expense_id     TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  included       INTEGER NOT NULL DEFAULT 1,   -- 0/1
  weight         INTEGER NOT NULL DEFAULT 1,   -- shares this person owes
  PRIMARY KEY (expense_id, participant_id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id)
);

CREATE INDEX IF NOT EXISTS idx_events_creator    ON events(created_by);
CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);
CREATE INDEX IF NOT EXISTS idx_participants_user  ON participants(user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_event     ON expenses(event_id);
CREATE INDEX IF NOT EXISTS idx_splits_expense     ON splits(expense_id);
