# Tally — every Telegram chat scenario

A complete map of what can happen when the bot receives a Telegram update, traced from
the real dispatch in `src/telegram.ts` (`handleWebhook` → `processUpdate`) through
`nl.ts`, `receipt.ts`, and `api.ts`. Use it to spot gaps, write tests, or design new
flows.

**Legend**
- **Trigger** — the incoming Telegram update / user action.
- **Bot behaviour** — what the user sees.
- **Where** — handler and/or the `log()` breadcrumb `evt` you'd see in Workers Logs.
- 🟢 happy path · 🟡 handled edge · 🔴 error/abuse · ⚪ deliberately ignored · 🧭 design gap

---

## 0 · The dispatch tree

Every update funnels through one router. Knowing this tree tells you *why* a message got
the response it did.

```
POST /webhook
 └─ handleWebhook()
     ├─ secret header ≠ WEBHOOK_SECRET ─────────────► 403  (wh.reject)   🔴
     ├─ body not JSON ──────────────────────────────► "ok", dropped      ⚪
     └─ ack "ok" immediately, run processUpdate() in ctx.waitUntil       🟢
          └─ processUpdate()   (log: wh.recv {kind})
              ├─ update.callback_query ──► handleCallback()   [button taps]
              ├─ msg.photo ─────────────► handleReceiptPhoto() [bill photo]
              ├─ msg.text "/…" ─────────► slash command
              ├─ msg.text (addressed) ──► handleNl()          [NL split]
              └─ anything else ─────────► ignored             ⚪
```

Two rules govern *whether the bot reacts at all*:
- **Ack-first:** the HTTP request always gets `"ok"` in milliseconds; the real work runs
  in the background (`ctx.waitUntil`). A slow LLM call can't make Telegram retry.
- **`addressedToBot()`** — in a **private** chat, everything is addressed to the bot. In a
  **group**, only a leading `@BOT_USERNAME` mention *or* a reply to the bot counts
  (Telegram privacy mode stays ON). Ordinary group chatter is invisible to the bot.

---

## 1 · Webhook level (before dispatch)

| # | Trigger | Bot behaviour | Where |
|---|---|---|---|
|1.1|🔴 Forged/misconfigured update, wrong `X-Telegram-Bot-Api-Secret-Token`|Rejected with **403**, nothing runs|`handleWebhook` · `wh.reject`|
|1.2|⚪ Body isn't valid JSON|Returns `"ok"`, silently dropped|`handleWebhook`|
|1.3|🟢 Valid update|Acked instantly, processed in background|`wh.recv`|

---

## 2 · Onboarding & help

| # | Trigger | Bot behaviour | Where |
|---|---|---|---|
|2.1|🟢 `/start` (or `/split`) in **private**|Welcome text + **💸 Mở Tally** `web_app` button (opens Mini App)|`sendStart` (private branch) · `cmd`|
|2.2|🟢 `/start` in a **group**|Text telling them to use the menu button ☰ or `/tally` (no `web_app` button — those only work in private)|`sendStart` (group branch)|
|2.3|🟢 `/help`|How-to text: `/start`, `/tally`, and the `@bot chia …` example|`sendHelp`|
|2.4|🟢 Tap the bot's **menu button ☰**|Mini App opens (Telegram-side; not a webhook update)|`setChatMenuButton` config|

---

## 3 · Events: create, list, switch  ✅

> **Implemented** — migration `0001_multi_event_per_chat`. A chat **owns many events** and
> switches between them, and you can **create events from chat**. Model: each event has a
> permanent `events.home_chat_id` (the owning chat), and `chat_active_event(chat_id, event_id)`
> is the pointer to the one that's live. Switching moves the pointer; it never disturbs the
> roster. This preserves every invariant — the event is still the settlement container, and
> identity still comes from Telegram.

| # | Trigger | Bot behaviour | Where |
|---|---|---|---|
|3.1|🟢 `/newevent Đà Lạt 3 ngày`|Creates an event **owned by the chat**, makes it active, adds you as first participant|`handleNewEvent` → `createEventForChat` · `event.new`|
|3.2|🟡 `/newevent` with no name|"Đặt tên sự kiện nhé: /newevent Đà Lạt 3 ngày"|`handleNewEvent`|
|3.3|🟢 `/tally`|Lists **the chat's** events (✓ marks the active one) → tap to switch|`handleTally` → `eventsForChat`|
|3.4|🟡 `/tally`, chat has none|"Nhóm chưa có sự kiện nào. Tạo bằng: /newevent…"|`handleTally` (empty)|
|3.5|🟢 Tap an event (`t:bind:<id>`)|Moves the active pointer → "✅ Nhóm này giờ dùng: <title>"|`handleBind` → `bindEventToChat` · `bind.ok`|
|3.6|🟢 Bind an old Mini-App event (no home yet)|**Adopted** into the chat (`home_chat_id` set) + made active — keeps pre-migration events usable|`bindEventToChat` (adopt branch)|
|3.7|🔴 Tap-bind an event not in this chat and not yours|"Không chọn được sự kiện này" alert|`handleBind` (authz via `eventsForChat`)|

**Under the hood:** `resolveEventForChat` joins through `chat_active_event`, so every NL split
and bill photo lands on the currently-active event. `eventsForChat` returns the chat's events
**plus** the caller's own events with no home yet (the adoption bridge), which is also the authz
set `handleBind` checks against.

---

## 4 · Natural-language split — the request

Text addressed to the bot, routed to `handleNl`. (Private: any text. Group: `@bot …` or a
reply.)

| # | Trigger | Bot behaviour | Where |
|---|---|---|---|
|4.1|🟢 `@bot chia 540k cho Aya, Ben`|Parses → **confirm card** with ✅ Có / ❌ Không|`handleNl` → `parseWithAI` → `buildSplitArgs` · `nl.pending`|
|4.2|🟢 `@bot chia 540k cho Aya, Ben tính đôi`|Same, Ben shown as **×2** in the card|weight parsing · `nl.built {n}`|
|4.3|🟡 No bound event|"Nhóm chưa chọn sự kiện. Gõ /tally để chọn nhé."|`nl.noevent`|
|4.4|🟡 Not a split ("hello", "cảm ơn")|Model returns no tool call → "Mình chưa hiểu 🤔…"|`nl.parsed {tool:false}`|
|4.5|🔴 AI timeout / error (12s, 1 retry)|"Bot đang bận, thử lại sau nhé 🙏"|`err {where:"nl.parse"}`|
|4.6|🟡 Parsed but **no amount**|"Mình không rõ số tiền…"|`nl.built {err:"no_amount"}`|
|4.7|🟡 Parsed but **no members**|"Mình không rõ chia cho ai…"|`nl.built {err:"no_members"}`|
|4.8|🟡 **Unknown/ambiguous name** ("cho Xyz")|"⚠️ Không tìm thấy 'Xyz'… Thành viên gồm: …" (never guesses — exact → unique-prefix → refuse)|`nl.built {err:"unresolved"}` · `resolveName`|
|4.9|🟡 Query > 500 chars|Truncated to 500, then parsed|`processUpdate`|
|4.10|🟡 Duplicate names ("Aya, Aya")|Deduped — first mention wins, no double-charge|`buildSplitArgs`|
|4.11|⚪ Just "@bot" with no command|Empty query → nothing sent|`processUpdate` (`if (!query) return`)|
|4.12|⚪ Group text **not** addressed to bot|Ignored (privacy mode)|`addressedToBot` → false|

**Safety note:** the model only *suggests*. `buildSplitArgs` (pure, unit-tested) is the
authority — it re-parses the amount, resolves names against the real roster, clamps weights
1–20, and refuses rather than inventing anyone.

---

## 5 · Natural-language split — confirm / cancel (button taps)

The ✅/❌ arrive later as a `callback_query`, routed to `handleConfirm`. This is a **two-phase
commit**: parse now, write on tap, possibly minutes apart.

| # | Trigger | Bot behaviour | Where (`cb.confirm {outcome}`) |
|---|---|---|---|
|5.1|🟢 Tap **✅ Có** (the requester)|Writes the expense, posts the settlement summary, edits card to "✅ Đã lưu…"|`split.wrote`|
|5.2|🟢 Tap **❌ Không**|"❌ Đã huỷ." — action marked cancelled|`outcome:"cancel"`|
|5.3|🔴 Someone **else** taps ✅/❌|"Không phải của bạn 🙅" alert; only the requester may confirm|`outcome:"notyours"`|
|5.4|🟡 Tap after **15-min TTL**|"⏰ Hết hạn — gõ lại nhé."|`outcome:"expired"`|
|5.5|🟡 **Double-tap ✅** (race)|Atomic consume: only the first writes; the second is a no-op|`outcome:"dup"`|
|5.6|🟡 A member was **deleted** between parse and tap|"⚠️ Thành viên đã thay đổi — gõ lại nhé." (StaleError)|`outcome:"stale"`|
|5.7|🟡 Action already done/cancelled|Silent no-op|`outcome:"noop"`|
|5.8|🟡 Pending row **missing** (old / DB reset)|"Yêu cầu đã hết hiệu lực."|`outcome:"gone"`|
|5.9|🔴 `executeSplit` throws (DB error)|Rolls back to `pending`, "Có lỗi, thử lại" — buttons stay for retry|`err {where:"confirm"}`|

---

## 6 · Bill-photo flow

A photo addressed to the bot, routed to `handleReceiptPhoto`. Nothing is ever written to
`expenses` here — it produces a **draft** reviewed in the Mini App.

| # | Trigger | Bot behaviour | Where |
|---|---|---|---|
|6.1|🟢 Photo (addressed), event bound|"🧾 Đang đọc hoá đơn…" placeholder → vision parse → button to review screen|`handleReceiptPhoto` · `rcpt.pending`|
|6.2|🟡 Photo, **no bound event**|"Nhóm chưa chọn sự kiện. Gõ /tally…"|(event guard)|
|6.3|🟡 Photo **too large** (>4 MB)|"Ảnh quá lớn — thử chụp lại gần hơn nhé."|size guard|
|6.4|🔴 Telegram file download fails|"Không tải được ảnh từ Telegram, thử lại nhé."|`downloadPhotoAsDataUrl`|
|6.5|🟡 Vision returns nothing|"Mình không đọc được hoá đơn này 😔…"|`parseReceiptWithAI`|
|6.6|🟡 Parsed but **no line items**|"Mình không nhận ra dòng món nào…"|`normalizeReceipt`|
|6.7|🟢 Review button — **private** chat|`web_app` button → `WEBAPP_URL?draft=<id>` (opens review in-app)|private branch|
|6.8|🟡 Review button — **group** chat|`t.me/<bot>?startapp=draft_<id>` deep link (needs Main Mini App enabled in BotFather)|group branch|
|6.9|🟢 Review screen: edit items, assign people, save|Writes **one expense per item** in a single D1 batch (all-or-nothing)|`POST /api/drafts/:id/confirm`|
|6.10|🟡 Σ items ≠ printed total (VAT/fees)|Soft "chênh lệch do thuế/phí" note — not an error (fees aren't modelled)|`reconciled` flag|
|6.11|🟡 Draft **expired** (60 min)|"Hoá đơn đã hết hạn — gửi lại ảnh nhé"|`loadReceiptDraft`|
|6.12|🟡 Draft already saved/cancelled|"Hoá đơn đã được lưu hoặc huỷ"|`loadReceiptDraft`|
|6.13|🔴 Draft belongs to another user|"Hoá đơn này không phải của bạn"|`loadReceiptDraft`|
|6.14|🟡 **Double-confirm** a draft|Atomic consume → second gets 409 "Hoá đơn này đã được lưu rồi"|`/drafts/:id/confirm`|
|6.15|🔴 Unexpected error mid-parse|"Có lỗi khi đọc hoá đơn, thử lại sau nhé 🙏"|catch · `console.error`|

---

## 7 · Ignored / no-op inputs ⚪

These reach the webhook but the bot deliberately does nothing.

| # | Trigger | Why ignored |
|---|---|---|
|7.1|Sticker, voice, video, document, location, poll|`typeof msg.text !== "string"` and no `msg.photo`|
|7.2|Message with no `from` (channel post)|`if (!msg.from) return`|
|7.3|**Edited** message|Telegram sends `edited_message`; `processUpdate` only reads `update.message`|
|7.4|Bot added/removed, new members, pinned msg (service messages)|No handler for `new_chat_members` etc.|
|7.5|Group text without `@bot` and not a reply|`addressedToBot` → false (privacy mode)|
|7.6|Unknown slash command in a group (`/foo`)|Doesn't start with `@bot`, so not addressed → ignored (in **private** it falls to NL → "Mình chưa hiểu")|

---

## 8 · Output side: settlement & payment

| # | Situation | Bot output |
|---|---|---|
|8.1|🟢 After a confirmed split|Posts settlement text: "Ben → Aya  270.000 ₫", fewest transfers|
|8.2|🟢 Everyone even|"Đã sòng phẳng!"|
|8.3|🟢 Creditor has bank/account attached|"💳 Aya: Vietcombank 001…" line appended (QR images can't go in plain text — Mini App only)|

---

## 9 · Security & integrity invariants (cross-cutting)

- **Identity is always the verified Telegram user.** The LLM fills amount/members; the
  *payer* (`paid_by`) and *creator* (`created_by`) come from `from.id` / `initData`, never
  the model. True on all three write paths.
- **Fail-closed webhook.** No/incorrect secret → 403, because a callback tap writes money.
- **Atomic consume.** Both the split confirm and the draft confirm flip `pending → done`
  with a conditional `UPDATE … WHERE status='pending'`; a lost race writes nothing.
- **Model output is untrusted.** Names are `esc()`'d on render and capped on write; printed
  amounts go only through `parsePrintedAmount` (never `parseFloat`).
- **Permissions.** Anyone in an event can add; only an expense's `created_by` can edit/delete
  (enforced in the API — note: there is **no** chat-side edit/delete today; see gaps).

---

## 10 · Coverage gaps & design opportunities 🧭

Scenarios that *don't exist yet* — candidates for the next iteration:

1. ✅ ~~Multi-event per chat + create/switch from chat~~ — **done** (migration `0001`; see §3).
2. **Quick-log / even-split tool** — `split_expense` forces you to name members. A
   `chia đều 540k` (everyone in the event) shortcut or an "add now, split later" tool would
   cut friction. The `pending_actions.tool` column already dispatches by name, so a new tool
   type is cheap.
3. **Chat-side edit/delete** — no way to fix or remove an expense from chat; you must open the
   Mini App. An "undo last" or edit-by-reply flow could help.
4. **Edited-message handling** — correcting a typo in your `@bot chia …` does nothing (7.3);
   could re-parse on `edited_message`.
5. **Post settlement into the group on demand** — a `/settle` command echoing the summary
   (already a planned next step in CLAUDE.md).

---

*Generated as a design aid. Source of truth: `src/telegram.ts`, `src/nl.ts`,
`src/receipt.ts`, `src/api.ts`, `schema.sql`.*
