-- Tally — expense splitter schema (Cloudflare D1 / SQLite)
-- Money is stored as integer đồng (VND has no sub-unit), exactly like MoMo's `Long`
-- amount. No ×100 scaling: 540.000 ₫ is stored as the integer 540000.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,        -- Telegram user id
  first_name  TEXT,
  username    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,           -- uuid
  home_chat_id  INTEGER,                    -- Telegram chat that OWNS this event; set at creation,
                                            -- never nulled. A chat owns many events (nullable for
                                            -- app-created events not yet adopted into a chat).
  title         TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT '₫',
  created_by    INTEGER NOT NULL,           -- Telegram user id
  created_at    INTEGER NOT NULL
);

-- Which of a chat's events is currently "active" (the one /tally selected). A chat
-- owns many events via events.home_chat_id, but exactly one is live at a time. Keeping
-- this pointer separate from ownership means switching never disturbs the roster.
CREATE TABLE IF NOT EXISTS chat_active_event (
  chat_id   INTEGER PRIMARY KEY,           -- Telegram chat id
  event_id  TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS participants (
  id          TEXT PRIMARY KEY,           -- uuid
  event_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  user_id     INTEGER,                    -- linked Telegram user, once claimed (nullable)
  pay_bank    TEXT,                        -- transfer info: bank / e-wallet name (per-member, reused across the event)
  pay_account TEXT,                        -- transfer info: account number / phone
  pay_qr      TEXT,                        -- transfer info: QR image (data URL)
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,          -- uuid
  event_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  amount_dong  INTEGER NOT NULL,          -- whole đồng, no sub-unit (MoMo-style)
  paid_by      TEXT NOT NULL,             -- participant id
  created_by   INTEGER NOT NULL,          -- Telegram user id (only this user may edit/delete)
  created_at   INTEGER NOT NULL,
  pay_bank     TEXT,                       -- payment info: bank / e-wallet name (manual mode)
  pay_account  TEXT,                       -- payment info: account number / phone
  pay_qr       TEXT,                       -- payment info: attached QR image (data URL)
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS splits (
  expense_id     TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  included       INTEGER NOT NULL DEFAULT 1,   -- 0/1
  weight         REAL NOT NULL DEFAULT 1,      -- shares this person owes (0.5 = half share e.g. came late; 2 = covers a partner)
  amount_dong    INTEGER,                       -- fixed amount for this person (đồng); NULL = auto by weight
  PRIMARY KEY (expense_id, participant_id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id)
);

-- Parsed-but-unconfirmed natural-language actions from the bot. A row is created
-- when the LLM parses a command; it is executed only on a Yes tap, consumed
-- atomically, and expires after a TTL. status: pending | done | cancelled | expired.
CREATE TABLE IF NOT EXISTS pending_actions (
  id          TEXT PRIMARY KEY,          -- short id, referenced in inline callback_data
  chat_id     INTEGER NOT NULL,          -- Telegram chat the command came from
  user_id     INTEGER NOT NULL,          -- only this user (the parser) may confirm
  user_name   TEXT,                       -- sender first_name, for ensureParticipant at execute time
  event_id    TEXT NOT NULL,
  tool        TEXT NOT NULL,             -- 'split_expense'
  args_json   TEXT NOT NULL,             -- resolved args: {title, amount, members:[{participantId,weight}]}
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX IF NOT EXISTS idx_events_creator    ON events(created_by);
CREATE INDEX IF NOT EXISTS idx_events_home_chat  ON events(home_chat_id);
CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);
CREATE INDEX IF NOT EXISTS idx_participants_user  ON participants(user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_event     ON expenses(event_id);
CREATE INDEX IF NOT EXISTS idx_splits_expense     ON splits(expense_id);
CREATE INDEX IF NOT EXISTS idx_pending_chat       ON pending_actions(chat_id);
