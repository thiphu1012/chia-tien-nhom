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
src/telegram.ts   /webhook handler + bot API helper (tg()); NL splits + bill-photo flow
src/initData.ts   Verifies Telegram Web App initData (HMAC-SHA256) -> trusted user
src/api.ts        REST API: events, participants, expenses, splits, claim, summary, drafts
src/settle.ts     Weighted-split + debt-simplification math (pure, integer đồng)
src/nl.ts         NL layer: "chia 540k cho Aya, Ben" -> split_expense args (pure + 1 AI call)
src/receipt.ts    Bill-photo layer: vision parse -> line items (pure + 1 AI call)
public/index.html Deployable Mini App front-end (no build)
prototype/…jsx    React design prototype (reference only)
schema.sql        D1 tables
docs/OVERVIEW.md  Architecture, data model, API reference, money model
wrangler.toml     Bindings + vars (placeholders to fill in)
```

## Design decisions (keep these invariants)
- **Money is integer đồng everywhere in storage and math** — VND has no sub-unit, so
  amounts are stored as whole đồng with NO ×100 scaling (`540.000 ₫` → `540000`), exactly
  like MoMo's `Long` amount. The app is VND-only. Never do float arithmetic on balances.
  (History: money used to be integer *cents* ×100; that was dropped because it invented
  fractional đồng when splitting a zero-decimal currency.)
- **Weighted splits use largest-remainder distribution** (`splitCents` in `settle.ts`)
  so per-person shares sum to the exact total — no lost or invented đồng. There are
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
Backend + no-build Mini App are complete and deployable. The app is **VND-only** with
money stored as integer đồng. Shipped since 1.0.0: full Vietnamese UI, add-member flows,
fixed per-member split amounts (alongside weights), payment info per expense, inline
validation, the **natural-language layer** (`src/nl.ts` — Workers AI function calling with
an inline Yes/No confirm card via `pending_actions`), and the **bill-photo flow**
(`src/receipt.ts` — photo in chat → Workers AI vision parse → `pending_actions` draft →
Mini App review screen at `?draft=<id>` → confirm writes 1 expense per item in one D1
batch). Weights are `REAL` in half-steps (0.5 = came late, 2 = covers a partner).
Chat commands to manage a chat's events from Telegram: `/newevent`, `/tally` (switch
active event), `/addmember <names>` (add name-only participants to the active event;
comma/`và`-separated, deduped, linked to a real user later via `ensureParticipant`),
and `/quyettoan` (pick an event → post the settlement as a Telegram HTML message with
two tap-to-copy `<pre>` blocks: "ai trả ai" + transfer info). **Transfer info is
per-member**, not per-expense: `participants.pay_bank/pay_account/pay_qr`, set once in
the Mini App's "Thông tin chuyển khoản" section (or PUT `.../payment`) and reused across
the event; `summaryText`/`settlementMessageHTML` read the creditor's participant value
and fall back to the legacy per-expense value (migration 0002 backfills). Not yet done:
the optional MCP path.

## Bill-photo flow invariants (keep these too)
- The vision model returns amounts **as printed strings**; only `parsePrintedAmount` in
  `src/receipt.ts` converts them (dot/comma are THOUSANDS separators — `540.000` = 540000).
  Never let `parseFloat`/`Number` near a printed amount.
- The model's parse is a pre-fill. The **user-edited payload** from the review screen is
  what gets validated and written; drafts are consumed atomically and expire in 60 min.
- Model-derived strings (item names) are untrusted: `esc()` on render, cap/sanitize on write.
- **VAT / service fees / discounts are deliberately NOT modeled yet** — the OCR path
  extracts line items + the printed total only. `reconciled` (Σ items === printed total)
  is just an FYI flag; a bill with tax/fees will read as unreconciled, and the review
  screen shows that as a soft "chênh lệch do thuế/phí" note, not an error.

## Next steps (planned)
1. **Bill-photo accuracy pass.** Collect real VN receipts; if the free Workers AI vision
   model misreads too often (watch the review screen's edit rate), swap `AI_VISION_MODEL`
   or add a paid Claude-via-AI-Gateway provider behind the same `src/receipt.ts` seam —
   see `brainstorm/bill-ocr-model-picking.html` for the researched comparison.
2. **Optional: MCP server (Option B).** Wrap the bot's tools (`split_expense`, receipt
   parsing) as a remote MCP server using Cloudflare's Agents SDK (`createMcpHandler` /
   `McpAgent`, Streamable HTTP at `/mcp`), so they're reusable by other MCP clients
   (Claude Desktop, etc.). Only do this if reuse is wanted.
3. **Settlement & payment tracking** (turn the settle-up math into a tracked
   get-people-paid loop). Ship in two phases:
   - **Phase 1 — split + notify (next).** The settlement is already computed
     (`settle()` in `settle.ts`, run on load). Add a "notify members to pay" step:
     post the settle-up summary straight into the group chat (`sendMessage` /
     `answerWebAppQuery`) instead of copy-paste, listing who owes whom. Make it
     actionable — surface the creditor's payout details (`pay_bank`/`pay_account`/
     `pay_qr`, today per-expense) so a debtor can pay on the spot. **Constraint:** a
     bot can't cold-DM a user, so notifications are a *group message* that @mentions
     only **claimed** participants (`user_id` set); name-only rows are just named.
     No new persistence needed — Phase 1 only posts.
   - **Phase 2 — paid/received handshake (roadmap, later).** Persist settlement and
     give it a lifecycle: a `settlements`/`payments` table + a two-sided handshake —
     debtor taps "Tôi đã trả" (`pending → claimed`), creditor/admin taps "Đã nhận"
     (`claimed → confirmed`), plus an admin (event `created_by`) override to mark
     paid (cash / unresponsive members) and a Mini App status board. Reuses the
     `pending_actions` atomic status-update (`UPDATE … WHERE status='pending'`) and
     callback authz (`cq.from.id === row.user_id`) patterns. **Open decisions:**
     (a) freeze-on-finalize + lock the event (snapshot the transfer set) vs a payment
     ledger that nets down and keeps the event open — the settle output is derived,
     so marking a specific transfer paid pins down something the math wants fluid;
     (b) who confirms receipt — recommend the *creditor* confirms their own incoming
     payments, with the event creator as an admin backstop.
4. **Remove the expense editor's pay fields (deferred cleanup).** Transfer info moved
   to the participant (per-member section); the expense form still has the old
   `payMode/payBank/payAccount/payQr` inputs as a non-breaking fallback. Once the
   per-member section is confirmed in the live app, drop those inputs from `renderEditor`
   /`newExpense`/`editExpense`/`saveExpense` (and stop sending pay fields on expenses).
   `payInfosFor`/`summaryText` already prefer the participant value, so removal is safe.

## Useful commands
- `npm run dev` — local Worker (set DEV_MODE=true, open `/?dev=1:You`)
- `npm run deploy` — deploy to Cloudflare
- `npm run db:remote` — apply `schema.sql` to the remote D1 database
- Full first-time setup (D1 create, secrets, webhook, menu button): see `README.md`
