-- Migration 0001 — multiple events per chat + switch.
--
-- Splits events.chat_id (which was overloaded as BOTH "the chat that owns this
-- event" AND "the event currently active in that chat") into two clear concepts:
--   events.home_chat_id  — the owning chat, set at creation and never nulled
--   chat_active_event    — the per-chat "which event is live now" pointer
--
-- Run ONCE against an existing database:
--   npm run db:migrate:local     (local .sqlite)
--   npm run db:migrate:remote    (production D1)
-- Fresh installs get this shape straight from schema.sql and do NOT need it.

-- 1. Rename the overloaded column. SQLite ≥3.25 / D1 support RENAME COLUMN and
--    auto-update dependent indexes.
ALTER TABLE events RENAME COLUMN chat_id TO home_chat_id;

-- 2. The new active-event pointer.
CREATE TABLE IF NOT EXISTS chat_active_event (
  chat_id   INTEGER PRIMARY KEY,
  event_id  TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- 3. Seed the pointer from the current single binding per chat. Historically only
--    one event per chat had chat_id set (bindEventToChat nulled the others), so this
--    is normally 1:1. If any chat somehow has several, the NEWEST wins — matching the
--    old resolveEventForChat (ORDER BY created_at DESC LIMIT 1). INSERT OR IGNORE keeps
--    the first row seen per chat_id (PRIMARY KEY), and DESC puts the newest first.
INSERT OR IGNORE INTO chat_active_event (chat_id, event_id)
  SELECT home_chat_id, id
    FROM events
   WHERE home_chat_id IS NOT NULL
   ORDER BY created_at DESC;

-- 4. Swap the index name to match the renamed column.
DROP INDEX IF EXISTS idx_events_chat;
CREATE INDEX IF NOT EXISTS idx_events_home_chat ON events(home_chat_id);
