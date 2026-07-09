import { describe, it, expect } from "vitest";
import { norm, parseAmount, resolveName, buildSplitArgs, type Participant } from "../src/nl";

describe("norm", () => {
  it("strips Vietnamese diacritics and lowercases", () => {
    expect(norm("Phú")).toBe("phu");
    expect(norm("Đức")).toBe("duc");
    expect(norm("  Bình  ")).toBe("binh");
    expect(norm("AYA")).toBe("aya");
  });
});

describe("parseAmount (→ integer đồng)", () => {
  const cases: [unknown, number | null][] = [
    [540000, 540000],
    ["540k", 540000],
    ["540 nghìn", 540000],
    ["1,5tr", 1500000],
    ["1.5tr", 1500000],
    ["2 triệu", 2000000],
    ["2m", 2000000],
    ["3 củ", 3000000],
    ["100", 100],
    [100.7, 101],
    ["abc", null],
    ["0", null],
    [0, null],
    ["-5", null],
    [null, null],
    [{}, null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(parseAmount(input)).toBe(expected);
    });
  }
});

describe("resolveName (exact → unique prefix → refuse)", () => {
  const ps: Participant[] = [
    { id: "1", name: "Phú" },
    { id: "2", name: "Aya" },
    { id: "3", name: "Ben" },
  ];

  it("matches exactly, ignoring diacritics/case", () => {
    expect(resolveName("phu", ps)).toEqual({ id: "1" });
    expect(resolveName("PHÚ", ps)).toEqual({ id: "1" });
    expect(resolveName("aya", ps)).toEqual({ id: "2" });
  });

  it("matches a unique prefix", () => {
    expect(resolveName("A", ps)).toEqual({ id: "2" }); // only Aya starts with 'a'
  });

  it("refuses unknown names", () => {
    expect(resolveName("Xyz", ps)).toEqual({ error: "unknown" });
  });

  it("refuses ambiguous prefixes", () => {
    const two: Participant[] = [{ id: "1", name: "Ben" }, { id: "2", name: "Bình" }];
    expect(resolveName("B", two)).toEqual({ error: "ambiguous" });
  });
});

describe("buildSplitArgs (validate + resolve)", () => {
  const ps: Participant[] = [
    { id: "1", name: "Aya" },
    { id: "2", name: "Ben" },
    { id: "3", name: "Chi" },
  ];

  it("resolves names to ids, defaults + clamps weights", () => {
    const r = buildSplitArgs({ amount: "540k", members: [{ name: "Aya" }, { name: "Ben", weight: 2 }] }, ps);
    expect(r).toEqual({
      ok: true,
      title: "Khoản chi",
      amount: 540000,
      members: [
        { participantId: "1", weight: 1, name: "Aya" },
        { participantId: "2", weight: 2, name: "Ben" },
      ],
    });
  });

  it("clamps an out-of-range weight to 20", () => {
    const r = buildSplitArgs({ amount: 100, members: [{ name: "Aya", weight: 999 }] }, ps);
    expect(r.ok && r.members[0].weight).toBe(20);
  });

  it("dedupes a repeated person (first mention wins)", () => {
    const r = buildSplitArgs({ amount: 100, members: [{ name: "Aya" }, { name: "aya", weight: 5 }] }, ps);
    expect(r.ok && r.members).toHaveLength(1);
    expect(r.ok && r.members[0].weight).toBe(1);
  });

  it("rejects a bad amount", () => {
    expect(buildSplitArgs({ amount: "xyz", members: [{ name: "Aya" }] }, ps)).toEqual({ ok: false, error: "no_amount" });
  });

  it("rejects empty members", () => {
    expect(buildSplitArgs({ amount: 100, members: [] }, ps)).toEqual({ ok: false, error: "no_members" });
  });

  it("surfaces unresolved names instead of guessing", () => {
    const r = buildSplitArgs({ amount: 100, members: [{ name: "Aya" }, { name: "Zzz" }] }, ps);
    expect(r).toEqual({ ok: false, error: "unresolved", unresolved: [{ name: "Zzz", reason: "unknown" }] });
  });
});
