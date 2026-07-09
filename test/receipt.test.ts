import { describe, it, expect } from "vitest";
import {
  parsePrintedAmount, normalizeReceipt, extractReceiptJson, type RawReceipt,
} from "../src/receipt";

describe("parsePrintedAmount (printed VND → integer đồng)", () => {
  const cases: [unknown, number | null][] = [
    // The 1000× trap: dot/comma are thousands separators on VN receipts.
    ["540.000", 540000],
    ["540,000", 540000],
    ["1.234.567", 1234567],
    ["1,234,567", 1234567],
    ["540000", 540000],
    ["45.000đ", 45000],
    ["45.000 ₫", 45000],
    ["45.000d", 45000],
    ["120.000 VND", 120000],
    ["120.000vnđ", 120000],
    ["-20.000", -20000], // discount lines
    [540000, 540000],
    // True decimals are not VND prints — reject rather than guess.
    ["5.5", null],
    ["1.23", null],
    ["12.34.5", null],
    [540.5, null],
    // Garbage / out of range.
    ["0", null],
    [0, null],
    ["abc", null],
    ["45k", null],
    ["", null],
    [null, null],
    [{}, null],
    ["99.000.000.000", null], // > 10 tỷ guard
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(parsePrintedAmount(input)).toBe(expected);
    });
  }
});

describe("normalizeReceipt", () => {
  const cafe: RawReceipt = {
    items: [
      { name: "Cà phê sữa", amount_raw: "45.000" },
      { name: "Bạc xỉu", amount_raw: "50.000" },
      { name: "Trà đào", amount_raw: "55.000" },
    ],
    total_raw: "150.000",
  };

  it("parses a clean café bill and reconciles", () => {
    const r = normalizeReceipt(cafe);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.items).toEqual([
      { name: "Cà phê sữa", amountDong: 45000 },
      { name: "Bạc xỉu", amountDong: 50000 },
      { name: "Trà đào", amountDong: 55000 },
    ]);
    expect(r.draft.totalDong).toBe(150000);
    expect(r.draft.reconciled).toBe(true);
  });

  it("flags an unreconciled total (model misread) instead of trusting it", () => {
    const r = normalizeReceipt({ ...cafe, total_raw: "160.000" });
    expect(r.ok && !r.draft.reconciled).toBe(true);
    if (r.ok) expect(r.draft.totalDong).toBe(160000); // printed total kept — user arbitrates
  });

  it("ignores tax/fee lines: items-only sum, printed total kept as reference", () => {
    // VAT/service are deferred — the model is told to skip them, but even if a
    // fee slips through as the printed total, we keep items separate and just flag
    // the mismatch rather than modeling the charge.
    const r = normalizeReceipt({
      items: [{ name: "Lẩu bò", amount_raw: "500.000" }],
      total_raw: "565.000", // bill total includes tax/fee we don't itemize
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.items).toEqual([{ name: "Lẩu bò", amountDong: 500000 }]);
    expect(r.draft.totalDong).toBe(565000);
    expect(r.draft.reconciled).toBe(false); // 500k items ≠ 565k total → user sees the gap
    expect("charges" in r.draft).toBe(false);
  });

  it("falls back to its own sum when the total line is missing", () => {
    const r = normalizeReceipt({ items: cafe.items, total_raw: undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.totalDong).toBe(150000);
    expect(r.draft.reconciled).toBe(true);
  });

  it("skips unusable lines but keeps the rest", () => {
    const r = normalizeReceipt({
      items: [
        { name: "Cà phê", amount_raw: "45.000" },
        { name: "", amount_raw: "10.000" },        // no name
        { name: "Rác", amount_raw: "abc" },        // unparseable amount
        { name: "Khuyến mãi", amount_raw: "0" },   // zero
      ],
      total_raw: "45.000",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.items).toHaveLength(1);
    expect(r.draft.reconciled).toBe(true);
  });

  it("caps item name length at 80 chars", () => {
    const r = normalizeReceipt({
      items: [{ name: "x".repeat(200), amount_raw: "10.000" }],
      total_raw: "10.000",
    });
    expect(r.ok && r.draft.items[0].name.length === 80).toBe(true);
  });

  it("rejects empty, all-garbage, and oversized receipts", () => {
    expect(normalizeReceipt({ items: [] } as any).ok).toBe(false);
    expect(normalizeReceipt({} as any).ok).toBe(false);
    expect(normalizeReceipt({
      items: [{ name: "Rác", amount_raw: "abc" }], total_raw: "10.000",
    }).ok).toBe(false);
    expect(normalizeReceipt({
      items: Array.from({ length: 41 }, (_, i) => ({ name: `Món ${i}`, amount_raw: "10.000" })),
      total_raw: "410.000",
    }).ok).toBe(false);
  });
});

describe("extractReceiptJson (model output → RawReceipt)", () => {
  const obj = { items: [{ name: "Phở", amount_raw: "65.000" }], total_raw: "65.000" };

  it("accepts an already-parsed object response", () => {
    expect(extractReceiptJson({ response: obj })).toEqual(obj);
    expect(extractReceiptJson(obj)).toEqual(obj);
  });

  it("parses a JSON string response", () => {
    expect(extractReceiptJson({ response: JSON.stringify(obj) })).toEqual(obj);
  });

  it("recovers JSON wrapped in markdown fences / prose", () => {
    const wrapped = "Đây là kết quả:\n```json\n" + JSON.stringify(obj) + "\n```";
    expect(extractReceiptJson({ response: wrapped })).toEqual(obj);
  });

  it("returns null for junk", () => {
    expect(extractReceiptJson({ response: "xin chào" })).toBeNull();
    expect(extractReceiptJson({ response: '{"foo": 1}' })).toBeNull();
    expect(extractReceiptJson(undefined)).toBeNull();
  });
});
