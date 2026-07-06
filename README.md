# Tally — Telegram expense splitter (Cloudflare Workers + D1)

Split event expenses with weighted shares, right inside Telegram. One Cloudflare
Worker serves the bot webhook, the Mini App page, and the API. Data lives in D1
(Cloudflare's serverless SQLite). Free tier is far more than this needs, and it
never sleeps — so the webhook is always reachable.

```
src/index.ts      Worker entry: routing, CORS, static assets
src/telegram.ts   /webhook handler + Bot API helper
src/initData.ts   Telegram initData signature verification
src/api.ts        REST API (events, participants, expenses, splits, settle)
src/settle.ts     Weighted split + debt-simplification math (exact integer cents)
public/index.html The Mini App front-end (no build step)
schema.sql        D1 tables
wrangler.toml     Config (fill in the placeholders)
```

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
Copy the printed `database_id` into `wrangler.toml` (the `[[d1_databases]]` block),
then create the tables on the remote DB:
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
Note the deployed URL (e.g. `https://tally-expense-bot.<you>.workers.dev`).
Put it in `wrangler.toml` as `WEBAPP_URL`, then deploy once more so `/start`
can build the button:
```bash
npm run deploy
```

## 5. Point Telegram at the Worker
Register the webhook (Telegram will echo `WEBHOOK_SECRET` on every call so the
Worker can reject forgeries):
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-url>/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```
Set the Mini App as the bot's menu button so it opens from any chat (including
groups), then message your bot **/start**:
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{"menu_button":{"type":"web_app","text":"Tally","web_app":{"url":"https://<your-worker-url>"}}}'
```

That's it — open the bot, tap **Open Tally**, and create an event.

## How identity & permissions work
- The Mini App sends Telegram's signed `initData` on every API call. The Worker
  verifies the HMAC against your bot token (`src/initData.ts`), so it can trust
  who the acting user is without a login.
- Anyone in the group can open the app, **join** an event by tapping their name,
  and add expenses. An expense can only be **edited or deleted by the person who
  created it** — enforced server-side.
- Money is stored as integer cents; weighted shares are distributed with the
  largest-remainder method so totals reconcile to the exact penny.

## Local testing without Telegram
Set `DEV_MODE = "true"` in `wrangler.toml`, run `npm run dev`, and open the app
with a fake user in the query string:
```
http://localhost:8787/?dev=1:Aya
```
Change the number/name to simulate different group members. **Turn DEV_MODE off
before any real deploy** — it bypasses signature checks.

## Swapping in the fancier React UI
`public/index.html` is a plain, no-build front-end so you can deploy immediately.
To use the richer React version instead, build it with Vite, output to `public/`,
and reuse the same `/api/*` calls and the `Authorization: tma <initData>` header
shown in `index.html`.

## Free-tier notes
D1 free tier is ~5 GB storage and generous daily row limits; Workers free is
100k requests/day. This app's data is tiny and traffic is low, so you should sit
comfortably inside the free tier. Free tiers do change — confirm current numbers
on Cloudflare's pricing pages before relying on them.
