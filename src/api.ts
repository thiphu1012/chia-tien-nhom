import type { Env } from "./index";
import { verifyInitData, type TgUser } from "./initData";
import { netBalances, settle, type SettleExpense } from "./settle";

const uid = () => crypto.randomUUID();
const now = () => Date.now();
// Money is stored as integer đồng — VND has no sub-unit, exactly like MoMo's `Long` amount.
// No ×100: 540.000 ₫ is stored as the integer 540000.
const toDong = (n: number) => Math.round(Number(n));

// Vietnamese number format: '.' groups thousands. Amounts are whole đồng, so no decimals.
function fmtVN(n: number): string {
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
      const title = String(body.title || "").trim();
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
        const name = String(n).trim();
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
      const body = await req.json<any>();
      const name = String(body.name || "").trim();
      if (!name) return json({ error: "name required" }, 400);
      await env.DB.prepare(
        `INSERT INTO participants (id, event_id, name, user_id) VALUES (?1,?2,?3,NULL)`,
      ).bind(uid(), parts[1], name).run();
      return json(await loadEvent(env, parts[1]), 201);
    }

    // POST /api/events/:id/claim { participantId }  — link myself to a name
    if (parts[0] === "events" && parts[2] === "claim" && method === "POST") {
      const body = await req.json<any>();
      await env.DB.prepare(
        `UPDATE participants SET user_id = ?1 WHERE id = ?2 AND event_id = ?3`,
      ).bind(me.id, String(body.participantId), parts[1]).run();
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
      const exId = uid();
      await env.DB.prepare(
        `INSERT INTO expenses (id, event_id, title, amount_dong, paid_by, created_by, created_at, pay_bank, pay_account, pay_qr)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
      ).bind(exId, eventId, String(body.title).trim(), toDong(body.amount), mine.id, me.id, now(),
             pf.bank, pf.account, pf.qr).run();
      await writeSplits(env, exId, body.splits);
      return json(await loadEvent(env, eventId), 201);
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

function validateExpense(body: any): string | null {
  if (!body || !String(body.title || "").trim()) return "title required";
  if (!(Number(body.amount) > 0)) return "amount must be positive";
  const incl = (body.splits || []).filter((s: any) =>
    s.included && (Number(s.weight) > 0 || (s.amount != null && Number(s.amount) >= 0)));
  if (incl.length === 0) return "at least one participant must be included";
  return null;
}

async function writeSplits(env: Env, expenseId: string, splits: any[]) {
  for (const s of splits || []) {
    const amount = (s.amount != null && isFinite(Number(s.amount)) && Number(s.amount) >= 0)
      ? Math.round(Number(s.amount)) : null;
    await env.DB.prepare(
      `INSERT INTO splits (expense_id, participant_id, included, weight, amount_dong) VALUES (?1,?2,?3,?4,?5)`,
    ).bind(
      expenseId,
      String(s.participantId),
      s.included ? 1 : 0,
      Math.max(1, Number(s.weight) || 1),
      amount,
    ).run();
  }
}
