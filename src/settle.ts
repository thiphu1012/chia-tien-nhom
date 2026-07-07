// Pure math: weighted splits and debt simplification, all in integer đồng
// (VND has no sub-unit — see the money note in CLAUDE.md / schema.sql).

/**
 * Split an integer `total` (đồng) into parts proportional to `weights`,
 * where the parts sum EXACTLY to `total`. Leftover units from rounding are
 * handed out by the largest-remainder method so nothing is lost or invented.
 */
export function splitCents(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const res = raw.map(Math.floor);
  let remainder = total - res.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) res[byFrac[k % byFrac.length].i]++;
  return res;
}

export interface SettleSplit {
  participantId: string;
  included: boolean;
  weight: number;
  amount?: number | null; // fixed per-member amount (đồng); null/undefined = auto by weight
}

export interface SettleExpense {
  amount: number; // đồng
  paidBy: string; // participant id
  splits: SettleSplit[];
}

/**
 * Resolve each included member's share (đồng), summing EXACTLY to `total`.
 * Members with a fixed `amount` are "locked" to it; the remaining amount is
 * divided among the rest by weight (largest-remainder). The last member absorbs
 * any leftover so the shares always sum to the total (keeps net balances zero-sum).
 */
function resolveShares(total: number, incl: SettleSplit[]): number[] {
  const locked = incl.map((s) => (s.amount != null && s.amount >= 0) ? Math.round(s.amount) : null);
  const autoIdx: number[] = [];
  incl.forEach((_, i) => { if (locked[i] == null) autoIdx.push(i); });
  const lockedSum = locked.reduce<number>((a, v) => a + (v || 0), 0);
  const shares = locked.map((v) => (v == null ? 0 : v));
  if (autoIdx.length) {
    const remaining = Math.max(0, total - lockedSum);
    const auto = splitCents(remaining, autoIdx.map((i) => incl[i].weight));
    autoIdx.forEach((i, k) => { shares[i] = auto[k]; });
  }
  const sum = shares.reduce((a, b) => a + b, 0);
  shares[shares.length - 1] += total - sum; // guarantee exact sum == total
  return shares;
}

/** Net position per participant, in đồng. Positive = owed money, negative = owes. Sums to 0. */
export function netBalances(participantIds: string[], expenses: SettleExpense[]): Record<string, number> {
  const net: Record<string, number> = {};
  participantIds.forEach((id) => (net[id] = 0));
  for (const e of expenses) {
    const incl = e.splits.filter((s) => s.included && (s.weight > 0 || (s.amount != null && s.amount >= 0)));
    if (e.amount <= 0 || incl.length === 0) continue;
    net[e.paidBy] = (net[e.paidBy] || 0) + e.amount;
    const shares = resolveShares(e.amount, incl);
    incl.forEach((s, idx) => {
      net[s.participantId] = (net[s.participantId] || 0) - shares[idx];
    });
  }
  return net;
}

/** Greedy minimum-transfer settlement. Amounts in cents. */
export function settle(net: Record<string, number>): { from: string; to: string; amount: number }[] {
  const creditors: { id: string; amt: number }[] = [];
  const debtors: { id: string; amt: number }[] = [];
  for (const [id, bal] of Object.entries(net)) {
    if (bal > 0) creditors.push({ id, amt: bal });
    else if (bal < 0) debtors.push({ id, amt: -bal });
  }
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);
  const txns: { from: string; to: string; amount: number }[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0) txns.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return txns;
}
