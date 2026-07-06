// Verify the `initData` string a Telegram Mini App sends, so the backend can
// trust which real Telegram user is acting. Follows Telegram's documented scheme:
//   secret_key = HMAC_SHA256(key="WebAppData", data=<bot_token>)
//   check      = HMAC_SHA256(key=secret_key, data=<data_check_string>)
// where data_check_string is the sorted "key=value" lines joined by "\n" (hash excluded).

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface VerifyResult {
  ok: boolean;
  user?: TgUser;
  startParam?: string;
  reason?: string;
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: Uint8Array): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, msg);
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86400,
): Promise<VerifyResult> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };
  params.delete("hash");

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return { ok: false, reason: "stale auth_date" };
  }

  const dataCheckString = [...params.keys()]
    .sort()
    .map((k) => `${k}=${params.get(k)}`)
    .join("\n");

  const enc = new TextEncoder();
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  const check = toHex(await hmac(secret, enc.encode(dataCheckString)));
  if (check !== hash) return { ok: false, reason: "bad signature" };

  let user: TgUser | undefined;
  const rawUser = params.get("user");
  if (rawUser) {
    try { user = JSON.parse(rawUser); } catch { /* ignore */ }
  }
  return { ok: true, user, startParam: params.get("start_param") || undefined };
}
