import React, { useState, useEffect, useMemo } from "react";
import {
  Plus, ChevronLeft, Users, Receipt, Trash2, Pencil, Check, X,
  Wallet, ArrowRight, Coins, UserRound, Minus, Copy, RefreshCw
} from "lucide-react";

// ---------- design tokens ----------
const C = {
  paper: "#EDEBE4",
  card: "#FFFFFF",
  ink: "#1B1D22",
  muted: "#6B6F76",
  line: "#E3E0D8",
  green: "#157F5B",
  greenSoft: "#E4F1EA",
  clay: "#B54B3A",
  claySoft: "#F6E7E2",
  amber: "#9A6B12",
  amberSoft: "#F4EBD4",
};

// ---------- money + math ----------
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n, cur = "$") => `${cur}${round2(Math.abs(n)).toFixed(2)}`;

function computeNet(event) {
  const net = {};
  event.participants.forEach((p) => (net[p.id] = 0));
  for (const e of event.expenses) {
    const amount = Number(e.amount) || 0;
    const incl = e.splits.filter((s) => s.included && Number(s.weight) > 0);
    const total = incl.reduce((s, x) => s + Number(x.weight), 0);
    if (amount <= 0 || total <= 0) continue;
    net[e.paidBy] = (net[e.paidBy] || 0) + amount;
    for (const s of incl) {
      net[s.participantId] =
        (net[s.participantId] || 0) - amount * (Number(s.weight) / total);
    }
  }
  Object.keys(net).forEach((k) => (net[k] = round2(net[k])));
  return net;
}

function settle(net) {
  const creditors = [], debtors = [];
  for (const [id, bal] of Object.entries(net)) {
    if (bal > 0.005) creditors.push({ id, amt: bal });
    else if (bal < -0.005) debtors.push({ id, amt: -bal });
  }
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);
  const txns = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    txns.push({ from: debtors[i].id, to: creditors[j].id, amt: round2(pay) });
    debtors[i].amt -= pay; creditors[j].amt -= pay;
    if (debtors[i].amt < 0.005) i++;
    if (creditors[j].amt < 0.005) j++;
  }
  return txns;
}

// ---------- seed data ----------
const uid = () => Math.random().toString(36).slice(2, 9);
function seed() {
  const p = [
    { id: "u_aya", name: "Aya" },
    { id: "u_ben", name: "Ben" },
    { id: "u_chi", name: "Chi" },
    { id: "u_duc", name: "Duc" },
  ];
  const mk = (ids, weights) =>
    p.map((pp) => ({
      participantId: pp.id,
      included: ids.includes(pp.id),
      weight: weights?.[pp.id] ?? 1,
    }));
  return [
    {
      id: uid(),
      name: "Đà Nẵng Trip",
      cur: "$",
      participants: p,
      expenses: [
        { id: uid(), title: "Airbnb (2 nights)", amount: 200, paidBy: "u_aya",
          createdBy: "u_aya", splits: mk(["u_aya","u_ben","u_chi","u_duc"]) },
        { id: uid(), title: "Seafood dinner", amount: 80, paidBy: "u_ben",
          createdBy: "u_ben", splits: mk(["u_aya","u_ben","u_chi","u_duc"], { u_ben: 2 }) },
        { id: uid(), title: "Grab taxis", amount: 40, paidBy: "u_chi",
          createdBy: "u_chi", splits: mk(["u_aya","u_ben","u_chi","u_duc"]) },
      ],
    },
  ];
}

// ---------- tiny UI atoms ----------
function Avatar({ name, size = 30, active }) {
  const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: size,
      background: active ? C.green : "#DFE7E1",
      color: active ? "#fff" : C.green,
      fontSize: size * 0.4, fontWeight: 700,
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>{initials}</div>
  );
}

function Bar({ children }) {
  return (
    <div style={{
      position: "sticky", bottom: 0, padding: "12px 16px 18px",
      background: `linear-gradient(to top, ${C.paper} 70%, transparent)`,
    }}>{children}</div>
  );
}

function CTA({ onClick, children, tone = "green", disabled }) {
  const bg = disabled ? "#C9C6BE" : tone === "green" ? C.green : C.card;
  const fg = tone === "green" ? "#fff" : C.ink;
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", padding: "14px", borderRadius: 14, border: tone === "green" ? "none" : `1.5px solid ${C.line}`,
      background: bg, color: fg, fontSize: 16, fontWeight: 700, cursor: disabled ? "default" : "pointer",
      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    }}>{children}</button>
  );
}

// ---------- main ----------
export default function App() {
  const [events, setEvents] = useState(seed);
  const [screen, setScreen] = useState({ name: "home" });
  const [me, setMe] = useState("u_aya"); // acting-as (simulates Telegram from-user)
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.ready?.(); tg.expand?.(); }
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);

  const event = events.find((e) => e.id === screen.eventId);
  const nameOf = (evt, id) => evt?.participants.find((p) => p.id === id)?.name || "?";

  const upsertEvent = (ev) =>
    setEvents((prev) => (prev.some((e) => e.id === ev.id)
      ? prev.map((e) => (e.id === ev.id ? ev : e)) : [...prev, ev]));

  const saveExpense = (evId, exp) =>
    setEvents((prev) => prev.map((e) => {
      if (e.id !== evId) return e;
      const exists = e.expenses.some((x) => x.id === exp.id);
      return { ...e, expenses: exists
        ? e.expenses.map((x) => (x.id === exp.id ? exp : x))
        : [...e.expenses, exp] };
    }));

  const deleteExpense = (evId, exId) =>
    setEvents((prev) => prev.map((e) =>
      e.id === evId ? { ...e, expenses: e.expenses.filter((x) => x.id !== exId) } : e));

  // ============ HOME ============
  function Home() {
    const [creating, setCreating] = useState(false);
    return (
      <>
        <div style={{ padding: "20px 16px 4px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5, color: C.ink }}>Tally</span>
            <Receipt size={20} color={C.green} />
          </div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>Split the tab, keep it even.</div>
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {events.length === 0 && !creating && (
            <div style={{ textAlign: "center", color: C.muted, padding: "40px 20px", fontSize: 14 }}>
              No events yet. Start one for your next trip or dinner.
            </div>
          )}
          {events.map((e) => {
            const total = e.expenses.reduce((s, x) => s + (Number(x.amount) || 0), 0);
            return (
              <button key={e.id} onClick={() => setScreen({ name: "event", eventId: e.id })}
                style={{ textAlign: "left", background: C.card, border: `1px solid ${C.line}`,
                  borderRadius: 16, padding: 16, cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 17, fontWeight: 700, color: C.ink }}>{e.name}</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: C.ink }}>{money(total, e.cur)}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
                  <div style={{ display: "flex" }}>
                    {e.participants.slice(0, 5).map((p, idx) => (
                      <div key={p.id} style={{ marginLeft: idx ? -8 : 0 }}><Avatar name={p.name} size={26} /></div>
                    ))}
                  </div>
                  <span style={{ color: C.muted, fontSize: 12, marginLeft: 4 }}>
                    {e.participants.length} people · {e.expenses.length} expenses
                  </span>
                </div>
              </button>
            );
          })}
          {creating && <NewEvent onDone={() => setCreating(false)} />}
        </div>

        {!creating && (
          <Bar><CTA onClick={() => setCreating(true)}><Plus size={18} /> New event</CTA></Bar>
        )}
      </>
    );
  }

  function NewEvent({ onDone }) {
    const [name, setName] = useState("");
    const [cur, setCur] = useState("$");
    const [names, setNames] = useState(["", ""]);
    const clean = names.map((n) => n.trim()).filter(Boolean);
    const ok = name.trim() && clean.length >= 2;
    const create = () => {
      const ev = {
        id: uid(), name: name.trim(), cur,
        participants: clean.map((n) => ({ id: uid(), name: n })),
        expenses: [],
      };
      upsertEvent(ev); onDone(); setScreen({ name: "event", eventId: ev.id });
    };
    return (
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16 }}>
        <Field label="Event name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekend in Da Nang"
            style={inp} autoFocus />
        </Field>
        <Field label="Currency">
          <input value={cur} onChange={(e) => setCur(e.target.value.slice(0, 3))} style={{ ...inp, width: 90 }} />
        </Field>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase",
          letterSpacing: 0.5, margin: "6px 0" }}>People</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {names.map((n, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              <input value={n} onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))}
                placeholder={`Person ${i + 1}`} style={inp} />
              {names.length > 2 && (
                <button onClick={() => setNames(names.filter((_, j) => j !== i))} style={iconBtn}>
                  <X size={16} color={C.muted} />
                </button>
              )}
            </div>
          ))}
          <button onClick={() => setNames([...names, ""])}
            style={{ ...ghostBtn, alignSelf: "flex-start" }}><Plus size={14} /> Add person</button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <CTA onClick={create} disabled={!ok}>Create event</CTA>
          <button onClick={onDone} style={{ ...ghostBtn, padding: "0 16px" }}>Cancel</button>
        </div>
      </div>
    );
  }

  // ============ EVENT ============
  function EventView() {
    const net = useMemo(() => computeNet(event), [event]);
    const total = event.expenses.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    return (
      <>
        <TopBar title={event.name} onBack={() => setScreen({ name: "home" })} />
        <div style={{ padding: "0 16px 4px" }}>
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16,
            padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ color: C.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Total spent</div>
              <div style={{ fontFamily: "monospace", fontSize: 26, fontWeight: 800, color: C.ink }}>{money(total, event.cur)}</div>
            </div>
            <div style={{ display: "flex" }}>
              {event.participants.map((p, i) => (
                <div key={p.id} style={{ marginLeft: i ? -8 : 0 }}>
                  <Avatar name={p.name} size={30} active={p.id === me} />
                </div>
              ))}
            </div>
          </div>

          {/* balances */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            {event.participants.map((p) => {
              const b = net[p.id] || 0;
              const pos = b > 0.005, neg = b < -0.005;
              return (
                <div key={p.id} style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 20,
                  background: pos ? C.greenSoft : neg ? C.claySoft : "#EEECE6",
                  color: pos ? C.green : neg ? C.clay : C.muted, fontSize: 13, fontWeight: 600,
                }}>
                  <Avatar name={p.name} size={20} />
                  {p.name} {pos ? "+" : neg ? "−" : ""}{money(b, event.cur)}
                </div>
              );
            })}
          </div>
        </div>

        {/* expenses */}
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Expenses
          </div>
          {event.expenses.length === 0 && (
            <div style={{ color: C.muted, fontSize: 14, padding: "8px 0" }}>No expenses yet. Add the first one.</div>
          )}
          {event.expenses.map((x) => {
            const mine = x.createdBy === me;
            const shared = x.splits.filter((s) => s.included).length;
            const weighted = x.splits.some((s) => s.included && Number(s.weight) !== 1);
            return (
              <div key={x.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{x.title}</div>
                    <div style={{ color: C.muted, fontSize: 13, marginTop: 3 }}>
                      {nameOf(event, x.paidBy)} paid · split {shared} way{shared > 1 ? "s" : ""}
                      {weighted ? " · weighted" : ""}
                    </div>
                  </div>
                  <div style={{ fontFamily: "monospace", fontWeight: 800, color: C.ink }}>{money(x.amount, event.cur)}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
                  {x.splits.filter((s) => s.included).map((s) => (
                    <div key={s.participantId} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      <Avatar name={nameOf(event, s.participantId)} size={22} />
                      {Number(s.weight) !== 1 && (
                        <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700,
                          color: C.amber, background: C.amberSoft, borderRadius: 6, padding: "1px 4px" }}>
                          ×{s.weight}
                        </span>
                      )}
                    </div>
                  ))}
                  <div style={{ flex: 1 }} />
                  {mine ? (
                    <>
                      <button style={iconBtn} onClick={() => setScreen({ name: "expense", eventId: event.id, expenseId: x.id })}>
                        <Pencil size={15} color={C.muted} />
                      </button>
                      <button style={iconBtn} onClick={() => deleteExpense(event.id, x.id)}>
                        <Trash2 size={15} color={C.clay} />
                      </button>
                    </>
                  ) : (
                    <span style={{ fontSize: 11, color: C.muted }}>by {nameOf(event, x.createdBy)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <Bar>
          <div style={{ display: "flex", gap: 8 }}>
            <CTA onClick={() => setScreen({ name: "expense", eventId: event.id })}><Plus size={18} /> Add expense</CTA>
            <button onClick={() => setScreen({ name: "settle", eventId: event.id })}
              disabled={event.expenses.length === 0}
              style={{ ...ghostBtn, padding: "0 16px", opacity: event.expenses.length === 0 ? 0.5 : 1 }}>
              <Wallet size={18} /> Settle
            </button>
          </div>
        </Bar>
      </>
    );
  }

  // ============ EXPENSE EDITOR ============
  function ExpenseEditor() {
    const editing = event.expenses.find((x) => x.id === screen.expenseId);
    const [title, setTitle] = useState(editing?.title || "");
    const [amount, setAmount] = useState(editing?.amount != null ? String(editing.amount) : "");
    const [paidBy, setPaidBy] = useState(editing?.paidBy || me);
    const [splits, setSplits] = useState(
      editing?.splits ||
      event.participants.map((p) => ({ participantId: p.id, included: true, weight: 1 }))
    );
    const amt = Number(amount) || 0;
    const incl = splits.filter((s) => s.included && Number(s.weight) > 0);
    const totalW = incl.reduce((s, x) => s + Number(x.weight), 0);
    const shareOf = (s) =>
      s.included && Number(s.weight) > 0 && totalW > 0 ? (amt * Number(s.weight)) / totalW : 0;
    const ok = title.trim() && amt > 0 && incl.length > 0;

    const setW = (id, d) => setSplits(splits.map((s) =>
      s.participantId === id ? { ...s, weight: Math.max(1, Number(s.weight) + d) } : s));
    const toggle = (id) => setSplits(splits.map((s) =>
      s.participantId === id ? { ...s, included: !s.included } : s));

    const save = () => {
      saveExpense(event.id, {
        id: editing?.id || uid(),
        title: title.trim(), amount: round2(amt), paidBy,
        createdBy: editing?.createdBy || me, splits,
      });
      setScreen({ name: "event", eventId: event.id });
    };

    return (
      <>
        <TopBar title={editing ? "Edit expense" : "New expense"}
          onBack={() => setScreen({ name: "event", eventId: event.id })} />
        <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16 }}>
            <Field label="What was it for?">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Seafood dinner" style={inp} autoFocus />
            </Field>
            <Field label="Amount">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700, color: C.muted }}>{event.cur}</span>
                <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0.00" inputMode="decimal"
                  style={{ ...inp, fontFamily: "monospace", fontSize: 20, fontWeight: 700 }} />
              </div>
            </Field>
            <Field label="Paid by">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {event.participants.map((p) => (
                  <button key={p.id} onClick={() => setPaidBy(p.id)} style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 6px 6px",
                    borderRadius: 20, cursor: "pointer", fontSize: 13, fontWeight: 600,
                    border: `1.5px solid ${paidBy === p.id ? C.green : C.line}`,
                    background: paidBy === p.id ? C.greenSoft : C.card,
                    color: paidBy === p.id ? C.green : C.ink,
                  }}>
                    <Avatar name={p.name} size={22} active={paidBy === p.id} /> {p.name}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          {/* split by people + weights */}
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Split between
              </div>
              <div style={{ fontSize: 12, color: C.muted }}>
                weight <span style={{ color: C.amber, fontWeight: 700 }}>×</span> = shares
              </div>
            </div>
            {event.participants.map((p) => {
              const s = splits.find((x) => x.participantId === p.id);
              return (
                <div key={p.id} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 0",
                  borderBottom: `1px solid ${C.line}`, opacity: s.included ? 1 : 0.45,
                }}>
                  <button onClick={() => toggle(p.id)} style={{
                    width: 22, height: 22, borderRadius: 6, cursor: "pointer",
                    border: `1.5px solid ${s.included ? C.green : C.line}`,
                    background: s.included ? C.green : C.card,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>{s.included && <Check size={14} color="#fff" />}</button>
                  <Avatar name={p.name} size={28} />
                  <span style={{ fontWeight: 600, color: C.ink, flex: 1 }}>{p.name}</span>

                  {s.included && (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 4,
                        background: C.amberSoft, borderRadius: 10, padding: 3 }}>
                        <button onClick={() => setW(p.id, -1)} style={stepBtn}><Minus size={13} color={C.amber} /></button>
                        <span style={{ fontFamily: "monospace", fontWeight: 800, color: C.amber, minWidth: 16, textAlign: "center" }}>
                          {s.weight}
                        </span>
                        <button onClick={() => setW(p.id, +1)} style={stepBtn}><Plus size={13} color={C.amber} /></button>
                      </div>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: C.ink, minWidth: 62, textAlign: "right" }}>
                        {money(shareOf(s), event.cur)}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 12, fontSize: 13 }}>
              <span style={{ color: C.muted }}>{totalW} share{totalW !== 1 ? "s" : ""} across {incl.length} people</span>
              <span style={{ fontFamily: "monospace", fontWeight: 700, color: amt > 0 ? C.ink : C.muted }}>
                = {money(amt, event.cur)}
              </span>
            </div>
          </div>
        </div>

        <Bar><CTA onClick={save} disabled={!ok}><Check size={18} /> {editing ? "Save changes" : "Add expense"}</CTA></Bar>
      </>
    );
  }

  // ============ SETTLE (receipt) ============
  function SettleView() {
    const net = useMemo(() => computeNet(event), [event]);
    const txns = useMemo(() => settle(net), [net]);
    const summary = useMemo(() => {
      const lines = txns.map((t) => `${nameOf(event, t.from)} → ${nameOf(event, t.to)}  ${money(t.amt, event.cur)}`);
      return `💸 ${event.name} — settle up\n\n${lines.join("\n") || "All settled up!"}`;
    }, [txns]);

    const copy = async () => {
      try { await navigator.clipboard.writeText(summary); setToast("Copied — paste it in the chat"); }
      catch { setToast("Select the text below to copy"); }
    };

    return (
      <>
        <TopBar title="Settle up" onBack={() => setScreen({ name: "event", eventId: event.id })} />
        <div style={{ padding: "0 16px 16px" }}>
          {/* receipt */}
          <div style={{ position: "relative", background: C.card, borderRadius: "16px 16px 0 0",
            border: `1px solid ${C.line}`, borderBottom: "none", padding: "20px 20px 14px" }}>
            <div style={{ textAlign: "center", borderBottom: `2px dashed ${C.line}`, paddingBottom: 12, marginBottom: 12 }}>
              <div style={{ fontFamily: "monospace", fontSize: 12, letterSpacing: 2, color: C.muted }}>SETTLE UP</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: C.ink, marginTop: 2 }}>{event.name}</div>
            </div>
            {txns.length === 0 ? (
              <div style={{ textAlign: "center", padding: "20px 0", color: C.green, fontWeight: 700 }}>
                <Check size={28} /><div>All settled up.</div>
              </div>
            ) : (
              txns.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0",
                  borderBottom: i < txns.length - 1 ? `1px dotted ${C.line}` : "none" }}>
                  <Avatar name={nameOf(event, t.from)} size={26} />
                  <span style={{ fontWeight: 700, color: C.ink }}>{nameOf(event, t.from)}</span>
                  <ArrowRight size={15} color={C.muted} />
                  <Avatar name={nameOf(event, t.to)} size={26} />
                  <span style={{ fontWeight: 700, color: C.ink }}>{nameOf(event, t.to)}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontFamily: "monospace", fontWeight: 800, color: C.green }}>{money(t.amt, event.cur)}</span>
                </div>
              ))
            )}
          </div>
          {/* torn edge */}
          <svg viewBox="0 0 300 10" preserveAspectRatio="none" style={{ display: "block", width: "100%", height: 10 }}>
            <polygon points={Array.from({ length: 31 }, (_, i) => `${i * 10},0 ${i * 10 + 5},10`).join(" ") + " 300,0 0,0"} fill={C.card} stroke={C.line} strokeWidth="0.5" />
          </svg>

          <div style={{ fontSize: 12, color: C.muted, textAlign: "center", margin: "10px 0 6px" }}>
            Fewest transfers to make everyone even
          </div>

          {/* shareable text */}
          <textarea readOnly value={summary} onFocus={(e) => e.target.select()} style={{
            width: "100%", boxSizing: "border-box", background: "#F7F6F1", border: `1px solid ${C.line}`,
            borderRadius: 12, padding: 12, fontFamily: "monospace", fontSize: 13, color: C.ink,
            resize: "none", height: 96,
          }} />
        </div>
        <Bar><CTA onClick={copy}><Copy size={18} /> Copy summary for the chat</CTA></Bar>
      </>
    );
  }

  // ---------- shell ----------
  return (
    <div style={{ minHeight: "100vh", background: "#DED9CE", display: "flex",
      justifyContent: "center", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 430, background: C.paper, minHeight: "100vh",
        position: "relative", display: "flex", flexDirection: "column",
        boxShadow: "0 0 40px rgba(0,0,0,0.12)" }}>

        {/* acting-as switcher (simulates the Telegram user sending commands) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px",
          background: C.ink, color: "#fff", fontSize: 12 }}>
          <UserRound size={14} />
          <span style={{ opacity: 0.7 }}>Acting as</span>
          {event ? event.participants.map((p) => (
            <button key={p.id} onClick={() => setMe(p.id)} style={{
              padding: "3px 8px", borderRadius: 12, border: "none", cursor: "pointer",
              fontSize: 12, fontWeight: 700,
              background: me === p.id ? C.green : "rgba(255,255,255,0.12)", color: "#fff",
            }}>{p.name}</button>
          )) : <span style={{ opacity: 0.5 }}>— open an event —</span>}
          <div style={{ flex: 1 }} />
          <button onClick={() => { setEvents(seed()); setScreen({ name: "home" }); setMe("u_aya"); }}
            title="Reset demo" style={{ background: "none", border: "none", cursor: "pointer" }}>
            <RefreshCw size={13} color="rgba(255,255,255,0.7)" />
          </button>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          {screen.name === "home" && <Home />}
          {screen.name === "event" && event && <EventView />}
          {screen.name === "expense" && event && <ExpenseEditor />}
          {screen.name === "settle" && event && <SettleView />}
        </div>

        {toast && (
          <div style={{ position: "fixed", bottom: 84, left: "50%", transform: "translateX(-50%)",
            background: C.ink, color: "#fff", padding: "10px 16px", borderRadius: 12,
            fontSize: 13, fontWeight: 600, zIndex: 50 }}>{toast}</div>
        )}
      </div>
    </div>
  );

  function TopBar({ title, onBack }) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "14px 12px 12px" }}>
        <button onClick={onBack} style={iconBtn}><ChevronLeft size={22} color={C.ink} /></button>
        <span style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{title}</span>
      </div>
    );
  }
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase",
        letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10,
  border: `1.5px solid ${C.line}`, background: "#FBFAF7", fontSize: 15, color: C.ink, outline: "none",
};
const iconBtn = {
  width: 34, height: 34, borderRadius: 10, border: "none", background: "transparent",
  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
};
const stepBtn = {
  width: 24, height: 24, borderRadius: 8, border: "none", background: "#fff",
  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
};
const ghostBtn = {
  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  padding: "8px 12px", borderRadius: 12, border: `1.5px solid ${C.line}`,
  background: C.card, color: C.ink, fontWeight: 700, fontSize: 14, cursor: "pointer",
};
