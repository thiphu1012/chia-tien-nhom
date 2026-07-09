# Tally — Architecture & Reference

Technical overview of how Tally is put together: the request flow, data model, money
model, split math, API, and the security invariants. Pairs with the user-facing
[`README.md`](../README.md) and the working notes in [`CLAUDE.md`](../CLAUDE.md).

## Request flow

One Cloudflare Worker (`src/index.ts`) serves three things off one origin:

```
Telegram ──POST /webhook──►  src/telegram.ts   bot commands (/start, /help)
Browser  ──/api/*─────────►  src/api.ts        REST API, auth'd per request
Browser  ──everything else►  env.ASSETS         public/index.html (the Mini App)
```

## Identity (the trust anchor)

The client never states who it is. The Telegram Mini App hands the page a signed
`initData` blob; the page sends it as `Authorization: tma <initData>`. The Worker
re-verifies the HMAC-SHA256 signature against `BOT_TOKEN` on every request
(`src/initData.ts`) and rejects data older than 24h. Only then is the user trusted.

`DEV_MODE` enables an `X-Dev-User` header bypass for local testing (set in a gitignored
`.dev.vars`). It skips signature verification and must be off in any real deploy.

## Data model (`schema.sql`)

```
users         Telegram accounts (id, first_name, username)
  │
events        a trip/dinner (title, currency, created_by, chat_id)
  │
participants  a NAME in an event; user_id is NULL until someone "claims" it
  │
expenses      what was spent (amount_dong, paid_by→participant, created_by→user,
  │           pay_bank, pay_account, pay_qr)
  │
splits        per expense, per participant: included, weight, amount_dong (fixed override)
```

Key idea: **participants are names, not accounts.** You can create an event with
"Ben, Chi, Duc" before any of them open the app. When Ben opens it, he *claims* the
"Ben" participant, linking his verified Telegram `user_id`. That's why `paid_by` points
at a participant (a name) while `created_by`/permissions point at a real Telegram user.

## Money model — integer đồng

Money is stored as **integer đồng (VND)**. VND has no sub-unit in circulation, so there is
**no ×100 scaling**: `540.000 ₫` is the integer `540000` — the same representation MoMo's
payment API uses (`amount` is a `Long` of whole đồng). This replaced an earlier
integer-*cents* model, which invented fractional đồng when splitting (e.g. `100.000 ₫ ÷ 3`).

- Conversion happens only at the API boundary (`toDong` in `src/api.ts`).
- Display uses Vietnamese formatting — `.` groups thousands: `fmtVN(1234567) → "1.234.567"`.
- The app is VND-only; the currency field was removed from the UI and defaults to `₫`.

## Split math (`src/settle.ts`, pure integer đồng)

Every event load recomputes balances and settlement from scratch. Three ideas:

1. **`splitCents(total, weights)`** — divides an integer total into weighted parts that sum
   *exactly* to the total, using **largest-remainder** (floor everyone, hand leftover đồng to
   the largest fractional remainders). No lost or invented đồng.

2. **`resolveShares(total, incl)`** — resolves each included member's share allowing a mix of
   **fixed amounts** and **weighted auto shares**: locked members keep their `amount`; the
   remaining total divides among the rest by weight via `splitCents`. The last member absorbs
   any discrepancy so shares **always sum to the total** (keeps net balances zero-sum even on
   inconsistent input — the UI validates before it gets that far).

3. **`netBalances` / `settle`** — per-person net position (sums to 0), then greedy
   minimum-transfer settlement (match biggest debtor to biggest creditor).

## Payment info

Per expense, the payer can attach payment details (optional), shown on the settle-up page
for whoever receives money:

- **Manual:** `pay_bank` (a bank from the official VietQR/NAPAS list, or an e-wallet —
  MoMo, ZaloPay, Viettel Money, ShopeePay, VNPay) + `pay_account` (account no. / phone).
- **Image:** `pay_qr`, a transfer QR the payer uploads. It's shrunk client-side to a small
  data URL (PNG, ≤440px, JPEG fallback for photos) and stored in D1; the server caps it at
  400 KB and validates the data-URL/URL shape. (R2 is the upgrade path for full-size files.)

On **Quyết toán**, a person's payment info is gathered from the expenses they paid
(de-duplicated) and surfaced behind the **Xem** button per settle row.

## API reference

All routes require a verified user (via `initData` or the dev bypass). Money in request
and response bodies is in whole đồng.

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/me` | the acting user |
| GET    | `/api/events` | events I created or joined, with totals |
| POST   | `/api/events` | create an event (`{title, participantNames[]}`; currency defaults to ₫) |
| GET    | `/api/events/:id` | full event: participants, expenses, balances, settlement |
| POST   | `/api/events/:id/participants` | add a member (`{name}`) |
| POST   | `/api/events/:id/claim` | link myself to a participant (`{participantId}`) |
| GET    | `/api/events/:id/summary` | shareable settle-up text (incl. bank/account lines) |
| POST   | `/api/events/:id/expenses` | add an expense (see body below) |
| PUT    | `/api/expenses/:id` | edit an expense (creator only) |
| DELETE | `/api/expenses/:id` | delete an expense (creator only) |
| GET    | `/api/drafts/:id` | a parsed bill-photo draft + its event (uploader only, 60-min TTL) |
| POST   | `/api/drafts/:id/confirm` | write the user-edited items, one expense per item (atomic) |

Expense body:

```jsonc
{
  "title": "Lẩu",
  "amount": 100000,                // whole đồng
  "paidBy": "<participantId>",
  "splits": [
    { "participantId": "...", "included": true, "weight": 1, "amount": null },     // auto
    { "participantId": "...", "included": true, "weight": 1, "amount": 50000 }     // fixed
  ],
  "payBank": "Vietcombank",        // optional (manual mode)
  "payAccount": "0123456789",      // optional (manual mode)
  "payQr": "data:image/png;base64,..."  // optional (image mode)
}
```

## Bill-photo flow (receipt scanning)

Send the bot a photo of a bill (private chat, or in a group with an `@mention` caption /
reply-to-bot). The webhook downloads the largest photo size, has the Workers AI vision
model (`AI_VISION_MODEL`) transcribe line items **verbatim as printed**, and normalizes
them in `src/receipt.ts` — printed `540.000` is parsed with dot/comma as *thousands*
separators, so it lands as the integer `540000` đồng. Only line items and the printed
total are extracted; VAT / service fees / discounts are deferred (not itemized yet), so a
bill with tax/fees reads as "unreconciled" — surfaced as a soft note, not an error. The result is stored as a
`pending_actions` row (`tool='receipt_items'`, 60-min TTL) and the bot replies with a
button that deep-links into the Mini App review screen (`?draft=<id>` in private chats,
`https://t.me/<bot>?startapp=draft_<id>` in groups). There the uploader edits items,
taps members onto each item, sets per-member weights (half-steps: 0.5 came late, 2 covers
a partner), and confirms — the server validates the **user-edited** payload, consumes the
draft atomically, and inserts one expense per item in a single D1 batch (all-or-nothing).
The model never writes money and never sets identity; the uploader is the payer.

## Invariants to preserve

- **Money is integer đồng everywhere** in storage and math. Convert only at the API edge.
  Never do float arithmetic on balances.
- **Splits sum to the exact total** (largest-remainder + last-member reconciliation).
- **Identity comes only from verified Telegram `initData`** — never from client input.
- **Permissions:** anyone can add expenses; only the creator edits/deletes their own.
- **`DEV_MODE` off in production** — it bypasses signature checks.

## What's not built yet

The natural-language layer (parse a chat message into a confirmed `split_expense` /
`add_expense` / `settle_up` action via an LLM with tools) and the optional MCP server.
See **Next steps** in `CLAUDE.md`.
