<h1 align="center">Tally · chia tiền nhóm</h1>

<p align="center">
  <strong>Split shared expenses in a Telegram group — in Vietnamese đồng, settled with the fewest transfers.</strong>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.1.0-157F5B">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Telegram Mini App" src="https://img.shields.io/badge/Telegram-Mini%20App-26A5E4?logo=telegram&logoColor=white">
</p>

Tally is a Telegram Mini App for splitting the bill on a trip or dinner. Create an event,
add expenses, pick who's in and how much each person owes (evenly, by weight, or an exact
amount), and Tally works out the **minimum set of transfers** to make everyone even — with
each person's bank/QR shown right on the settle-up screen. It runs entirely on one
Cloudflare Worker, so there's nothing to install and no account to create beyond Telegram.

<p align="center"><em>📱 Screenshot / demo GIF goes here — capture the <strong>Quyết toán</strong> screen and save it to <code>docs/screenshot.png</code>, then reference it above this line.</em></p>

## Highlights

- **Lives inside Telegram** — zero install, zero new account; identity comes from the group chat.
- **VND-native** — money is whole đồng (no fake "cents"), formatted the Vietnamese way (`1.234.567 ₫`), the same way MoMo represents amounts.
- **Flexible splits** — even, **weighted** (×2 for someone paying for a partner), or a **fixed amount per person**; the rest auto-divides so shares always sum to the exact total.
- **Payment info at settle-up** — attach a **bank/e-wallet + account** (official VietQR bank list + MoMo, ZaloPay, Viettel Money, ShopeePay, VNPay) or a **transfer QR image**; tap **Xem** on a settle row to see it.
- **Fewest transfers** — greedy debt simplification over exact integer balances.
- **Trustworthy by design** — identity is verified from Telegram's signed `initData` (never the client); only an expense's creator can edit it, and you pay for what you add.
- **No build step** — the front-end is a single dependency-free `public/index.html`.

## How it works

One Cloudflare Worker serves three things off one origin, backed by D1 (serverless SQLite):

```
Telegram ──POST /webhook──►  bot commands (/start, /help)      src/telegram.ts
Browser  ──/api/*─────────►  REST API, auth'd per request      src/api.ts
Browser  ──everything else►  the Mini App page                 public/index.html
```

Money is stored as **integer đồng**; splits use largest-remainder distribution so no đồng is
lost or invented; settlement nets everyone to zero and finds the minimum transfers. For the
full architecture, data model, API reference, and money model, see **[`docs/OVERVIEW.md`](docs/OVERVIEW.md)**.

## Quick start (local, no Telegram)

Dev mode swaps Telegram's signed `initData` for a fake user in the URL.

```bash
npm install
echo 'DEV_MODE = "true"' > .dev.vars   # gitignored; enables the X-Dev-User dev bypass
npm run db:local                       # create the local SQLite tables
npm run dev                            # serves http://localhost:8787
```

Open the app as a fake user and change the number/name to simulate different group members:

```
http://localhost:8787/?dev=1:Aya
```

> ⚠️ `DEV_MODE` bypasses signature verification — keep it in `.dev.vars` (gitignored) and
> **never** enable it in a real deploy.

## Deploy to production

> For a step-by-step infrastructure walkthrough (BotFather, D1, Workers AI, secrets, webhook,
> menu button, verification, and troubleshooting), see **[`docs/SETUP.md`](docs/SETUP.md)**.
> The condensed version follows.

You'll need a Cloudflare account (free) and a bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install && npx wrangler login

# 1. Database — paste the printed database_id into wrangler.toml, then:
npx wrangler d1 create tally
npm run db:remote

# 2. Secrets
npx wrangler secret put BOT_TOKEN        # the BotFather token
npx wrangler secret put WEBHOOK_SECRET   # any random string, e.g. `openssl rand -hex 16`

# 3. Deploy, put the printed URL into wrangler.toml as WEBAPP_URL, then deploy again
npm run deploy
```

Point Telegram at the Worker (the bot menu button opens the Mini App from any chat):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-url>/webhook" -d "secret_token=<WEBHOOK_SECRET>"

curl "https://api.telegram.org/bot<BOT_TOKEN>/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{"menu_button":{"type":"web_app","text":"Tally","web_app":{"url":"https://<your-worker-url>"}}}'
```

Message your bot **/start**, tap **Mở Tally**, and create an event.

## Natural-language commands (bot)

Beyond the Mini App, the bot understands plain-text splits like
**"chia 540k cho Aya, Ben tính đôi"** — it parses them with **Cloudflare Workers AI**
(no external key; billed via your Cloudflare account, 10k Neurons/day free) and **always
asks for a Yes/No confirmation before writing**.

- Set **`BOT_USERNAME`** in `wrangler.toml` to your bot's @username (without the `@`).
  In group chats the bot keeps Telegram privacy mode **on**, so it only acts on messages
  addressed to it (`@YourBot chia …`) or replies to it.
- Pick the parser model via **`AI_MODEL`** (any function-calling Workers AI model; swappable
  with no code change). The `[ai]` binding is already in `wrangler.toml`.
- Per group chat, run **/tally** once to pick which event the chat is bound to.
- **`WEBHOOK_SECRET` is now required** — the webhook fails closed (rejects all updates) if it
  is unset, since callback taps execute money writes. To exercise the webhook locally, add
  `WEBHOOK_SECRET="…"` to `.dev.vars` and send it as the `X-Telegram-Bot-Api-Secret-Token`
  header on your test POSTs.

## Bill-photo scanning (bot)

Send the bot a **photo of a bill** (in a group: with an `@YourBot` caption or as a reply
to the bot) and it reads the line items with a **Workers AI vision model**
(`AI_VISION_MODEL` in `wrangler.toml`, free tier), then replies with a button that opens
a **review screen** in the Mini App: fix any misread names/amounts, tap who had each item,
set weights (0,5 for someone who came late — ×2 for someone covering a partner), and save.
Each item becomes a normal expense paid by the uploader. Nothing is written until you
confirm; drafts expire after 60 minutes.

> **Group deep links:** the review button in group chats uses
> `https://t.me/<bot>?startapp=…`, which requires enabling your bot's **Main Mini App**
> in BotFather (*Bot Settings → Configure Mini App*) pointed at your Worker URL. Private
> chats work without this.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local Worker (needs `.dev.vars` with `DEV_MODE="true"`; open `/?dev=1:You`) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run db:local` | Apply `schema.sql` to the local D1 database |
| `npm run db:remote` | Apply `schema.sql` to the remote D1 database |

## Project structure

```
src/index.ts      Worker entry: routing, CORS, static-asset fallback
src/telegram.ts   /webhook handler + Telegram Bot API helper (NL splits, bill photos)
src/initData.ts   Verifies Telegram Web App initData (HMAC-SHA256)
src/api.ts        REST API: events, participants, expenses, splits, payment info, settle, drafts
src/settle.ts     Weighted + fixed-amount split, debt simplification (pure integer đồng)
src/receipt.ts    Bill-photo parsing: vision model transcribes, pure code does the numbers
public/index.html The deployable Mini App front-end (no build, Vietnamese UI)
schema.sql        D1 tables
docs/OVERVIEW.md  Architecture, data model, API reference, money model
wrangler.toml     Bindings + vars (fill in the placeholders)
```

**Tech stack:** Cloudflare Workers · D1 (SQLite) · TypeScript · Wrangler · plain HTML/JS front-end.

## Documentation

- **[`docs/OVERVIEW.md`](docs/OVERVIEW.md)** — architecture, data model, full API reference, money model, security invariants.
- **[`CHANGELOG.md`](CHANGELOG.md)** — version history.
- **[`CLAUDE.md`](CLAUDE.md)** — working notes, design decisions, and planned next steps.

## Roadmap

- **Natural-language layer** — parse a chat message like *"chia 540k cho Aya, Ben, Chi"* into a
  confirmed `split_expense` action via an LLM with tools (identity stays the verified Telegram user).
- Optional **MCP server** exposing the same tools to other clients.
- Post the settle-up summary straight into the group chat.

## Getting help

- Read [`docs/OVERVIEW.md`](docs/OVERVIEW.md) for how the pieces fit together.
- Found a bug or have a request? [Open an issue](https://github.com/thiphu1012/chia-tien-nhom/issues).

## Contributing

Contributions are welcome. Please:

1. Keep money in **integer đồng** and identity **from verified Telegram `initData`** (see the invariants in [`docs/OVERVIEW.md`](docs/OVERVIEW.md) / [`CLAUDE.md`](CLAUDE.md)).
2. Run `npx tsc --noEmit` before opening a PR; keep the front-end dependency-free.
3. Open an issue to discuss larger changes first.

## Maintainer

Built and maintained by **Thi Ngọc Phú** ([@thiphu1012](https://github.com/thiphu1012)).

## License

No license has been set yet — the project is currently unlicensed (all rights reserved). Add a
`LICENSE` file (e.g. MIT) if you intend for others to reuse the code.
