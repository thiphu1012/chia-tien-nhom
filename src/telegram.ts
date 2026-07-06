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
          text: "Welcome to Tally — split event expenses and see who owes whom.\n\nTap below to open the app.",
          reply_markup: {
            inline_keyboard: [[{ text: "💸 Open Tally", web_app: { url: env.WEBAPP_URL } }]],
          },
        });
      } else {
        // In groups, web_app links must come from the chat menu button (set once — see README).
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "Tally is ready for this group. Tap the bot's menu button (☰ next to the message box) to open the expense splitter.",
        });
      }
    } else if (text.startsWith("/help")) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Tally splits shared expenses.\n• /start — open the app\n• Create an event, add expenses, set a weight for anyone paying for more than one share, then Settle up.",
      });
    }
  }

  // Always 200 quickly so Telegram doesn't retry.
  return new Response("ok");
}
