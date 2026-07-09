import { describe, it, expect } from "vitest";
import { splitCents, netBalances, settle, type SettleExpense } from "../src/settle";

describe("splitCents (largest-remainder, integer đồng)", () => {
  it("distributes exactly — parts always sum to the total, no invented đồng", () => {
    const cases: [number, number[]][] = [
      [100, [1, 1, 1]],
      [540000, [1, 2, 1]],
      [7, [1, 1, 1, 1]],
      [0, [1, 1]],
      [999999, [3, 5, 7]],
      [1, [1, 1, 1, 1, 1]],
    ];
    for (const [total, weights] of cases) {
      const parts = splitCents(total, weights);
      expect(parts).toHaveLength(weights.length);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
    }
  });

  it("hands leftover units to the largest fractional remainders", () => {
    // 10 / 3 = 3.33… → one part rounds up to 4
    expect(splitCents(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });

  it("returns zeros when total weight is zero", () => {
    expect(splitCents(100, [0, 0])).toEqual([0, 0]);
  });

  it("handles fractional weights (0.5 = came late, 2 = covers a partner) exactly", () => {
    const cases: [number, number[]][] = [
      [540000, [0.5, 2, 1]],   // hotpot: Mike 0.5, Ayna 2, one normal
      [100, [0.5, 0.5]],
      [99999, [0.5, 1.5, 2.5]],
      [7, [0.5, 1]],
    ];
    for (const [total, weights] of cases) {
      const parts = splitCents(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
    }
    // Ratios hold: 0.5 : 2 : 1 over 540000 → 77143 / 308571 / 154286 (±1 đồng rounding)
    const [mike, ayna, c] = splitCents(540000, [0.5, 2, 1]);
    expect(Math.abs(mike - 540000 * (0.5 / 3.5))).toBeLessThanOrEqual(1);
    expect(Math.abs(ayna - 540000 * (2 / 3.5))).toBeLessThanOrEqual(1);
    expect(Math.abs(c - 540000 * (1 / 3.5))).toBeLessThanOrEqual(1);
  });
});

describe("netBalances + settle", () => {
  it("net balances sum to exactly zero and settlement clears everyone", () => {
    const ids = ["a", "b", "c"];
    const expenses: SettleExpense[] = [
      { amount: 300, paidBy: "a", splits: ids.map((id) => ({ participantId: id, included: true, weight: 1 })) },
      {
        amount: 90, paidBy: "b",
        splits: [
          { participantId: "b", included: true, weight: 1 },
          { participantId: "c", included: true, weight: 2 },
        ],
      },
    ];

    const net = netBalances(ids, expenses);
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);

    const txns = settle(net);
    expect(txns.every((t) => t.amount > 0)).toBe(true);

    // Apply every transfer; all balances should land on exactly zero.
    const bal: Record<string, number> = { ...net };
    for (const t of txns) { bal[t.from] += t.amount; bal[t.to] -= t.amount; }
    for (const id of ids) expect(bal[id]).toBe(0);
  });

  it("respects fixed per-member amounts, remainder split by weight", () => {
    const ids = ["a", "b", "c"];
    const expenses: SettleExpense[] = [{
      amount: 100, paidBy: "a",
      splits: [
        { participantId: "a", included: true, weight: 1, amount: 40 }, // locked
        { participantId: "b", included: true, weight: 1 },
        { participantId: "c", included: true, weight: 1 },
      ],
    }];
    const net = netBalances(ids, expenses);
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
    // a paid 100, owes 40 → net +60; b and c split the remaining 60 → owe 30 each
    expect(net.a).toBe(60);
    expect(net.b).toBe(-30);
    expect(net.c).toBe(-30);
  });

  it("nets fractional weights to a zero sum end-to-end", () => {
    const ids = ["mike", "ayna", "chi"];
    const expenses: SettleExpense[] = [{
      amount: 700000, paidBy: "chi",
      splits: [
        { participantId: "mike", included: true, weight: 0.5 },
        { participantId: "ayna", included: true, weight: 2 },
        { participantId: "chi", included: true, weight: 1 },
      ],
    }];
    const net = netBalances(ids, expenses);
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
    expect(net.mike).toBe(-100000); // 700000 × (0.5 / 3.5)
    expect(net.ayna).toBe(-400000); // 700000 × (2 / 3.5)
    expect(net.chi).toBe(500000);   // paid 700000, owes 200000
  });
});
