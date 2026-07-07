# Changelog

All notable changes to Tally are documented here. Dates are YYYY-MM-DD.

## [1.1.0] — 2026-07-07

Vietnamese-first release: VND money model, richer splits, and payment info on settle-up.

### Added
- **Vietnamese UI throughout**, including the bot's `/start` and `/help` messages.
- **Fixed per-member split amounts.** In "Chia cho", type an exact amount for a member to
  lock it; the remaining total re-divides among the others (by weight) on blur. A fixed
  amount is capped at the expense total. Locked members show a ↺ reset-to-auto control.
- **Payment info per expense**, shown on the Quyết toán page:
  - Manual: bank / e-wallet (official VietQR/NAPAS bank list + MoMo, ZaloPay, Viettel
    Money, ShopeePay, VNPay) + account number, with a copy button.
  - Image: a transfer QR the payer uploads (shrunk client-side, stored in D1).
- **Add members** from the event screen and from within the expense editor.
- **Quyết toán redesigned as a table** (Giao dịch · Số tiền · Thông tin thanh toán) with a
  per-row **Xem** button opening a payment-info modal (copyable account / zoomable QR).
- **Form validation** with inline field errors, plus live thousands-grouping in amount
  inputs.
- Docs: `docs/OVERVIEW.md` (architecture, data model, API, money model); rewritten README.

### Changed
- **Money is now integer đồng (VND), not cents.** Amounts are stored as whole đồng with no
  ×100 scaling (`540.000 ₫` → `540000`), matching how Vietnamese payment systems (e.g. MoMo)
  represent money. Eliminates the fractional-đồng artifact when splitting.
- App is **VND-only**; the currency input was removed and defaults to `₫`.
- Settlement math (`settle.ts`) resolves a mix of fixed amounts and weighted auto shares,
  guaranteeing shares sum exactly to the expense total.
- `DEV_MODE` moved out of `wrangler.toml` to a gitignored `.dev.vars` so the auth bypass
  can't be committed or shipped by accident.

### Schema
- `expenses`: renamed `amount_cents` → `amount_dong`; added `pay_bank`, `pay_account`,
  `pay_qr`.
- `splits`: added `amount_dong` (fixed per-member amount; NULL = auto by weight).

_Note: the money-unit and column changes are not backward-compatible with a 1.0.0 database.
The app is pre-release, so recreate the D1 tables from `schema.sql` rather than migrating._

## [1.0.0] — 2026-07-04

Initial release.

### Added
- Cloudflare Worker serving the Telegram bot webhook, JSON API, and no-build Mini App.
- Events, participants (with claim-your-name), and expenses.
- Weighted splits with largest-remainder distribution; greedy minimum-transfer settlement.
- Telegram `initData` HMAC verification; creator-only edit/delete on expenses.
- D1 schema and `wrangler` setup.
