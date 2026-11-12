"use client";

// Expenses — money paid out. Per-store build, step 3: every expense belongs to one store (or to the
// whole business). A store login adds and sees its own store's expenses. A wrong expense is
// cancelled by the owner with a reason; it stays on the list, crossed out, and counts in no report.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { askText } from "../../lib/ask";
import { cleanTyping, peso, pesosToMinor } from "../../lib/number-format";

interface ExpenseRow {
  id: string; category: string; amountMinor: number; note: string | null; spentAt: string;
  locationId: string | null; locationName: string | null; paidFromDrawer: boolean; addedBy: string | null;
  cancelled: boolean; cancelReason: string | null; cancelledBy: string | null;
}
interface Place { id: string; name: string; code?: string | null; type?: string; isActive?: boolean }

const CATEGORIES: { id: string; label: string; icon: string }[] = [
  { id: "supplies", label: "Supplies", icon: "bi-bag" },
  { id: "transport", label: "Transport", icon: "bi-truck" },
  { id: "wages", label: "Wages", icon: "bi-people" },
  { id: "utilities", label: "Light and water", icon: "bi-lightbulb" },
  { id: "rent", label: "Rent", icon: "bi-house" },
  { id: "other", label: "Other", icon: "bi-three-dots" },
];
const labelOf = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id;
const BUSINESS = "business";
type When = "today" | "month" | "all";

export default function ExpensesPanel() {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [totalMinor, setTotalMinor] = useState(0);
  const [canCancel, setCanCancel] = useState(false);
  const [own, setOwn] = useState<string | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The list
  const [show, setShow] = useState(""); // "" = all stores, a store id, or BUSINESS
  const [when, setWhen] = useState<When>("month");
  // The new expense
  const [paidBy, setPaidBy] = useState(""); // a store id, or BUSINESS
  const [category, setCategory] = useState("supplies");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    (async () => {
      const [me, locs] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      const active = ((locs?.warehouses ?? []) as Place[]).filter((l) => l.isActive !== false && l.type !== "BUFFER");
      setPlaces(active);
      const home = (me?.homeLocationId as string | null) ?? null;
      setPaidBy(home ?? active[0]?.id ?? BUSINESS);
      setReady(true);
    })().catch(() => { setError("Could not load the stores. Check the connection and open this screen again."); setReady(true); });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (show) q.set("locationId", show);
      const now = new Date();
      if (when === "today") q.set("from", new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString());
      if (when === "month") q.set("from", new Date(now.getFullYear(), now.getMonth(), 1).toISOString());
      const res = await fetch(`${API_URL}/admin/expenses?${q}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const list = (data.expenses ?? []) as ExpenseRow[];
      setRows(list);
      setTotalMinor(typeof data.totalMinor === "number" ? data.totalMinor : list.filter((e) => !e.cancelled).reduce((s, e) => s + e.amountMinor, 0));
      setCanCancel(!!data.canCancel);
      setOwn(data.ownLocationId ?? null);
      setError(null);
    } catch {
      setError("Could not load the expenses. Check the connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [show, when]);

  useEffect(() => { load(); }, [load]);

  const ownName = useMemo(() => places.find((p) => p.id === own)?.name ?? "your store", [places, own]);
  const paidByName = paidBy === BUSINESS ? "the whole business" : places.find((p) => p.id === paidBy)?.name ?? "the store";

  const save = async () => {
    setFormError(null);
    const amountMinor = pesosToMinor(amount);
    if (!amountMinor || amountMinor <= 0) { setFormError("Type the amount that was paid."); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/admin/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ category, amountMinor, note: note.trim() || undefined, locationId: own ?? (paidBy === BUSINESS ? null : paidBy), paidFromDrawer: paidBy !== BUSINESS && drawer }),
      });
      if (res.ok) {
        setAmount(""); setNote(""); setDrawer(false);
        toast(`Expense saved for ${own ? ownName : paidByName}`);
        await load();
      } else {
        const d = await res.json().catch(() => null);
        setFormError(d?.errors?.[0] ?? d?.message ?? "The expense was not saved. Try again.");
      }
    } catch {
      setFormError("No connection. The expense was not saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (r: ExpenseRow) => {
    const reason = await askText(`Cancel this expense of ${peso(r.amountMinor)}? Write why.`, { ok: "Cancel the expense", cancel: "Keep it", danger: true, placeholder: "Example: wrong amount" });
    if (!reason) return;
    const res = await fetch(`${API_URL}/admin/expenses/${r.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ reason }) });
    if (res.ok) { toast("Expense cancelled"); await load(); }
    else { const d = await res.json().catch(() => null); toast(d?.errors?.[0] ?? d?.message ?? "The expense was not cancelled"); }
  };

  const chip = (on: boolean) => `btn ${on ? "btn-dark" : "btn-outline-dark"}`;
  const showChoices = [{ id: "", name: "All" }, ...places.map((p) => ({ id: p.id, name: p.name })), { id: BUSINESS, name: "Whole business" }];
  const whenChoices: { id: When; name: string }[] = [{ id: "today", name: "Today" }, { id: "month", name: "This month" }, { id: "all", name: "All" }];

  return (
    <div className="expenses-screen">
      <h1 className="h4 mb-1"><i className="bi bi-receipt-cutoff me-2" aria-hidden="true"></i>Expenses</h1>
      <p className="text-muted mb-3">Money paid out: fare, supplies, wages, light and water, rent.</p>

      <form className="card mb-3" onSubmit={(e) => { e.preventDefault(); if (!saving) save(); }} aria-labelledby="exp-new">
        <div className="card-body">
          <h2 className="h5 mb-3" id="exp-new">Add an expense</h2>

          <div className="mb-3">
            <div className="fw-semibold mb-1" id="exp-store-label">Which store paid?</div>
            {own ? (
              <div><span className="badge text-bg-dark fs-6">{ownName}</span> <span className="small text-muted ms-1">your store, set by the owner</span></div>
            ) : (
              <div className="d-flex flex-wrap gap-2" role="group" aria-labelledby="exp-store-label">
                {places.map((p) => (
                  <button key={p.id} type="button" className={chip(paidBy === p.id)} aria-pressed={paidBy === p.id} onClick={() => setPaidBy(p.id)}>{p.name}</button>
                ))}
                {ready && <button type="button" className={chip(paidBy === BUSINESS)} aria-pressed={paidBy === BUSINESS} onClick={() => { setPaidBy(BUSINESS); setDrawer(false); }}>Whole business</button>}
              </div>
            )}
          </div>

          <div className="mb-3">
            <div className="fw-semibold mb-1" id="exp-cat-label">What was it for?</div>
            <div className="d-flex flex-wrap gap-2" role="group" aria-labelledby="exp-cat-label">
              {CATEGORIES.map((c) => (
                <button key={c.id} type="button" className={chip(category === c.id)} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                  <i className={`bi ${c.icon} me-1`} aria-hidden="true"></i>{c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="row g-3 mb-3">
            <div className="col-12 col-sm-5 col-lg-4">
              <label className="form-label fw-semibold" htmlFor="exp-amount">Amount paid</label>
              <div className="input-group input-group-lg">
                <span className="input-group-text">₱</span>
                <input id="exp-amount" className="form-control" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount}
                  onChange={(e) => setAmount(cleanTyping(e.target.value, "peso"))} aria-describedby={formError ? "exp-error" : undefined} aria-invalid={!!formError} />
              </div>
            </div>
            <div className="col-12 col-sm-7 col-lg-8">
              <label className="form-label fw-semibold" htmlFor="exp-note">Note <span className="fw-normal text-muted">(not needed)</span></label>
              <input id="exp-note" className="form-control form-control-lg" maxLength={200} autoComplete="off" placeholder="Example: fare to Bodega" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>

          {(own || paidBy !== BUSINESS) && (
            <label className="exp-check mb-3" htmlFor="exp-drawer">
              <input className="form-check-input" type="checkbox" id="exp-drawer" checked={drawer} onChange={(e) => setDrawer(e.target.checked)} />
              <span>Paid with cash from the store drawer</span>
            </label>
          )}

          {formError && <div className="alert alert-danger py-2" id="exp-error" role="alert">{formError}</div>}
          <button type="submit" className="btn btn-success btn-lg" disabled={saving || !ready}>
            <i className="bi bi-check-lg me-1" aria-hidden="true"></i>{saving ? "Saving…" : "Save expense"}
          </button>
        </div>
      </form>

      <h2 className="h5 mb-2">Expenses written down</h2>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <span className="fw-semibold me-1" id="exp-when-label">Dates</span>
        <span className="d-flex flex-wrap gap-2" role="group" aria-labelledby="exp-when-label">
          {whenChoices.map((w) => <button key={w.id} type="button" className={chip(when === w.id)} aria-pressed={when === w.id} onClick={() => setWhen(w.id)}>{w.name}</button>)}
        </span>
      </div>
      {!own && (
        <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
          <span className="fw-semibold me-1" id="exp-show-label">Store</span>
          <span className="d-flex flex-wrap gap-2" role="group" aria-labelledby="exp-show-label">
            {showChoices.map((s) => <button key={s.id || "all"} type="button" className={chip(show === s.id)} aria-pressed={show === s.id} onClick={() => setShow(s.id)}>{s.name}</button>)}
          </span>
        </div>
      )}
      {error && <div className="alert alert-danger py-2" role="alert">{error} <button type="button" className="btn btn-outline-dark ms-2" onClick={load}>Try again</button></div>}

      <div className="d-flex justify-content-between align-items-baseline border rounded px-3 py-2 mb-2 bg-body" aria-live="polite">
        <span className="fw-semibold">Total{own ? ` for ${ownName}` : ""}</span>
        <span className="fs-4 fw-bold">{peso(totalMinor)}</span>
      </div>

      {loading && rows.length === 0 ? (
        <p className="text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted">No expenses for these dates.</p>
      ) : (
        <ul className="list-group">
          {rows.map((r) => (
            <li key={r.id} className="list-group-item">
              <div className="d-flex flex-wrap align-items-center gap-2">
                <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
                  <div className={r.cancelled ? "text-decoration-line-through text-muted" : ""}>
                    <span className="fw-semibold">{labelOf(r.category)}</span>
                    {r.note && <span> · {r.note}</span>}
                  </div>
                  <div className="small text-muted">
                    {new Date(r.spentAt).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {" · "}<span className="fw-semibold text-body">{r.locationName ?? "Whole business"}</span>
                    {r.paidFromDrawer && <> · from the drawer</>}
                    {r.addedBy && <> · by {r.addedBy}</>}
                  </div>
                  {r.cancelled && <div className="small"><span className="badge text-bg-danger me-1">Cancelled</span>{r.cancelReason}{r.cancelledBy ? ` (${r.cancelledBy})` : ""}</div>}
                </div>
                <div className={`fs-5 fw-bold text-end ${r.cancelled ? "text-decoration-line-through text-muted" : ""}`}>{peso(r.amountMinor)}</div>
                {canCancel && !r.cancelled && (
                  <button type="button" className="btn btn-outline-danger" onClick={() => cancel(r)} aria-label={`Cancel the expense of ${peso(r.amountMinor)}, ${labelOf(r.category)}`}>
                    <i className="bi bi-x-lg me-1" aria-hidden="true"></i>Cancel
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length >= 200 && <p className="small text-muted mt-2">Showing the newest 200. Choose a shorter date range to see the rest.</p>}
    </div>
  );
}
