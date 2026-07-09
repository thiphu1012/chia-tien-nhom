// Natural-language layer for the Telegram bot.
//
// The model is a *parser/router*, never the source of truth: it turns free text
// ("chia 540k cho Aya, Ben") into structured `split_expense` arguments. Everything
// here except `parseWithAI` is a pure function so it can be unit-tested without a
// Worker runtime — and so a misparse is caught by validation/confirmation, never
// silently written. Identity (the payer) is set by the caller from the verified
// Telegram user, NOT by anything in this file.

export interface Participant {
  id: string;
  name: string;
}

// ---- text normalization (diacritics-insensitive, đ→d) ----
// "Phú" → "phu", "Đức" → "duc" — so name matching is forgiving of accents/case.
export function norm(s: string): string {
  return String(s)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")        // strip combining diacritical marks
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .trim();
}

// ---- amount parsing (integer đồng) ----
// Accepts a number, or the Vietnamese shorthand the model may echo:
//   540000 · "540k" · "540 nghìn" · "1,5tr" · "2 triệu" · "2m" · "3 củ"
// Returns whole đồng, or null if it can't be parsed to a sane positive amount.
const UNIT: Record<string, number> = {
  "": 1,
  k: 1e3, nghin: 1e3, ngan: 1e3, ng: 1e3,
  tr: 1e6, trieu: 1e6, m: 1e6, cu: 1e6,
};
const MAX_DONG = 10_000_000_000; // 10 tỷ — guard against a runaway parse

export function parseAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const n = Math.round(v);
    return n > 0 && n <= MAX_DONG ? n : null;
  }
  if (typeof v !== "string") return null;
  const m = norm(v).replace(/\s+/g, " ").trim()
    .match(/^(\d+(?:[.,]\d+)?)\s*(k|nghin|ngan|ng|tr|trieu|m|cu)?$/);
  if (!m) return null;
  const mult = UNIT[m[2] ?? ""] ?? 1;
  const n = Math.round(parseFloat(m[1].replace(",", ".")) * mult);
  return n > 0 && n <= MAX_DONG ? n : null;
}

// ---- name resolution ladder: exact → unique prefix → refuse (never guess) ----
export type NameHit =
  | { id: string }
  | { error: "unknown" | "ambiguous" };

export function resolveName(input: string, participants: Participant[]): NameHit {
  const q = norm(input);
  if (!q) return { error: "unknown" };
  const exact = participants.filter((p) => norm(p.name) === q);
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return { error: "ambiguous" };
  const prefix = participants.filter((p) => norm(p.name).startsWith(q));
  if (prefix.length === 1) return { id: prefix[0].id };
  if (prefix.length > 1) return { error: "ambiguous" };
  return { error: "unknown" };
}

// ---- the one tool ----
export const SPLIT_EXPENSE_TOOL = {
  name: "split_expense",
  description:
    "Split one shared expense among event members, optionally with weights " +
    "(a member counts as 2 shares if they cover a partner). Call this when the " +
    "user describes paying for something to be divided.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short label for what the expense was for" },
      amount: {
        type: "number",
        description: "Total amount in whole đồng (e.g. 540k → 540000, 1.5tr → 1500000)",
      },
      members: {
        type: "array",
        description: "The members included in the split, by name as the user wrote them",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Member name" },
            weight: { type: "integer", description: "Shares this member owes; default 1, double = 2" },
          },
          required: ["name"],
        },
      },
    },
    required: ["amount", "members"],
  },
} as const;

export function buildSystemPrompt(participantNames: string[]): string {
  const roster = participantNames.length ? participantNames.join(", ") : "(chưa có thành viên)";
  return [
    "Bạn là trợ lý chia tiền cho nhóm. Nhiệm vụ: chuyển tin nhắn của người dùng thành MỘT lời gọi công cụ split_expense.",
    "Quy tắc:",
    "- Số tiền tính theo đồng (VND, không có xu). '540k'→540000, '1,5tr' hoặc '1.5tr'→1500000, '2 triệu'→2000000.",
    "- weight là số phần một người chịu: mặc định 1; 'tính đôi'/'x2'/'cho cả người yêu' → 2.",
    "- Chỉ dùng tên có trong danh sách thành viên. KHÔNG bịa thêm người. Giữ nguyên tên như người dùng viết.",
    "- Nếu tin nhắn không phải yêu cầu chia tiền, đừng gọi công cụ.",
    `Thành viên hiện có: ${roster}.`,
    "Ví dụ: 'chia 540k cho Aya, Ben tính đôi' → split_expense(amount=540000, members=[{name:'Aya',weight:1},{name:'Ben',weight:2}]).",
  ].join("\n");
}

// ---- validate model output + resolve names → participant ids (pure) ----
export interface ResolvedMember { participantId: string; weight: number; name: string }
export type BuildResult =
  | { ok: true; title: string; amount: number; members: ResolvedMember[] }
  | { ok: false; error: "no_amount" | "no_members"; }
  | { ok: false; error: "unresolved"; unresolved: { name: string; reason: "unknown" | "ambiguous" }[] };

export interface RawSplitArgs { title?: unknown; amount?: unknown; members?: unknown }

function clampWeight(w: unknown): number {
  const n = Math.round(Number(w));
  if (!Number.isFinite(n)) return 1;
  return Math.min(20, Math.max(1, n));
}

export function buildSplitArgs(raw: RawSplitArgs, participants: Participant[]): BuildResult {
  const amount = parseAmount(raw.amount);
  if (amount == null) return { ok: false, error: "no_amount" };

  const rawMembers = Array.isArray(raw.members) ? raw.members : [];
  if (rawMembers.length === 0) return { ok: false, error: "no_members" };

  const unresolved: { name: string; reason: "unknown" | "ambiguous" }[] = [];
  const byId = new Map<string, ResolvedMember>();
  for (const m of rawMembers) {
    const name = String((m as any)?.name ?? "").trim();
    if (!name) continue;
    const hit = resolveName(name, participants);
    if ("error" in hit) {
      unresolved.push({ name, reason: hit.error });
      continue;
    }
    const weight = clampWeight((m as any)?.weight);
    // First mention of a person wins; a repeated name doesn't double them.
    if (!byId.has(hit.id)) {
      const p = participants.find((x) => x.id === hit.id)!;
      byId.set(hit.id, { participantId: hit.id, weight, name: p.name });
    }
  }

  if (unresolved.length) return { ok: false, error: "unresolved", unresolved };
  const members = [...byId.values()];
  if (members.length === 0) return { ok: false, error: "no_members" };

  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 80) : "Khoản chi";
  return { ok: true, title, amount, members };
}

// ---- the only impure function: call Workers AI (timeout + one retry) ----
// Returns the raw tool arguments, or null when the model produced no tool call
// (understood as "not a split command"). Throws only on hard failure (timeout /
// network / repeated error) so the caller can reply "bận, thử lại sau".
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ai timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function extractToolCall(res: any): RawSplitArgs | null {
  const calls = res?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const call = calls.find((c: any) => c?.name === "split_expense") ?? calls[0];
  let args = call?.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (!args || typeof args !== "object") return null;
  return args as RawSplitArgs;
}

export async function parseWithAI(
  ai: Ai,
  model: string,
  query: string,
  participantNames: string[],
): Promise<RawSplitArgs | null> {
  const messages = [
    { role: "system", content: buildSystemPrompt(participantNames) },
    { role: "user", content: query },
  ];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withTimeout(
        ai.run(model as any, { messages, tools: [SPLIT_EXPENSE_TOOL] } as any),
        12_000,
      );
      return extractToolCall(res); // may be null → "not a split command"
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("ai parse failed");
}
