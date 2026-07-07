import type { Env } from "./index";

// Thin wrapper around the Telegram Bot API.
export async function tg(env: Env, method: string, payload: unknown): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// Handles POST /webhook — the updates Telegram pushes to us.
export async function handleWebhook(req: Request, env: Env): Promise<Response> {
  // Telegram echoes the secret we set via setWebhook. Reject anything else.
  if (env.WEBHOOK_SECRET && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: any;
  try { update = await req.json(); } catch { return new Response("ok"); }

  const msg = update.message;
  if (msg && typeof msg.text === "string") {
    const text: string = msg.text.trim();
    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === "private";

    if (text.startsWith("/start") || text.startsWith("/split")) {
      if (isPrivate) {
        // In private chats an inline web_app button can open the Mini App directly.
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "Chào mừng đến với Tally — chia chi phí sự kiện và xem ai nợ ai.\n\nChạm bên dưới để mở ứng dụng.",
          reply_markup: {
            inline_keyboard: [[{ text: "💸 Mở Tally", web_app: { url: env.WEBAPP_URL } }]],
          },
        });
      } else {
        // In groups, web_app links must come from the chat menu button (set once — see README).
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "Tally đã sẵn sàng cho nhóm này. Chạm nút menu của bot (☰ cạnh ô nhập tin nhắn) để mở công cụ chia chi phí.",
        });
      }
    } else if (text.startsWith("/help")) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Tally giúp chia chi phí chung.\n• /start — mở ứng dụng\n• Tạo sự kiện, thêm khoản chi, đặt trọng số cho người trả nhiều hơn một phần, rồi bấm Quyết toán.",
      });
    }
  }

  // Always 200 quickly so Telegram doesn't retry.
  return new Response("ok");
}
