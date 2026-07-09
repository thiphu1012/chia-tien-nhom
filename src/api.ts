import type { Env } from "./index";
import { verifyInitData, type TgUser } from "./initData";
import { netBalances, settle, type SettleExpense } from "./settle";
import { norm } from "./nl";

const uid = () => crypto.randomUUID();
const now = () => Date.now();
// Money is stored as integer đồng — VND has no sub-unit, exactly like MoMo's `Long` amount.
// No ×100: 540.000 ₫ is stored as the integer 540000.
const toDong = (n: number) => Math.round(Number(n));

// Vietnamese number format: '.' groups thousands. Amounts are whole đồng, so no decimals.
export function fmtVN(n: number): string {
  return Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- auth: resolve the acting Telegram user from init data ----
async function authUser(req: Request, env: Env): Promise<TgUser | Response> {
  // Dev-only bypass so you can test with curl or a browser outside Telegram.
  if (env.DEV_MODE === "true") {
    const dev = req.headers.get("X-Dev-User");
    if (dev) {
      const [id, ...rest] = dev.split(":");
      return { id: Number(id), first_name: rest.join(":") || `User ${id}` };
    }
  }
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^tma (.+)$/s);
  if (!m) return json({ error: "missing init data" }, 401);
  const v = await verifyInitData(m[1], env.BOT_TOKEN);
  if (!v.ok || !v.user) return json({ error: "invalid init data", reason: v.reason }, 401);
  return v.user;
}

async function upsertUser(env: Env, u: TgUser) {
  await env.DB.prepare(
    `INSERT INTO users (id, first_name, username, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET first_name = ?2, username = ?3`,
  ).bind(u.id, u.first_name ?? null, u.username ?? null, now()).run();
}

// ---- load a full event, with balances + settlement computed ----
async function loadEvent(env: Env, eventId: string) {
  const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?1`).bind(eventId).first<any>();
  if (!event) return null;

  const participants = (await env.DB.prepare(
    `SELECT id, name, user_id FROM participants WHERE event_id = ?1 ORDER BY rowid`,
  ).bind(eventId).all<any>()).results;

  const expenseRows = (await env.DB.prepare(
    `SELECT * FROM expenses WHERE event_id = ?1 ORDER BY created_at`,
  ).bind(eventId).all<any>()).results;

  const splitRows = expenseRows.length
    ? (await env.DB.prepare(
        `SELECT * FROM splits WHERE expense_id IN (${expenseRows.map(() => "?").join(",")})`,
      ).bind(...expenseRows.map((e) => e.id)).all<any>()).results
    : [];

  const splitsByExpense: Record<string, any[]> = {};
  for (const s of splitRows) (splitsByExpense[s.expense_id] ||= []).push(s);

  const expenses = expenseRows.map((e) => ({
    id: e.id,
    title: e.title,
    amount: e.amount_dong,
    paidBy: e.paid_by,
    createdBy: e.created_by,
    createdAt: e.created_at,
    payBank: e.pay_bank || null,
    payAccount: e.pay_account || null,
    payQr: e.pay_qr || null,
    splits: (splitsByExpense[e.id] || []).map((s) => ({
      participantId: s.participant_id,
      included: !!s.included,
      weight: s.weight,
      amount: s.amount_dong ?? null,
    })),
  }));

  // settlement (integer đồng)
  const forSettle: SettleExpense[] = expenseRows.map((e) => ({
    amount: e.amount_dong,
    paidBy: e.paid_by,
    splits: (splitsByExpense[e.id] || []).map((s) => ({
      participantId: s.participant_id,
      included: !!s.included,
      weight: s.weight,
      amount: s.amount_dong ?? null,
    })),
  }));
  const net = netBalances(participants.map((p) => p.id), forSettle);
  const balances: Record<string, number> = {};
  for (const [k, v] of Object.entries(net)) balances[k] = v;
  const settlement = settle(net).map((t) => ({ from: t.from, to: t.to, amount: t.amount }));

  return {
    id: event.id,
    title: event.title,
    currency: event.currency,
    createdBy: event.created_by,
    chatId: event.chat_id,
    participants,
    expenses,
    balances,
    settlement,
    total: expenseRows.reduce((s, e) => s + e.amount_dong, 0),
  };
}

function summaryText(ev: NonNullable<Awaited<ReturnType<typeof loadEvent>>>): string {
  const name = (id: string) => ev.participants.find((p: any) => p.id === id)?.name || "?";
  const cur = ev.currency;
  const lines = ev.settlement.map((t: any) => `${name(t.from)} → ${name(t.to)}  ${fmtVN(t.amount)} ${cur}`);
  // Bank/account of each person owed money (QR images can't go in plain text).
  const creditors = ev.participants.filter((p: any) => (ev.balances[p.id] || 0) > 0.5);
  const payLines: string[] = [];
  for (const c of creditors) {
    const ex = ev.expenses.find((x: any) => x.paidBy === c.id && x.payBank && x.payAccount);
    if (ex) payLines.push(`💳 ${c.name}: ${ex.payBank} ${ex.payAccount}`);
  }
  const body = lines.join("\n") || "Đã sòng phẳng!";
  const pay = payLines.length ? `\n\n${payLines.join("\n")}` : "";
  return `💸 ${ev.title} — quyết toán\n\n${body}${pay}`;
}

// ---- router ----
export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const who = await authUser(req, env);
  if (who instanceof Response) return who;
  const me = who;
  await upsertUser(env, me);

  const parts = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "").split("/");
  const method = req.method;

  try {
    // GET /api/me
    if (parts[0] === "me" && parts.length === 1 && method === "GET") {
      return json({ id: me.id, first_name: me.first_name, username: me.username });
    }

    // GET /api/events  — events I created or am a (claimed) participant in
    if (parts[0] === "events" && parts.length === 1 && method === "GET") {
      const rows = (await env.DB.prepare(
        `SELECT DISTINCT e.id, e.title, e.currency, e.created_by, e.created_at
           FROM events e
           LEFT JOIN participants p ON p.event_id = e.id
          WHERE e.created_by = ?1 OR p.user_id = ?1
          ORDER BY e.created_at DESC`,
      ).bind(me.id).all<any>()).results;

      const events = [];
      for (const e of rows) {
        const cnt = await env.DB.prepare(
          `SELECT COUNT(*) AS p FROM participants WHERE event_id = ?1`,
        ).bind(e.id).first<any>();
        const tot = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount_dong),0) AS t, COUNT(*) AS n FROM expenses WHERE event_id = ?1`,
        ).bind(e.id).first<any>();
        events.push({
          id: e.id, title: e.title, currency: e.currency,
          participantCount: cnt.p, expenseCount: tot.n, total: tot.t,
        });
      }
      return json({ events });
    }

    // POST /api/events  { title, currency, participantNames: [] }
    if (parts[0] === "events" && parts.length === 1 && method === "POST") {
      const body = await req.json<any>();
      const title = String(body.title || "").trim().slice(0, 80);
      if (!title) return json({ error: "title required" }, 400);
      const currency = String(body.currency || "₫").slice(0, 3) || "₫";
      const id = uid();
      await env.DB.prepare(
        `INSERT INTO events (id, chat_id, title, currency, created_by, created_at) VALUES (?1,?2,?3,?4,?5,?6)`,
      ).bind(id, body.chatId ?? null, title, currency, me.id, now()).run();

      // creator is auto-added and linked to their account
      await env.DB.prepare(
        `INSERT INTO participants (id, event_id, name, user_id) VALUES (?1,?2,?3,?4)`,
      ).bind(uid(), id, me.first_name || "Me", me.id).run();

      for (const n of (body.participantNames || [])) {
        const name = String(n).trim().slice(0, 40);
        if (name) {
          await env.DB.prepare(
            `INSERT INTO participants (id, event_id, name, user_id) VALUES (?1,?2,?3,NULL)`,
          ).bind(uid(), id, name).run();
        }
      }
      return json(await loadEvent(env, id), 201);
    }

    // GET /api/events/:id
    if (parts[0] === "events" && parts.length === 2 && method === "GET") {
      const ev = await loadEvent(env, parts[1]);
      if (!ev) return json({ error: "not found" }, 404);
      return json(ev);
    }

    // POST /api/events/:id/participants { name }
    if (parts[0] === "events" && parts[2] === "participants" && method === "POST") {
      if (!(await isMember(env, parts[1], me.id))) return json({ error: "Bạn cần tham gia sự kiện trước" }, 403);
      const body = await req.json<any>();
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) return json({ error: "name required" }, 400);
      await env.DB.prepare(
        `INSERT INTO participants (id, event_id, name, user_id) VALUES (?1,?2,?3,NULL)`,
      ).bind(uid(), parts[1], name).run();
      return json(await loadEvent(env, parts[1]), 201);
    }

    // POST /api/events/:id/claim { participantId }  — link myself to a name
    if (parts[0] === "events" && parts[2] === "claim" && method === "POST") {
      const body = await req.json<any>();
      // Only claim a name that's free (or already yours) — never overwrite someone else's link.
      const res = await env.DB.prepare(
        `UPDATE participants SET user_id = ?1
           WHERE id = ?2 AND event_id = ?3 AND (user_id IS NULL OR user_id = ?1)`,
      ).bind(me.id, String(body.participantId), parts[1]).run();
      if (!res.meta.changes) return json({ error: "Tên này đã có người nhận" }, 409);
      return json(await loadEvent(env, parts[1]));
    }

    // GET /api/events/:id/summary  — shareable text
    if (parts[0] === "events" && parts[2] === "summary" && method === "GET") {
      const ev = await loadEvent(env, parts[1]);
      if (!ev) return json({ error: "not found" }, 404);
      return json({ text: summaryText(ev) });
    }

    // POST /api/events/:id/expenses  { title, amount, paidBy, splits:[{participantId,included,weight}] }
    if (parts[0] === "events" && parts[2] === "expenses" && method === "POST") {
      const eventId = parts[1];
      // Creator = payer: you must have joined this event, and you pay for what you add.
      const mine = await env.DB.prepare(
        `SELECT id FROM participants WHERE event_id = ?1 AND user_id = ?2 LIMIT 1`,
      ).bind(eventId, me.id).first<any>();
      if (!mine) return json({ error: "Bạn cần tham gia sự kiện trước khi thêm khoản chi" }, 403);
      const body = await req.json<any>();
      const err = validateExpense(body);
      if (err) return json({ error: err }, 400);
      const pf = payFields(body);
      if (typeof pf === "string") return json({ error: pf }, 400);
      const ev = await writeExpense(env, { participantId: mine.id, userId: me.id }, eventId, {
        title: String(body.title), amount: body.amount, splits: body.splits, pay: pf,
      });
      return json(ev, 201);
    }

    // PUT /api/expenses/:id  — edit (owner only)
    if (parts[0] === "expenses" && parts.length === 2 && method === "PUT") {
      const ex = await env.DB.prepare(`SELECT * FROM expenses WHERE id = ?1`).bind(parts[1]).first<any>();
      if (!ex) return json({ error: "not found" }, 404);
      if (ex.created_by !== me.id) return json({ error: "you can only edit your own expenses" }, 403);
      const body = await req.json<any>();
      const err = validateExpense(body);
      if (err) return json({ error: err }, 400);
      const pf = payFields(body);
      if (typeof pf === "string") return json({ error: pf }, 400);
      // paid_by is left unchanged — the payer is always the (unchanged) creator.
      await env.DB.prepare(
        `UPDATE expenses SET title = ?1, amount_dong = ?2, pay_bank = ?3, pay_account = ?4, pay_qr = ?5 WHERE id = ?6`,
      ).bind(String(body.title).trim(), toDong(body.amount), pf.bank, pf.account, pf.qr, parts[1]).run();
      await env.DB.prepare(`DELETE FROM splits WHERE expense_id = ?1`).bind(parts[1]).run();
      await writeSplits(env, parts[1], body.splits);
      return json(await loadEvent(env, ex.event_id));
    }

    // DELETE /api/expenses/:id  — owner only
    if (parts[0] === "expenses" && parts.length === 2 && method === "DELETE") {
      const ex = await env.DB.prepare(`SELECT * FROM expenses WHERE id = ?1`).bind(parts[1]).first<any>();
      if (!ex) return json({ error: "not found" }, 404);
      if (ex.created_by !== me.id) return json({ error: "you can only delete your own expenses" }, 403);
      await env.DB.prepare(`DELETE FROM splits WHERE expense_id = ?1`).bind(parts[1]).run();
      await env.DB.prepare(`DELETE FROM expenses WHERE id = ?1`).bind(parts[1]).run();
      return json(await loadEvent(env, ex.event_id));
    }

    // ---- receipt drafts: the bill-photo flow (see src/receipt.ts) ----
    // A draft is a pending_actions row (tool='receipt_items') created by the bot
    // when it parses a photo. The model output is only a pre-fill: what gets
    // written below is the USER-EDITED item list from the review screen.

    // GET /api/drafts/:id — draft + full event, for the Mini App review screen.
    if (parts[0] === "drafts" && parts.length === 2 && method === "GET") {
      const r = await loadReceiptDraft(env, parts[1], me.id);
      if ("error" in r) return json({ error: r.error }, r.status);
      const event = await loadEvent(env, r.row.event_id);
      if (!event) return json({ error: "not found" }, 404);
      return json({ draft: { id: r.row.id, ...JSON.parse(r.row.args_json) }, event });
    }

    // POST /api/drafts/:id/confirm  { items:[{title, amountDong, splits:[...]}] }
    // Writes one expense per item. Uploader = confirmer = payer (creator-is-payer).
    if (parts[0] === "drafts" && parts[2] === "confirm" && method === "POST") {
      const r = await loadReceiptDraft(env, parts[1], me.id);
      if ("error" in r) return json({ error: r.error }, r.status);
      const row = r.row;
      const body = await req.json<any>();
      const validIds = new Set((await listParticipants(env, row.event_id)).map((p) => p.id));
      const err = validateDraftItems(body, validIds);
      if (err) return json({ error: err }, 400);

      // Consume the draft atomically so a double-tap can't double-write.
      const consume = await env.DB.prepare(
        `UPDATE pending_actions SET status='done' WHERE id = ?1 AND status='pending'`,
      ).bind(row.id).run();
      if (consume.meta.changes !== 1) return json({ error: "Hoá đơn này đã được lưu rồi" }, 409);

      try {
        const payerId = await ensureParticipant(env, row.event_id, { id: me.id, first_name: me.first_name });
        // One D1 batch = one transaction: every item lands, or none do.
        const stmts: D1PreparedStatement[] = [];
        for (const it of body.items) {
          const exId = uid();
          stmts.push(env.DB.prepare(
            `INSERT INTO expenses (id, event_id, title, amount_dong, paid_by, created_by, created_at, pay_bank, pay_account, pay_qr)
             VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,NULL,NULL)`,
          ).bind(exId, row.event_id, String(it.title).trim().slice(0, 80), toDong(it.amountDong),
                 payerId, me.id, now()));
          for (const s of it.splits) {
            const amount = (s.amount != null && isFinite(Number(s.amount)) && Number(s.amount) >= 0)
              ? Math.round(Number(s.amount)) : null;
            stmts.push(env.DB.prepare(
              `INSERT INTO splits (expense_id, participant_id, included, weight, amount_dong) VALUES (?1,?2,?3,?4,?5)`,
            ).bind(exId, String(s.participantId), s.included ? 1 : 0, clampWeight(s.weight), amount));
          }
        }
        await env.DB.batch(stmts);
      } catch (e) {
        // The batch is transactional — nothing was written. Reopen the draft for a retry.
        await env.DB.prepare(
          `UPDATE pending_actions SET status='pending' WHERE id = ?1 AND status='done'`,
        ).bind(row.id).run();
        throw e;
      }
      return json({ saved: body.items.length, event: await loadEvent(env, row.event_id) }, 201);
    }

    return json({ error: "not found" }, 404);
  } catch (e: any) {
    return json({ error: "server error", detail: String(e?.message || e) }, 500);
  }
}

// Sanitize optional payment info. Returns an error string, or the cleaned fields.
// Manual mode keeps bank only when an account is present; image mode keeps a QR data URL.
function payFields(body: any): { bank: string | null; account: string | null; qr: string | null } | string {
  const account = body.payAccount ? String(body.payAccount).trim().slice(0, 40) : null;
  const bank = body.payBank ? String(body.payBank).slice(0, 40) : null;
  const qr = body.payQr ? String(body.payQr) : null;
  if (qr) {
    if (qr.length > 400_000) return "Ảnh QR quá lớn (hãy dùng ảnh nhỏ hơn)";
    // Only a strict base64 image data URL — its alphabet contains no HTML-breaking
    // chars, so it is safe in an <img src>. (The client never sends URL-based QRs.)
    if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/.test(qr)) {
      return "Ảnh QR không hợp lệ";
    }
  }
  return { bank: account ? bank : null, account, qr };
}

// True if the user created this event or has claimed a participant in it.
async function isMember(env: Env, eventId: string, userId: number): Promise<boolean> {
  const ev = await env.DB.prepare(`SELECT created_by FROM events WHERE id = ?1`).bind(eventId).first<any>();
  if (!ev) return false;
  if (ev.created_by === userId) return true;
  const p = await env.DB.prepare(
    `SELECT 1 FROM participants WHERE event_id = ?1 AND user_id = ?2 LIMIT 1`,
  ).bind(eventId, userId).first();
  return !!p;
}

function validateExpense(body: any): string | null {
  const title = String(body?.title || "").trim();
  if (!title) return "title required";
  if (title.length > 60) return "title too long";
  if (!(Number(body.amount) > 0)) return "amount must be positive";
  const incl = (body.splits || []).filter((s: any) =>
    s.included && (Number(s.weight) > 0 || (s.amount != null && Number(s.amount) >= 0)));
  if (incl.length === 0) return "at least one participant must be included";
  // Fixed per-member amounts must be non-negative and not exceed the expense total.
  let locked = 0;
  for (const s of incl) if (s.amount != null) {
    const a = Math.round(Number(s.amount));
    if (!(a >= 0)) return "split amount must be non-negative";
    locked += a;
  }
  if (locked > toDong(body.amount)) return "fixed amounts exceed the total";
  return null;
}

// ---- receipt-draft helpers (bill-photo flow) ----

const RECEIPT_TTL_MS = 60 * 60 * 1000; // review window for a scanned bill (longer than chat cards)
const MAX_DRAFT_ITEMS = 40;
const MAX_ITEM_DONG = 10_000_000_000; // 10 tỷ — same runaway guard as the parsers

// Load + authorize a receipt draft: exists, owned by the caller, still pending, not expired.
async function loadReceiptDraft(
  env: Env, id: string, userId: number,
): Promise<{ row: any } | { error: string; status: number }> {
  const row = await env.DB.prepare(
    `SELECT * FROM pending_actions WHERE id = ?1 AND tool = 'receipt_items'`,
  ).bind(id).first<any>();
  if (!row) return { error: "not found", status: 404 };
  if (row.user_id !== userId) return { error: "Hoá đơn này không phải của bạn", status: 403 };
  if (row.status !== "pending") return { error: "Hoá đơn đã được lưu hoặc huỷ", status: 410 };
  if (Date.now() - row.created_at > RECEIPT_TTL_MS) {
    await env.DB.prepare(
      `UPDATE pending_actions SET status='expired' WHERE id = ?1 AND status='pending'`,
    ).bind(id).run();
    return { error: "Hoá đơn đã hết hạn — gửi lại ảnh nhé", status: 410 };
  }
  return { row };
}

// Validate the user-edited items from the review screen (the authoritative data —
// the model's parse is only a pre-fill). Mirrors validateExpense per item.
function validateDraftItems(body: any, validParticipantIds: Set<string>): string | null {
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) return "Chưa có món nào để lưu";
  if (items.length > MAX_DRAFT_ITEMS) return `Quá nhiều món (tối đa ${MAX_DRAFT_ITEMS})`;
  for (const it of items) {
    const title = String(it?.title || "").trim();
    if (!title) return "Mỗi món cần có tên";
    if (title.length > 80) return "Tên món quá dài (tối đa 80)";
    const amount = Number(it?.amountDong);
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_ITEM_DONG) {
      return `Số tiền không hợp lệ: ${title.slice(0, 30)}`;
    }
    const splits = Array.isArray(it?.splits) ? it.splits : [];
    const incl = splits.filter((s: any) =>
      s?.included && (Number(s.weight) > 0 || (s.amount != null && Number(s.amount) >= 0)));
    if (incl.length === 0) return `Chưa chọn người chia cho: ${title.slice(0, 30)}`;
    for (const s of splits) {
      if (!validParticipantIds.has(String(s?.participantId))) {
        return "Thành viên đã thay đổi — mở lại hoá đơn nhé";
      }
    }
  }
  return null;
}

// Weights are REAL in half-share steps: 0.5 (came late) … 20, default 1.
function clampWeight(w: unknown): number {
  const half = Math.round((Number(w) || 1) * 2) / 2;
  return Math.min(20, Math.max(0.5, half));
}

async function writeSplits(env: Env, expenseId: string, splits: any[]) {
  const rows = (splits || []).map((s) => {
    const amount = (s.amount != null && isFinite(Number(s.amount)) && Number(s.amount) >= 0)
      ? Math.round(Number(s.amount)) : null;
    return env.DB.prepare(
      `INSERT INTO splits (expense_id, participant_id, included, weight, amount_dong) VALUES (?1,?2,?3,?4,?5)`,
    ).bind(
      expenseId,
      String(s.participantId),
      s.included ? 1 : 0,
      clampWeight(s.weight),
      amount,
    );
  });
  if (rows.length) await env.DB.batch(rows);
}

// ===========================================================================
//  Shared write path + bot helpers
//
//  These are called by BOTH the REST API (Mini App) and the Telegram bot's
//  natural-language layer (src/telegram.ts). `writeExpense` is deliberately
//  agnostic about how the acting user was authenticated: the caller resolves
//  the payer participant (REST enforces "must have joined"; the bot auto-joins
//  via `ensureParticipant`) and the creator user id. Identity is never derived
//  from an LLM — see CLAUDE.md.
// ===========================================================================

// Insert one expense + its splits, then return the reloaded event (or null).
export async function writeExpense(
  env: Env,
  payer: { participantId: string; userId: number },
  eventId: string,
  input: { title: string; amount: number; splits: any[]; pay?: { bank: string | null; account: string | null; qr: string | null } },
) {
  const exId = uid();
  const pay = input.pay ?? { bank: null, account: null, qr: null };
  await env.DB.prepare(
    `INSERT INTO expenses (id, event_id, title, amount_dong, paid_by, created_by, created_at, pay_bank, pay_account, pay_qr)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  ).bind(exId, eventId, String(input.title).trim().slice(0, 80), toDong(input.amount),
         payer.participantId, payer.userId, now(), pay.bank, pay.account, pay.qr).run();
  await writeSplits(env, exId, input.splits);
  return loadEvent(env, eventId);
}

// The single event bound to a chat (0 or 1). The /tally bind keeps exactly one
// event per chat, so this is unambiguous — no "newest wins" guess.
export async function resolveEventForChat(env: Env, chatId: number): Promise<any | null> {
  return env.DB.prepare(
    `SELECT * FROM events WHERE chat_id = ?1 ORDER BY created_at DESC LIMIT 1`,
  ).bind(chatId).first<any>();
}

export async function listParticipants(env: Env, eventId: string): Promise<{ id: string; name: string; user_id: number | null }[]> {
  return (await env.DB.prepare(
    `SELECT id, name, user_id FROM participants WHERE event_id = ?1 ORDER BY rowid`,
  ).bind(eventId).all<any>()).results;
}

// Events the user created or has claimed a participant in, most recent first.
export async function recentEventsForUser(env: Env, userId: number, limit = 5): Promise<{ id: string; title: string }[]> {
  return (await env.DB.prepare(
    `SELECT DISTINCT e.id, e.title, e.created_at
       FROM events e
       LEFT JOIN participants p ON p.event_id = e.id
      WHERE e.created_by = ?1 OR p.user_id = ?1
      ORDER BY e.created_at DESC LIMIT ?2`,
  ).bind(userId, limit).all<any>()).results.map((e: any) => ({ id: e.id, title: e.title }));
}

// Bind exactly one event to a chat: unbind whatever was bound, then bind this one.
export async function bindEventToChat(env: Env, chatId: number, eventId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE events SET chat_id = NULL WHERE chat_id = ?1`).bind(chatId),
    env.DB.prepare(`UPDATE events SET chat_id = ?1 WHERE id = ?2`).bind(chatId, eventId),
  ]);
}

// Ensure the acting user has a participant row in the event; return its id.
// Order: already claimed → claim an unclaimed row with the same (normalized)
// name → create a fresh participant. The middle branch matters because groups
// typically pre-add members by name in the Mini App.
export async function ensureParticipant(env: Env, eventId: string, user: { id: number; first_name?: string }): Promise<string> {
  const mine = await env.DB.prepare(
    `SELECT id FROM participants WHERE event_id = ?1 AND user_id = ?2 LIMIT 1`,
  ).bind(eventId, user.id).first<any>();
  if (mine) return mine.id;

  const wanted = norm(user.first_name || "");
  if (wanted) {
    const rows = (await env.DB.prepare(
      `SELECT id, name FROM participants WHERE event_id = ?1 AND user_id IS NULL`,
    ).bind(eventId).all<any>()).results;
    const match = rows.find((r: any) => norm(r.name) === wanted);
    if (match) {
      await env.DB.prepare(`UPDATE participants SET user_id = ?1 WHERE id = ?2`).bind(user.id, match.id).run();
      await upsertUser(env, { id: user.id, first_name: user.first_name });
      return match.id;
    }
  }

  const id = uid();
  await env.DB.prepare(
    `INSERT INTO participants (id, event_id, name, user_id) VALUES (?1,?2,?3,?4)`,
  ).bind(id, eventId, (user.first_name || `User ${user.id}`).slice(0, 40), user.id).run();
  await upsertUser(env, { id: user.id, first_name: user.first_name });
  return id;
}

// Shareable settlement text for an event (same formatting as GET /summary).
export async function eventSummaryText(env: Env, eventId: string): Promise<string | null> {
  const ev = await loadEvent(env, eventId);
  return ev ? summaryText(ev) : null;
}
