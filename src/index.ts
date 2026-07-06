import { handleWebhook } from "./telegram";
import { handleApi } from "./api";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOT_TOKEN: string;       // secret
  WEBHOOK_SECRET: string;  // secret — echoed by Telegram in a header
  WEBAPP_URL: string;      // var — public URL of this Worker (the Mini App)
  DEV_MODE?: string;       // "true" enables the X-Dev-User bypass for local testing
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Dev-User",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/webhook" && req.method === "POST") {
      return handleWebhook(req, env);
    }

    if (url.pathname.startsWith("/api/")) {
      const res = await handleApi(req, env, url);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
      return out;
    }

    // Everything else is the Mini App front-end (served from ./public).
    return env.ASSETS.fetch(req);
  },
};
