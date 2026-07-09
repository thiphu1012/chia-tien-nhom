import type { Env } from "./index";
import { parseWithAI, buildSplitArgs, type BuildResult, type Participant } from "./nl";
import { parseReceiptWithAI, normalizeReceipt } from "./receipt";
import {
  resolveEventForChat, listParticipants, recentEventsForUser, bindEventToChat,
  ensureParticipant, writeExpense, eventSummaryText, fmtVN,
} from "./api";

const TTL_MS = 15 * 60 * 1000;                       // a confirmation card expires after 15 min
const shortId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

// Thrown when the world changed between parse and confirm (a member vanished).
class StaleError extends Error {}

// Thin wrapper around the Telegram Bot API.
export async function tg(env: Env, method: string, payload: unknown): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// Handles POST /webhook — the updates Telegram pushes to us. Acks fast (Telegram
// retries otherwise) and does the slow work (LLM parse, DB writes) in the background.
export async function handleWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Fail CLOSED: the webhook now executes money writes via callback_query, so a
  // missing/incorrect secret must be rejected, not waved through.
  if (!env.WEBHOOK_SECRET ||
      req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: any;
  try { update = await req.json(); } catch { return new Response("ok"); }

  ctx.waitUntil(processUpdate(update, env).catch((e) => console.error("update failed", e)));
  return new Response("ok");
}

async function processUpdate(update: any, env: Env): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query, env);

  const msg = update.message;
  if (!msg || !msg.from) return;

  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === "private";
  const from = msg.from; // trusted: Telegram-authenticated via the webhook secret

  // Bill-photo path: a photo addressed to the bot becomes a parsed receipt draft,
  // reviewed and confirmed in the Mini App (never auto-written).
  if (Array.isArray(msg.photo) && msg.photo.length) {
    if (!addressedToBot(env, msg, String(msg.caption ?? ""), isPrivate)) return;
    return handleReceiptPhoto(env, chatId, isPrivate, from, msg.photo);
  }

  if (typeof msg.text !== "string") return;
  const text: string = msg.text.trim();

  if (text.startsWith("/start") || text.startsWith("/split")) return sendStart(env, chatId, isPrivate);
  if (text.startsWith("/help")) return sendHelp(env, chatId);
  if (text.startsWith("/tally")) return handleTally(env, chatId, from);

  // Natural-language path. In groups, privacy mode stays ON, so we only see (and
  // only act on) messages addressed to the bot — a leading @mention or a reply.
  if (!addressedToBot(env, msg, text, isPrivate)) return;

  const mention = "@" + env.BOT_USERNAME;
  let query = text.toLowerCase().startsWith(mention.toLowerCase())
    ? text.slice(mention.length).trim() : text;
  query = query.slice(0, 500);
  if (!query) return;

  return handleNl(env, chatId, from, query);
}

// Addressed to the bot: private chat, a leading @mention (text or photo caption),
// or a reply to one of the bot's messages.
function addressedToBot(env: Env, msg: any, text: string, isPrivate: boolean): boolean {
  if (isPrivate) return true;
  const mention = "@" + env.BOT_USERNAME.toLowerCase();
  return text.trim().toLowerCase().startsWith(mention)
    || msg.reply_to_message?.from?.username?.toLowerCase() === env.BOT_USERNAME.toLowerCase();
}

// ---- slash commands ----
async function sendStart(env: Env, chatId: number, isPrivate: boolean): Promise<void> {
  if (isPrivate) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Chào mừng đến với Tally — chia chi phí sự kiện và xem ai nợ ai.\n\nChạm bên dưới để mở ứng dụng.",
      reply_markup: { inline_keyboard: [[{ text: "💸 Mở Tally", web_app: { url: env.WEBAPP_URL } }]] },
    });
  } else {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Tally đã sẵn sàng cho nhóm này. Chạm nút menu của bot (☰) để mở công cụ, hoặc gõ /tally để chọn sự kiện rồi nhắn \"@" + env.BOT_USERNAME + " chia 100k cho A, B\".",
    });
  }
}

async function sendHelp(env: Env, chatId: number): Promise<void> {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "Tally giúp chia chi phí chung.\n" +
      "• /start — mở ứng dụng\n" +
      "• /tally — chọn sự kiện cho nhóm này\n" +
      `• Nhắn "@${env.BOT_USERNAME} chia 540k cho Aya, Ben tính đôi" — bot sẽ hỏi xác nhận trước khi lưu.`,
  });
}

// ---- /tally: pick the event this chat is bound to ----
async function handleTally(env: Env, chatId: number, from: any): Promise<void> {
  const events = await recentEventsForUser(env, from.id, 5);
  if (!events.length) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Bạn chưa có sự kiện nào. Mở Tally (nút menu ☰) để tạo, rồi gõ /tally lại.",
    });
    return;
  }
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Chọn sự kiện cho nhóm này (gõ /tally lần nữa để đổi):",
    reply_markup: { inline_keyboard: events.map((e) => [{ text: e.title, callback_data: `t:bind:${e.id}` }]) },
  });
}

// ---- natural-language split ----
async function handleNl(env: Env, chatId: number, from: any, query: string): Promise<void> {
  const event = await resolveEventForChat(env, chatId);
  if (!event) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Nhóm chưa chọn sự kiện. Gõ /tally để chọn nhé." });
    return;
  }

  const participants = await listParticipants(env, event.id);
  const roster: Participant[] = participants.map((p) => ({ id: p.id, name: p.name }));

  let raw;
  try {
    raw = await parseWithAI(env.AI, env.AI_MODEL, query, roster.map((p) => p.name));
  } catch {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Bot đang bận, thử lại sau nhé 🙏" });
    return;
  }
  if (!raw) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `Mình chưa hiểu 🤔. Thử: "@${env.BOT_USERNAME} chia 540k cho Aya, Ben".`,
    });
    return;
  }

  const built = buildSplitArgs(raw, roster);
  if (!built.ok) {
    await tg(env, "sendMessage", { chat_id: chatId, text: explainBuildError(built, roster) });
    return;
  }

  // Stash the parsed action; store resolved participant IDs, not names, so a later
  // rename can't silently retarget the split. Executed only on a Yes tap.
  const id = shortId();
  const args = {
    title: built.title,
    amount: built.amount,
    members: built.members.map((m) => ({ participantId: m.participantId, weight: m.weight })),
  };
  await env.DB.prepare(
    `INSERT INTO pending_actions (id, chat_id, user_id, user_name, event_id, tool, args_json, status, created_at)
     VALUES (?1,?2,?3,?4,?5,'split_expense',?6,'pending',?7)`,
  ).bind(id, chatId, from.id, from.first_name ?? null, event.id, JSON.stringify(args), Date.now()).run();

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: confirmText(event.title, event.currency, built),
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Có", callback_data: `t:yes:${id}` },
        { text: "❌ Không", callback_data: `t:no:${id}` },
      ]],
    },
  });
}

function confirmText(eventTitle: string, currency: string, built: Extract<BuildResult, { ok: true }>): string {
  const cur = currency || "₫";
  const who = built.members.map((m) => `${m.name}${m.weight > 1 ? ` (×${m.weight})` : ""}`).join(", ");
  return `💸 Xác nhận — ${eventTitle}\n\n${built.title}: ${fmtVN(built.amount)} ${cur}\nChia cho: ${who}\n\nĐúng không?`;
}

// ---- bill photo → parsed receipt draft ----
// Flow: placeholder message → download photo → vision parse → normalize →
// pending_actions row (tool='receipt_items') → edit placeholder with a button
// that opens the Mini App review screen. Nothing is written to expenses here.
async function handleReceiptPhoto(
  env: Env, chatId: number, isPrivate: boolean, from: any, photos: any[],
): Promise<void> {
  const event = await resolveEventForChat(env, chatId);
  if (!event) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "Nhóm chưa chọn sự kiện. Gõ /tally để chọn nhé." });
    return;
  }

  // Placeholder first — vision parsing takes several seconds.
  const placeholder = await (await tg(env, "sendMessage", {
    chat_id: chatId, text: "🧾 Đang đọc hoá đơn…",
  })).json<any>();
  const messageId = placeholder?.result?.message_id;
  const fail = (text: string) =>
    messageId ? editText(env, chatId, messageId, text)
              : tg(env, "sendMessage", { chat_id: chatId, text }).then(() => {});

  try {
    // Largest size Telegram offers (receipts need resolution for small print).
    const photo = photos.reduce((a, b) => ((a.width || 0) * (a.height || 0) >= (b.width || 0) * (b.height || 0) ? a : b));
    if ((photo.file_size || 0) > 4_000_000) return fail("Ảnh quá lớn — thử chụp lại gần hơn nhé.");
    const dataUrl = await downloadPhotoAsDataUrl(env, photo.file_id);
    if (!dataUrl) return fail("Không tải được ảnh từ Telegram, thử lại nhé.");

    const raw = await parseReceiptWithAI(env.AI, env.AI_VISION_MODEL, dataUrl);
    if (!raw) return fail("Mình không đọc được hoá đơn này 😔. Thử chụp thẳng, đủ sáng, rõ các dòng món nhé.");
    const norm = normalizeReceipt(raw);
    if (!norm.ok) return fail("Mình không nhận ra dòng món nào trên hoá đơn 😔. Thử chụp rõ hơn nhé.");
    const draft = norm.draft;

    const id = shortId();
    await env.DB.prepare(
      `INSERT INTO pending_actions (id, chat_id, user_id, user_name, event_id, tool, args_json, status, created_at)
       VALUES (?1,?2,?3,?4,?5,'receipt_items',?6,'pending',?7)`,
    ).bind(id, chatId, from.id, from.first_name ?? null, event.id, JSON.stringify(draft), Date.now()).run();

    // web_app buttons only work in private chats; groups get a t.me deep link
    // (requires the bot's Main Mini App to be enabled in BotFather).
    const button = isPrivate
      ? { text: "📝 Kiểm tra & chia", web_app: { url: `${env.WEBAPP_URL}?draft=${id}` } }
      : { text: "📝 Kiểm tra & chia", url: `https://t.me/${env.BOT_USERNAME}?startapp=draft_${id}` };

    await editText(env, chatId, messageId,
      `🧾 ${event.title}\nĐọc được ${draft.items.length} món · Tổng hoá đơn ${fmtVN(draft.totalDong)} ₫\n\nChạm để kiểm tra và chia cho mọi người (hết hạn sau 60 phút).`,
      { inline_keyboard: [[button]] });
  } catch (e) {
    console.error("receipt photo failed", e);
    await fail("Có lỗi khi đọc hoá đơn, thử lại sau nhé 🙏");
  }
}

// getFile → download → base64 data URL (Telegram photos are JPEG).
async function downloadPhotoAsDataUrl(env: Env, fileId: string): Promise<string | null> {
  const info = await (await tg(env, "getFile", { file_id: fileId })).json<any>();
  const path = info?.result?.file_path;
  if (!path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  // btoa over chunks — a spread of the whole array overflows the call stack.
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

function explainBuildError(built: BuildResult, roster: Participant[]): string {
  if (built.ok) return "";
  if (built.error === "unresolved") {
    const names = built.unresolved.map((u) => `'${u.name}'`).join(", ");
    const list = roster.map((p) => p.name).join(", ") || "(chưa có ai)";
    return `⚠️ Không tìm thấy ${names} trong nhóm.\nThành viên gồm: ${list}.`;
  }
  if (built.error === "no_amount") return 'Mình không rõ số tiền. Thử: "chia 540k cho Aya, Ben".';
  return "Mình không rõ chia cho ai. Nhớ ghi tên thành viên nhé."; // no_members
}

// ---- callback_query: button taps (bind / confirm) ----
async function handleCallback(cq: any, env: Env): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  if (!chatId || !messageId) { await answer(env, cq.id); return; }

  const [, action, id] = String(cq.data || "").split(":");
  if (action === "bind") return handleBind(env, cq, id, chatId, messageId);
  if (action === "yes" || action === "no") return handleConfirm(env, cq, action, id, chatId, messageId);
  await answer(env, cq.id);
}

async function handleBind(env: Env, cq: any, eventId: string, chatId: number, messageId: number): Promise<void> {
  // Authz: only bind an event the tapper actually belongs to.
  const events = await recentEventsForUser(env, cq.from.id, 20);
  const ev = events.find((e) => e.id === eventId);
  if (!ev) { await answer(env, cq.id, "Không phải sự kiện của bạn", true); return; }

  await bindEventToChat(env, chatId, eventId);
  await answer(env, cq.id, "Đã chọn ✅");
  await editText(env, chatId, messageId,
    `✅ Nhóm này giờ dùng: ${ev.title}.\nGõ "@${env.BOT_USERNAME} chia 100k cho A, B" để chia tiền.`);
}

async function handleConfirm(env: Env, cq: any, action: string, id: string, chatId: number, messageId: number): Promise<void> {
  const row = await env.DB.prepare(`SELECT * FROM pending_actions WHERE id = ?1`).bind(id).first<any>();
  if (!row) {
    await answer(env, cq.id, "Yêu cầu không còn nữa");
    await editText(env, chatId, messageId, "Yêu cầu đã hết hiệu lực.");
    return;
  }
  if (cq.from.id !== row.user_id) { await answer(env, cq.id, "Không phải của bạn 🙅", true); return; }
  if (row.status !== "pending") { await answer(env, cq.id); return; } // already done/cancelled

  if (Date.now() - row.created_at > TTL_MS) {
    await setStatus(env, id, "expired");
    await answer(env, cq.id, "Hết hạn");
    await editText(env, chatId, messageId, "⏰ Hết hạn — gõ lại nhé.");
    return;
  }

  if (action === "no") {
    await setStatus(env, id, "cancelled");
    await answer(env, cq.id, "Đã huỷ");
    await editText(env, chatId, messageId, "❌ Đã huỷ.");
    return;
  }

  // Yes: consume the row atomically so a double-tap / race can't double-write.
  const consume = await env.DB.prepare(
    `UPDATE pending_actions SET status='done' WHERE id = ?1 AND status='pending'`,
  ).bind(id).run();
  if (consume.meta.changes !== 1) { await answer(env, cq.id); return; }

  try {
    const summary = await executeSplit(env, row);
    await answer(env, cq.id, "Đã lưu ✅");
    await editText(env, chatId, messageId, summary);
  } catch (e) {
    if (e instanceof StaleError) {
      await setStatus(env, id, "expired");
      await answer(env, cq.id, "Danh sách đã đổi");
      await editText(env, chatId, messageId, "⚠️ Thành viên đã thay đổi — gõ lại nhé.");
    } else {
      console.error("executeSplit failed", e);
      // Roll back to pending so the (still-visible) buttons can retry.
      await env.DB.prepare(
        `UPDATE pending_actions SET status='pending' WHERE id = ?1 AND status='done'`,
      ).bind(id).run();
      await answer(env, cq.id, "Có lỗi, thử lại", true);
    }
  }
}

// Auto-join the payer, re-validate members still exist, write the expense, return
// the fresh settlement text. Throws StaleError if a member vanished since parsing.
async function executeSplit(env: Env, row: any): Promise<string> {
  const args = JSON.parse(row.args_json) as {
    title: string; amount: number; members: { participantId: string; weight: number }[];
  };

  const existing = new Set((await listParticipants(env, row.event_id)).map((p) => p.id));
  if (args.members.some((m) => !existing.has(m.participantId))) throw new StaleError();

  const payerId = await ensureParticipant(env, row.event_id, {
    id: row.user_id,
    first_name: row.user_name || undefined,
  });

  const splits = args.members.map((m) => ({ participantId: m.participantId, included: true, weight: m.weight }));
  await writeExpense(env, { participantId: payerId, userId: row.user_id }, row.event_id, {
    title: args.title, amount: args.amount, splits,
  });

  const summary = await eventSummaryText(env, row.event_id);
  return `✅ Đã lưu: ${args.title} — ${fmtVN(args.amount)} ₫\n\n${summary ?? ""}`.trim();
}

// ---- small helpers ----
async function setStatus(env: Env, id: string, status: string): Promise<void> {
  await env.DB.prepare(`UPDATE pending_actions SET status = ?2 WHERE id = ?1 AND status='pending'`)
    .bind(id, status).run();
}

async function answer(env: Env, callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
  await tg(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    show_alert: showAlert,
  });
}

async function editText(env: Env, chatId: number, messageId: number, text: string, replyMarkup?: unknown): Promise<void> {
  // Omitting reply_markup drops the inline keyboard — correct for terminal outcomes.
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId, text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}
