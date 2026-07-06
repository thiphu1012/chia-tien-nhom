# CLAUDE.md — project context for Claude Code

## What this is
**Tally** — a Telegram Mini App for splitting shared event expenses with *weighted*
shares (someone can count as ×2, e.g. paying for a partner). Users create an event,
add expenses, pick who's included and each person's weight, and the app computes the
minimum set of transfers to settle up. Built to run inside Telegram group chats.

## Stack
- **Cloudflare Workers** (single Worker) serves everything: the Telegram bot webhook,
  the JSON API, and the Mini App static page.
- **Cloudflare D1** (serverless SQLite) for storage.
- **No build step** front-end: `public/index.html` is plain HTML/JS wired to the API.
- A richer **React prototype** lives in `prototype/tally-mini-app.jsx` (design reference;
  not yet wired to the API — see "Next steps").
- Language: TypeScript. Deploy/dev via `wrangler`. See `README.md` for full setup.

## File map
```
src/index.ts      Worker entry: routing, CORS, static-asset fallback
src/telegram.ts   /webhook handler + Telegram Bot API helper (tg())
src/initData.ts   Verifies Telegram Web App initData (HMAC-SHA256) -> trusted user
src/api.ts        REST API: events, participants, expenses, splits, claim, summary
src/settle.ts     Weighted-split + debt-simplification math (pure, integer cents)
public/index.html Deployable Mini App front-end (no build)
prototype/…jsx    React design prototype (reference only)
schema.sql        D1 tables
wrangler.toml     Bindings + vars (placeholders to fill in)
```

## Design decisions (keep these invariants)
- **Money is integer cents everywhere in storage and math.** Convert to/from decimals
  only at the API boundary. Never do float arithmetic on balances.
- **Weighted splits use largest-remainder distribution** (`splitCents` in `settle.ts`)
  so per-person shares sum to the exact total — no lost or invented pennies. There are
  informal checks in that file's logic; keep them passing if you refactor.
- **Settlement = greedy minimum transfers** over net balances (which sum to zero).
- **Identity is trusted, and comes from Telegram — never from user input or an LLM.**
  `src/initData.ts` verifies the signed `initData`; `api.ts` derives the acting user
  from it. Any future natural-language layer must keep this: the model may fill in
  business args (amount, members), but the *who* is always the verified Telegram user.
- **Permissions:** anyone in the event can add expenses; an expense can only be edited
  or deleted by its creator (`created_by`). Enforced server-side in `api.ts`.
- **DEV_MODE** (`wrangler.toml` var) enables an `X-Dev-User` header bypass for local
  testing without Telegram. It must be OFF in any real deploy — it skips signature checks.

## Conventions
- Prefer small, focused API handlers; keep the settlement/share math pure in `settle.ts`.
- Keep the front-end dependency-free (no framework/build) unless we deliberately switch
  to the React version — in which case build with Vite, output to `public/`, and reuse
  the same `/api/*` calls and `Authorization: tma <initData>` header.
- Secrets (`BOT_TOKEN`, `WEBHOOK_SECRET`) via `wrangler secret put`, never committed.

## Current status
Backend + no-build Mini App are complete and deployable. Not yet done: the
natural-language layer and the optional MCP path.

## Next steps (planned)
1. **Natural-language "just tell the bot" layer (start here).** In the webhook, after
   the trusted Telegram user and message text are known, call an LLM with tool/function
   definitions and let it map e.g. "split 540k among Aya, Ben, Chi" to a tool call.
   - Tools to expose (few, goal-shaped): `split_expense`, `add_expense`, `settle_up`.
   - Pass the event's participant list into the prompt for name→ID resolution; in groups,
     prefer resolving `@mentions` from Telegram message entities (real user IDs).
   - **Confirm before writing** any money mutation: reply with an inline Yes/No keyboard
     summarizing the parsed action; only commit on Yes.
   - Identity stays trusted (see invariant above) — the model never sets the user.
   - Model options: Anthropic Messages API with `tools` (native function calling), or
     Cloudflare Workers AI to stay on-platform.
2. **Optional: MCP server (Option B).** Wrap the same three tools as a remote MCP server
   using Cloudflare's Agents SDK (`createMcpHandler` / `McpAgent`, Streamable HTTP at
   `/mcp`), so the tools are reusable by other MCP clients (Claude Desktop, etc.). The
   tool schemas from step 1 should map over almost 1:1. Only do this if reuse is wanted.
3. Consider posting the settle-up summary straight into the group chat (Telegram
   `answerWebAppQuery` / `sendMessage`) instead of copy-paste.

## Useful commands
- `npm run dev` — local Worker (set DEV_MODE=true, open `/?dev=1:You`)
- `npm run deploy` — deploy to Cloudflare
- `npm run db:remote` — apply `schema.sql` to the remote D1 database
- Full first-time setup (D1 create, secrets, webhook, menu button): see `README.md`
