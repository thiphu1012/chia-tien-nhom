# Tally — Infrastructure Setup

End-to-end guide to standing up the infrastructure Tally runs on: a **Telegram bot**, a
single **Cloudflare Worker**, a **D1** database, and **Workers AI** for the natural-language
layer. Pairs with the quick-start in [`README.md`](../README.md) and the architecture in
[`OVERVIEW.md`](OVERVIEW.md).

Everything runs on free tiers. Budget ~15 minutes for a first-time setup.

## What you'll provision

```
Telegram (BotFather)          Cloudflare (one account)
  └─ bot token  ─────────┐      ├─ Worker            (serves /webhook, /api/*, Mini App)
  └─ @username           │      ├─ D1 database       (tally — events, expenses, splits, …)
                         └────► └─ Workers AI binding (parses "chia 540k cho A, B")
```

| Resource | Where it's created | Referenced in code as |
|---|---|---|
| Bot token | BotFather | secret `BOT_TOKEN` |
| Bot @username | BotFather | var `BOT_USERNAME` |
| Worker | `wrangler deploy` | the whole app (`src/index.ts`) |
| D1 database | `wrangler d1 create` | binding `DB`, `database_name = "tally"` |
| Workers AI | automatic (binding in `wrangler.toml`) | binding `AI`, var `AI_MODEL` |
| Webhook shared secret | you generate it | secret `WEBHOOK_SECRET` |

---

## 0 · Prerequisites

- **Node.js 18+** and npm
- A **Cloudflare account** (free) — <https://dash.cloudflare.com/sign-up>
- A **Telegram account**
- The repo cloned and dependencies installed:

```bash
git clone <your-fork-or-this-repo> tally-bot && cd tally-bot
npm install
```

All `wrangler` commands below use the locally-installed CLI via `npx` — no global install needed.

---

## 1 · Create the Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Give it a **display name** (e.g. `Tally`) and a **username** ending in `bot` (e.g. `TallyExpenseBot`).
3. BotFather returns a **token** like `123456:ABC-DEF...`. Keep it secret — this is `BOT_TOKEN`.
4. Note the **username without the `@`** (e.g. `TallyExpenseBot`) — this is `BOT_USERNAME`.

> **Leave group privacy mode ON (the default).** With privacy on, the bot in a group still
> receives: slash commands, messages that **@mention** it, and **replies** to its messages —
> which is exactly what the natural-language layer keys on. You do **not** need `/setprivacy`
> → Disable; doing so would make the bot read every group message (more noise, more cost) for
> no benefit here.

The menu button and command list need the Worker's URL, so we set those in **Step 8**, after deploy.

---

## 2 · Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account. Confirm with:

```bash
npx wrangler whoami
```

---

## 3 · Create the D1 database and apply the schema

```bash
npx wrangler d1 create tally
```

Copy the printed **`database_id`** into `wrangler.toml`, replacing the placeholder:

```toml
[[d1_databases]]
binding = "DB"
database_name = "tally"
database_id = "PASTE-DATABASE-ID-HERE"   # ← the id you just got
```

Create the tables (events, participants, expenses, splits, **pending_actions**, indexes):

```bash
npm run db:remote     # applies schema.sql to the remote D1
npm run db:local      # (optional) same, for the local dev database
```

> **Re-run `npm run db:remote` whenever `schema.sql` changes.** `schema.sql` uses
> `CREATE TABLE IF NOT EXISTS`, so re-applying is safe and idempotent — it adds anything
> missing (like `pending_actions`) without touching existing rows.

---

## 4 · Workers AI (nothing to create)

The `[ai]` binding is already declared in `wrangler.toml`:

```toml
[ai]
binding = "AI"
```

There's **no key and no provisioning** — Workers AI runs on Cloudflare's edge and is billed to
your account (**10,000 Neurons/day free**, enough for ~150–230 command parses/day). Pick the
parser model with the `AI_MODEL` var (see Step 5); the default is a good function-calling model.

---

## 5 · Configure vars and secrets

**Secrets** (encrypted, never in the repo) — set via Wrangler:

```bash
npx wrangler secret put BOT_TOKEN        # paste the BotFather token
npx wrangler secret put WEBHOOK_SECRET   # a random string, e.g. `openssl rand -hex 16`
```

> **`WEBHOOK_SECRET` is mandatory.** The webhook **fails closed** — if the secret is unset,
> it rejects every update with 403, because callback taps execute money writes. Generate one
> now; you'll hand the same value to Telegram in Step 7.

**Vars** (non-secret, in `wrangler.toml` under `[vars]`):

```toml
[vars]
WEBAPP_URL   = "https://tally-expense-bot.YOUR-SUBDOMAIN.workers.dev"  # set for real in Step 6
BOT_USERNAME = "TallyExpenseBot"                                       # your bot @username, no @
AI_MODEL     = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"              # swap freely
```

---

## 6 · First deploy, then set the real `WEBAPP_URL`

```bash
npm run deploy
```

Wrangler prints your Worker URL, e.g. `https://tally-expense-bot.your-subdomain.workers.dev`.
Put that into `wrangler.toml` as `WEBAPP_URL`, then **deploy again** so the Mini App button
points at the right origin:

```bash
npm run deploy
```

> **Why twice?** `WEBAPP_URL` is baked into the `/start` reply and the menu button, but you
> don't know the URL until the first deploy creates it. First deploy → learn URL → set it →
> redeploy. (Custom domain users can skip this by setting `WEBAPP_URL` to the domain up front.)

---

## 7 · Register the webhook

Point Telegram at the Worker, handing it the **same** `WEBHOOK_SECRET` from Step 5. Telegram
echoes it back on every update in the `X-Telegram-Bot-Api-Secret-Token` header, which the Worker
verifies.

**Shortcut (recommended):** copy `.env.example` → `.env`, fill in `BOT_TOKEN`, `WEBHOOK_SECRET`,
and `WEBAPP_URL` once, then run the Makefile target — no hand-editing tokens or URLs into a shell:

```bash
cp .env.example .env      # then edit .env with your values
make set-webhook          # Step 7
make webhook-info         # confirm: url set, empty last_error_message
```

Or the raw call:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-url>/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

Expect `{"ok":true,"result":true,"description":"Webhook was set"}`.

> **The `secret_token` here must byte-match `WEBHOOK_SECRET`.** A mismatch (or forgetting it)
> means every real Telegram update gets a 403 and the bot goes silent — see Troubleshooting.

---

## 8 · Set the menu button and command list

**Shortcut:** with `.env` filled in from Step 7, `make menu` does both calls below
(`make menu-button` and `make commands` run them individually).

Open the Mini App from any chat via the bot's menu button:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d '{"menu_button":{"type":"web_app","text":"Tally","web_app":{"url":"https://<your-worker-url>"}}}'
```

Register the slash commands so they autocomplete:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[
        {"command":"start","description":"Mở Tally"},
        {"command":"newevent","description":"Tạo sự kiện mới cho nhóm"},
        {"command":"addmember","description":"Thêm thành viên vào sự kiện"},
        {"command":"tally","description":"Xem/đổi sự kiện đang dùng"},
        {"command":"quyettoan","description":"Quyết toán: ai trả ai + thông tin chuyển khoản"},
        {"command":"help","description":"Hướng dẫn"}
      ]}'
```

---

## 9 · Verify end to end

**Webhook health:**

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Look for your `url`, `pending_update_count: 0`, and an empty `last_error_message`.

**Private chat (Mini App):** DM the bot **/start** → tap **Mở Tally** → create an event, add members.

**Group chat (natural language):**
1. Add the bot to a group.
2. Send **/tally** → tap the event to bind it to this chat.
3. Send **`@YourBot chia 540k cho Aya, Ben tính đôi`**.
4. The bot replies with a summary and **✅ Có / ❌ Không** → tap **✅** → it writes the split and posts the settlement.

If all four work, the infrastructure is live.

---

## 10 · Local development

Two things run locally differently:

- **The Mini App / API** can run fully offline via `DEV_MODE` (fake user, no Telegram).
- **The webhook + Workers AI** still need real credentials — AI inference runs against
  Cloudflare even in `wrangler dev`, and the webhook checks `WEBHOOK_SECRET`.

Create a gitignored `.dev.vars`:

```ini
DEV_MODE       = "true"
WEBHOOK_SECRET = "any-local-string"
BOT_TOKEN      = "123456:ABC..."     # only needed if you exercise the webhook/AI locally
```

Then:

```bash
npm run db:local     # local D1 tables
npm run dev          # http://localhost:8787
```

**Test the Mini App** as different fake users:

```
http://localhost:8787/?dev=1:Aya
http://localhost:8787/?dev=2:Ben
```

**Simulate a webhook update** (note the secret header — `DEV_MODE` does *not* bypass the
webhook; only the `/api/*` path honors `X-Dev-User`):

```bash
# /tally in a group — returns an event picker
curl -s localhost:8787/webhook \
  -H "X-Telegram-Bot-Api-Secret-Token: any-local-string" \
  -H "Content-Type: application/json" \
  -d '{"message":{"message_id":1,"from":{"id":111,"first_name":"Aya"},
       "chat":{"id":-1001,"type":"group"},"text":"/tally"}}'
```

To drive the natural-language path locally you'll need an event bound to that `chat.id`
(create one via the Mini App, then send the `t:bind:<eventId>` callback), after which a
`{"message":{…,"text":"@YourBot chia 100k cho Aya, Ben"}}` update produces a confirmation card.

> `wrangler dev` proxies the `AI` binding to Cloudflare, so local NL parsing needs a valid
> `wrangler login` (or an account token) and counts against your Neuron allocation.

---

## Environment reference

| Name | Kind | Set where | Example / default | Purpose |
|---|---|---|---|---|
| `BOT_TOKEN` | secret | `wrangler secret put` / `.dev.vars` | `123456:ABC...` | Call the Telegram Bot API; verify Mini App `initData` |
| `WEBHOOK_SECRET` | secret | `wrangler secret put` / `.dev.vars` | `openssl rand -hex 16` | Authenticate incoming webhook updates (fail-closed) |
| `WEBAPP_URL` | var | `wrangler.toml` | your `*.workers.dev` URL | Mini App origin used by `/start` + menu button |
| `BOT_USERNAME` | var | `wrangler.toml` | `TallyExpenseBot` (no `@`) | Detect group messages addressed to the bot |
| `AI_MODEL` | var | `wrangler.toml` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI model that parses commands |
| `DEV_MODE` | var | `.dev.vars` only | `"true"` | Local `X-Dev-User` bypass for `/api/*` — **never in prod** |
| `DB` | binding | `wrangler.toml` | `database_name = "tally"` | D1 database |
| `AI` | binding | `wrangler.toml` | `[ai] binding = "AI"` | Workers AI |
| `ASSETS` | binding | `wrangler.toml` | `directory = "./public"` | Serves the Mini App static files |

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Bot ignores everything; `getWebhookInfo` shows `last_error_message` about 403 | `secret_token` in `setWebhook` ≠ `WEBHOOK_SECRET`, or the secret isn't set. Re-run Step 5 then Step 7. |
| `getWebhookInfo` `url` is empty | Webhook never registered — run Step 7. |
| `pending_update_count` climbing | Worker erroring or slow; check `npx wrangler tail` for logs. |
| Bot silent in a **group** for plain text | Working as designed — it only acts when **addressed** (`@YourBot …` or a reply). Check `BOT_USERNAME` matches the real username exactly. |
| "Nhóm chưa chọn sự kiện" on every command | No event bound to this chat — run **/tally** and pick one. |
| "Bot đang bận, thử lại sau" | Workers AI timed out/failed. Retry; check `wrangler tail`; confirm the account has Workers AI access and Neuron budget. |
| `D1_ERROR: no such table: pending_actions` (or events) | Schema not applied — run `npm run db:remote` (and `db:local` for dev). |
| Mini App loads but API returns 401 | Not opened from Telegram (no `initData`) and `DEV_MODE` off. Use `/?dev=1:Name` locally, or open via the Telegram menu button. |
| Menu button / `/start` opens the wrong URL | `WEBAPP_URL` still a placeholder — set it and redeploy (Step 6). |

---

## Rotating or removing the webhook

**Rotate the secret** (e.g. if it leaked): set a new value and re-register — do both, or the
new secret won't match:

```bash
npx wrangler secret put WEBHOOK_SECRET        # new value
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-url>/webhook" -d "secret_token=<NEW_SECRET>"
```

**Remove the webhook** (e.g. to pause the bot):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook"
```

---

*See [`OVERVIEW.md`](OVERVIEW.md) for how these pieces talk to each other at runtime, and
[`../CLAUDE.md`](../CLAUDE.md) for the design invariants (identity, money model, confirm-before-write).*
