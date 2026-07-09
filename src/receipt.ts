// Bill-photo (receipt) parsing layer.
//
// Same philosophy as nl.ts: the vision model is a *transcriber*, never the source
// of truth. It reads the photo and returns line items with amounts AS PRINTED
// (strings); everything numeric is derived here by pure, unit-tested functions.
// The result is only ever a pre-fill for the Mini App review screen — the user's
// confirmed payload is what gets written, so a misread is caught by a human, never
// silently committed. Identity (the payer) is the verified Telegram uploader,
// set by the caller — nothing in this file touches identity.
//
// Provider seam: the model id comes from env.AI_VISION_MODEL, and the impure
// surface is a single function with a provider-shaped signature — swapping to a
// stronger (paid) model later is a config change plus one alternate implementation.

// ---- types ----

// Untrusted model output. Amounts are verbatim printed strings ("540.000").
export interface RawReceipt {
  items: { name?: unknown; amount_raw?: unknown; qty?: unknown }[];
  total_raw?: unknown;
}

export interface DraftItem { name: string; amountDong: number }

// Trusted draft — only normalizeReceipt() constructs this. Integer đồng throughout.
// NOTE: VAT / service charges / discounts are intentionally NOT modeled yet — the
// OCR path extracts line items + the printed total only (deferred; see CLAUDE.md).
export interface ReceiptDraft {
  items: DraftItem[];
  totalDong: number;   // the total AS PRINTED on the bill
  reconciled: boolean; // Σ items === printed total (may be false when the bill adds tax/fees)
}

export type NormalizeResult = { ok: true; draft: ReceiptDraft } | { ok: false; error: string };

const MAX_DONG = 10_000_000_000; // 10 tỷ — same runaway guard as nl.ts
const MAX_ITEMS = 40;
const MAX_NAME = 80;

// ---- printed-amount parsing (the 1000× trap) ----
// Vietnamese receipts print "540.000" (dot = thousands separator) — parseFloat
// would read that as 540 đồng, a 1000× error against the integer-đồng invariant.
// This parser treats BOTH "." and "," as grouping marks when they group digits in
// threes, and rejects true decimals outright (VND has no sub-unit).
//   "540.000" → 540000   "540,000" → 540000   "1.234.567" → 1234567
//   "45.000đ" → 45000    "540000"  → 540000   "5.5" → null   "1.23" → null
export function parsePrintedAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (!Number.isInteger(v)) return null; // a printed VND amount is never fractional
    return sane(v);
  }
  if (typeof v !== "string") return null;

  // Strip currency marks and whitespace: "45.000 đ", "45.000₫", "45.000 VND", "45.000d"
  let s = v
    .replace(/[\s ]/g, "")
    .replace(/(vnd|vnđ|đ|₫|d)$/i, "");
  // Allow a leading minus (discount lines print e.g. "-20.000").
  let sign = 1;
  if (s.startsWith("-")) { sign = -1; s = s.slice(1); }
  if (!/^\d[\d.,]*$/.test(s)) return null;

  const groups = s.split(/[.,]/);
  if (groups.length > 1) {
    // Every group after the first must be exactly 3 digits → separators are
    // thousands marks. Anything else ("5.5", "1.23", "12.34.5") is not a VND print.
    if (!groups.slice(1).every((g) => g.length === 3)) return null;
    if (groups[0].length === 0 || groups[0].length > 3) return null;
  }
  const n = sign * Number(groups.join(""));
  return sane(n);
}

function sane(n: number): number | null {
  if (!Number.isFinite(n) || n === 0) return null;
  if (Math.abs(n) > MAX_DONG) return null;
  return n;
}

// ---- normalize model output → trusted draft (pure) ----

export function normalizeReceipt(raw: RawReceipt): NormalizeResult {
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  if (rawItems.length === 0) return { ok: false, error: "no_items" };
  if (rawItems.length > MAX_ITEMS) return { ok: false, error: "too_many_items" };

  const items: DraftItem[] = [];
  for (const it of rawItems) {
    const name = String((it as any)?.name ?? "").trim().slice(0, MAX_NAME);
    const amount = parsePrintedAmount((it as any)?.amount_raw);
    if (!name || amount == null || amount <= 0) continue; // skip unusable lines, keep the rest
    items.push({ name, amountDong: amount });
  }
  if (items.length === 0) return { ok: false, error: "no_items" };

  // VAT / service / discount are deferred — we take line items and the printed total.
  const itemSum = items.reduce((a, b) => a + b.amountDong, 0);
  const printedTotal = parsePrintedAmount(raw?.total_raw);
  // If the model missed the total line, fall back to our own item sum.
  const totalDong = printedTotal != null && printedTotal > 0 ? printedTotal : itemSum;
  if (totalDong <= 0) return { ok: false, error: "no_total" };

  return { ok: true, draft: { items, totalDong, reconciled: itemSum === totalDong } };
}

// ---- prompt + response schema ----

// JSON schema handed to the model via response_format so output is machine-parseable.
export const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Tên món đúng như in trên hoá đơn" },
          amount_raw: { type: "string", description: "Thành tiền của dòng, GIỮ NGUYÊN như in (ví dụ '540.000')" },
          qty: { type: "number", description: "Số lượng nếu in trên hoá đơn" },
        },
        required: ["name", "amount_raw"],
      },
    },
    total_raw: { type: "string", description: "Tổng cộng phải trả, GIỮ NGUYÊN như in" },
  },
  required: ["items", "total_raw"],
} as const;

export function buildReceiptPrompt(): string {
  return [
    "Bạn là máy đọc hoá đơn Việt Nam. Chép lại các dòng món ăn/đồ uống từ ẢNH hoá đơn thành JSON.",
    "Quy tắc BẮT BUỘC:",
    "- amount_raw và total_raw: chép NGUYÊN VĂN số tiền như in trên giấy (ví dụ '540.000' hay '1.234.567đ'). KHÔNG tự đổi định dạng, KHÔNG tự tính toán.",
    "- Mỗi dòng món là thành tiền của dòng đó (đã nhân số lượng nếu hoá đơn in vậy).",
    "- total_raw là số TỔNG CỘNG khách phải trả (in trên hoá đơn).",
    "- CHỈ chép các dòng món. BỎ QUA các dòng thuế/VAT/phí phục vụ/giảm giá (chưa xử lý).",
    "- Không bịa dòng không có trên hoá đơn. Bỏ qua các dòng không phải món (địa chỉ, lời cảm ơn...).",
  ].join("\n");
}

// ---- the one impure function: call Workers AI vision (timeout + retry) ----
// Vision inference is slower than text — 25s timeout, 2 attempts. On a response
// that isn't valid JSON we retry once; the caller treats null as "unreadable photo".

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ai timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Pull the JSON object out of a model response that may be a string, an object,
// or JSON wrapped in prose/markdown fences.
export function extractReceiptJson(res: any): RawReceipt | null {
  let out = res?.response ?? res;
  if (out && typeof out === "object" && Array.isArray((out as any).items)) return out as RawReceipt;
  if (typeof out !== "string") return null;
  const text = out.trim();
  // Try verbatim, then the first {...} block (fenced or inline).
  for (const candidate of [text, text.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) return parsed as RawReceipt;
    } catch { /* fall through */ }
  }
  return null;
}

export async function parseReceiptWithAI(
  ai: Ai,
  model: string,
  imageDataUrl: string,
): Promise<RawReceipt | null> {
  const messages = [
    { role: "system", content: buildReceiptPrompt() },
    {
      role: "user",
      content: [
        { type: "text", text: "Đọc hoá đơn trong ảnh này và trả về JSON." },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withTimeout(
        ai.run(model as any, {
          messages,
          response_format: { type: "json_schema", json_schema: RECEIPT_SCHEMA },
        } as any),
        25_000,
      );
      const raw = extractReceiptJson(res);
      if (raw) return raw;
      lastErr = new Error("unparseable model output");
    } catch (e) {
      lastErr = e;
    }
  }
  console.error("receipt parse failed", lastErr);
  return null; // caller replies "không đọc được ảnh"
}
