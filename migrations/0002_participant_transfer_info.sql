-- Migration 0002 — move transfer info from expenses to participants.
--
-- Payment/transfer info describes a PERSON who receives money, not a transaction.
-- It used to live per-expense (expenses.pay_bank/pay_account/pay_qr), which forced
-- summaryText to hunt a person's account out of their expenses. Store it once per
-- participant instead; it's then entered once and reused across the whole event.
--
-- Run ONCE against an existing database:
--   npm run db:migrate:local     (local .sqlite)
--   npm run db:migrate:remote    (production D1)
-- Fresh installs get these columns straight from schema.sql and do NOT need this.
--
-- The expenses.pay_* columns are intentionally kept (not dropped) so old data and
-- the not-yet-migrated Mini App expense form keep working during the transition;
-- summaryText prefers the participant value and falls back to the expense-derived one.

-- 1. Per-member transfer info.
ALTER TABLE participants ADD COLUMN pay_bank    TEXT;
ALTER TABLE participants ADD COLUMN pay_account TEXT;
ALTER TABLE participants ADD COLUMN pay_qr      TEXT;

-- 2. Backfill bank + account together from each participant's most recent expense
--    (as payer) that carried both — so a person's stored account matches what they
--    last used. Correlated subquery per participant; NULL when they never set one.
UPDATE participants
   SET pay_bank = (
         SELECT e.pay_bank FROM expenses e
          WHERE e.paid_by = participants.id
            AND e.pay_bank IS NOT NULL AND e.pay_bank <> ''
            AND e.pay_account IS NOT NULL AND e.pay_account <> ''
          ORDER BY e.created_at DESC LIMIT 1),
       pay_account = (
         SELECT e.pay_account FROM expenses e
          WHERE e.paid_by = participants.id
            AND e.pay_bank IS NOT NULL AND e.pay_bank <> ''
            AND e.pay_account IS NOT NULL AND e.pay_account <> ''
          ORDER BY e.created_at DESC LIMIT 1)
 WHERE EXISTS (
         SELECT 1 FROM expenses e
          WHERE e.paid_by = participants.id
            AND e.pay_account IS NOT NULL AND e.pay_account <> '');

-- 3. Backfill QR independently (an expense may carry a QR but no bank/account).
UPDATE participants
   SET pay_qr = (
         SELECT e.pay_qr FROM expenses e
          WHERE e.paid_by = participants.id
            AND e.pay_qr IS NOT NULL AND e.pay_qr <> ''
          ORDER BY e.created_at DESC LIMIT 1)
 WHERE EXISTS (
         SELECT 1 FROM expenses e
          WHERE e.paid_by = participants.id
            AND e.pay_qr IS NOT NULL AND e.pay_qr <> '');
