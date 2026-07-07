# Tally — Telegram expense splitter (Cloudflare Workers + D1)

Split shared event expenses **in Vietnamese đồng**, right inside Telegram. Create an
event, add expenses, choose who's included, split by **weight** or by **exact amount
per person**, attach **payment info** (bank/e-wallet or a transfer QR), and Tally
computes the minimum set of transfers to settle up.

One Cloudflare Worker serves the Telegram bot webhook, the JSON API, and the Mini App
page. Data lives in D1 (Cloudflare's serverless SQLite). The free tier is far more than
this needs, and the Worker never sleeps — so the webhook is always reachable.

```
src/index.ts      Worker entry: routing, CORS, static assets
src/telegram.ts   /webhook handler + Bot API helper
src/initData.ts   Telegram initData signature verification
src/api.ts        REST API (events, participants, expenses, splits, payment info, settle)
src/settle.ts     Weighted + fixed-amount split, debt simplification (exact integer đồng)
public/index.html The Mini App front-end (no build step, Vietnamese UI)
schema.sql        D1 tables
docs/OVERVIEW.md  Architecture, data model, API reference, money model
wrangler.toml     Config (fill in the placeholders)
```

## Features

- **Events & members.** Anyone in a Telegram group can open the app, create an event,
  add named members, and later **claim** their own name to link their Telegram account.
- **Add members anywhere.** From the event screen or mid-way through adding an expense.
- **Flexible splits.** Per expense, pick who's included and give each person a **weight**
  (×2 for someone paying for a partner), or type an **exact amount** for a member — the
  remaining total re-divides among the others automatically on blur.
- **Payment info per expense.** The payer can attach either a **bank/e-wallet + account
  number** (bank list sourced from the official VietQR/NAPAS set + MoMo, ZaloPay, Viettel
  Money, ShopeePay, VNPay) **or a transfer QR image**. It shows on the settle-up page.
- **Quyết toán (settle up).** A table of who-pays-whom with the fewest transfers; tap
  **Xem** on a row to see the recipient's payment info (copyable account, or QR to scan).
- **Vietnamese throughout**, including the bot's `/start` and `/help` messages.

## Money model

Money is stored as **integer đồng (VND)** — no ×100 "cents", exactly like MoMo's `Long`
amount, because the đồng has no sub-unit. `540.000 ₫` is stored as the integer `540000`.
Amounts are formatted the Vietnamese way (`.` groups thousands: `1.234.567 ₫`). Splits
use largest-remainder distribution so per-person shares always sum to the exact total.
See [`docs/OVERVIEW.md`](docs/OVERVIEW.md) for details.

## Prerequisites

- Node.js 18+
- A Cloudflare account (free)
- A Telegram bot token from **@BotFather** (`/newbot`)

## 1. Install

```bash
npm install
npx wrangler login
```

## 2. Create the database

```bash
npx wrangler d1 create tally
```

Copy the printed `database_id` into `wrangler.toml` (the `[[d1_databases]]` block), then
create the tables on the remote DB:

```bash
npm run db:remote
```

## 3. Set secrets

```bash
npx wrangler secret put BOT_TOKEN        # paste the BotFather token
npx wrangler secret put WEBHOOK_SECRET   # any random string, e.g. `openssl rand -hex 16`
```

## 4. Deploy

```bash
npm run deploy
```

Note the deployed URL (e.g. `https://tally-expense-bot.<you>.workers.dev`). Put it in
`wrangler.toml` as `WEBAPP_URL`, then deploy once more so `/start` can build the button:

```bash
npm run deploy
```

## 5. Point Telegram at the Worker

Register the webhook (Telegram echoes `WEBHOOK_SECRET` on every call so the Worker can
reject forgeries):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-url>/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

Set the Mini App as the bot's menu button so it opens from any chat (including groups),
then message your bot **/start**:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{"menu_button":{"type":"web_app","text":"Tally","web_app":{"url":"https://<your-worker-url>"}}}'
```

That's it — open the bot, tap **Mở Tally**, and create an event.

## Local development (no Telegram)

Dev mode swaps Telegram's signed `initData` for a fake user in the URL. Enable it via a
gitignored `.dev.vars` file (never in `wrangler.toml`):

```bash
echo 'DEV_MODE = "true"' > .dev.vars
npm run db:local          # create the local SQLite tables
npm run dev               # http://localhost:8787
```

Open the app with a fake user in the query string, and change the number/name to simulate
different group members:

```
http://localhost:8787/?dev=1:Aya
```

**`DEV_MODE` must never be set in a real deploy — it bypasses signature checks.** Keeping
it in `.dev.vars` (gitignored) ensures it can't be committed or shipped by accident.

## How identity & permissions work

- The Mini App sends Telegram's signed `initData` on every API call. The Worker verifies
  the HMAC against your bot token (`src/initData.ts`), so it can trust who the acting user
  is without a login.
- Anyone in the group can open the app, **join** an event by tapping their name, and add
  expenses. An expense can only be **edited or deleted by the person who created it** —
  enforced server-side.
- Identity always comes from the verified Telegram user, never from client input.

## Commands

- `npm run dev` — local Worker (needs `.dev.vars` with `DEV_MODE="true"`; open `/?dev=1:You`)
- `npm run deploy` — deploy to Cloudflare
- `npm run db:local` — apply `schema.sql` to the local D1 database
- `npm run db:remote` — apply `schema.sql` to the remote D1 database

## What's next

The natural-language "just tell the bot" layer (parse "chia 540k cho Aya, Ben, Chi" into a
confirmed action) is designed but not yet built. See the **Next steps** in `CLAUDE.md`.

## Free-tier notes

D1 free tier is generous, and Workers free is 100k requests/day. This app's data is tiny
and traffic is low, so you should sit comfortably inside the free tier. Free tiers change —
confirm current numbers on Cloudflare's pricing pages before relying on them.
