// Pure math: weighted splits and debt simplification, all in integer cents.

/**
 * Split an integer `total` (cents) into parts proportional to `weights`,
 * where the parts sum EXACTLY to `total`. Leftover cents from rounding are
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

export interface SettleExpense {
  amount: number; // cents
  paidBy: string; // participant id
  splits: { participantId: string; included: boolean; weight: number }[];
}

/** Net position per participant, in cents. Positive = owed money, negative = owes. Sums to 0. */
export function netBalances(participantIds: string[], expenses: SettleExpense[]): Record<string, number> {
  const net: Record<string, number> = {};
  participantIds.forEach((id) => (net[id] = 0));
  for (const e of expenses) {
    const incl = e.splits.filter((s) => s.included && s.weight > 0);
    if (e.amount <= 0 || incl.length === 0) continue;
    net[e.paidBy] = (net[e.paidBy] || 0) + e.amount;
    const shares = splitCents(e.amount, incl.map((s) => s.weight));
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
