"use client";

// Rice Ops M2 — "For your approval": everything waiting for the owner's (or manager's) yes/no.
// Losses over 1%, over-limit utang, manual items, big write-offs and voids land here as
// later modules are built. Each decision asks for the decider's own PIN.

import MyPin from "./MyPin";
import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { savedThenFresh } from "../../lib/offlineCache";

interface Approval {
  id: string;
  kind: string;
  documentType: string;
  documentId: string;
  summary: string;
  status: string;
  location: { id: string; code: string | null; name: string } | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  canDecide?: boolean;
}

const KIND_LABEL: Record<string, string> = {
  LOSS_OVER_TOLERANCE: "Short by more than 1%",
  UTANG_OVER_LIMIT: "Credit over the limit",
  MANUAL_ITEM: "New item",
  WRITE_OFF: "Write-off",
  VOID: "Void",
  TRANSFER: "Transfer",
  STOCK_OVERRIDE: "More than the stock",
  TRANSIT_SHORT: "Short on the way",
  REFUND: "Customer return",
  COUNT: "Count",
  EXPENSE: "Expense from the drawer",
};
// The same store colours as Orders (stores first, then the bodega), and the name is always written.
const STORE_TONES = ["store-tone-1", "store-tone-2", "store-tone-3", "store-tone-4", "store-tone-5"];
interface Place { id: string; name: string; type?: string; isActive?: boolean }
const NO_STORE = "none";

const STATUS: Record<string, [string, string]> = {
  PENDING: ["text-bg-warning", "Waiting"],
  APPROVED: ["text-bg-success", "Approved"],
  DECLINED: ["text-bg-danger", "Declined"],
  CANCELLED: ["text-bg-secondary", "Cancelled"],
};

export default function ApprovalsPanel() {
  const [view, setView] = useState<"PENDING" | "ALL">("PENDING");
  const [rows, setRows] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ a: Approval; decision: "APPROVE" | "DECLINE" } | null>(null);
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [places, setPlaces] = useState<Place[]>([]);
  const [storeFilter, setStoreFilter] = useState("");

  useEffect(() => {
    void savedThenFresh<{ warehouses?: Place[] }>("/admin/warehouses", (d) => {
      const live = (d.warehouses ?? []).filter((w) => w.isActive !== false && w.type !== "BUFFER");
      const isStore = (w: Place) => w.type !== "WAREHOUSE";
      setPlaces([...live.filter(isStore), ...live.filter((w) => !isStore(w))]);
    }, { headers: adminHeaders() });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/approvals?status=${view}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Could not load");
      setRows((await res.json()).approvals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => { void load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deciding) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`${API_URL}/admin/approvals/${deciding.a.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ decision: deciding.decision, pin, note: note || undefined }),
    });
    const d = await res.json().catch(() => null);
    setBusy(false);
    setPin("");
    if (!res.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Did not go through"); return; }
    toast(deciding.decision === "APPROVE" ? "Approved" : "Declined");
    setDeciding(null);
    setNote("");
    await load();
  };

  // Every store that has a request in this list, in the usual store order; a place not in the list (closed) goes last.
  const placeIds = places.map((p) => p.id);
  const extra = rows.map((r) => r.location).filter((l): l is NonNullable<Approval["location"]> => !!l && !placeIds.includes(l.id));
  const shown: { id: string; name: string }[] = [...places, ...extra.filter((l, i) => extra.findIndex((x) => x.id === l.id) === i)];
  const toneOf = (id: string) => { const i = shown.findIndex((p) => p.id === id); return STORE_TONES[(i < 0 ? 0 : i) % STORE_TONES.length] ?? "store-tone-1"; };
  const keyOf = (a: Approval) => a.location?.id ?? NO_STORE;
  const countBy: Record<string, number> = {};
  for (const r of rows) countBy[keyOf(r)] = (countBy[keyOf(r)] ?? 0) + 1;
  const filtered = storeFilter ? rows.filter((r) => keyOf(r) === storeFilter) : rows;

  const storeTag = (a: Approval) => a.location
    ? <span className={`store-tag store-tag-lg ${toneOf(a.location.id)}`}><i className="bi bi-shop" aria-hidden="true"></i>{a.location.name}</span>
    : <span className="store-tag store-tag-lg store-tone-home"><i className="bi bi-buildings" aria-hidden="true"></i>Whole business</span>;

  const chip = (id: string, label: string, n: number, tone: string) => (
    <button key={id || "all"} type="button" className={`btn store-chip ${tone} ${storeFilter === id ? "is-on" : ""}`} aria-pressed={storeFilter === id}
      onClick={() => setStoreFilter(id)}>
      {id && id !== NO_STORE && <i className="bi bi-shop me-1" aria-hidden="true"></i>}{label}
      <span className="badge rounded-pill ms-2" aria-label={`${n} ${view === "PENDING" ? "waiting" : "in the list"}`}>{n > 99 ? "99+" : n}</span>
    </button>
  );

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">For your approval</h1>
        <div className="btn-group" role="group" aria-label="Show">
          <button className={`btn btn-sm text-nowrap ${view === "PENDING" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setView("PENDING")}>Waiting</button>
          <button className={`btn btn-sm text-nowrap ${view === "ALL" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setView("ALL")}>All</button>
        </div>
      </div>
      {shown.length > 0 && rows.length > 0 && (
        <div className="d-flex flex-wrap gap-2 mb-3" role="group" aria-label="Which store">
          {chip("", "All stores", rows.length, "store-chip-all")}
          {shown.filter((p) => (countBy[p.id] ?? 0) > 0 || storeFilter === p.id).map((p) => chip(p.id, p.name, countBy[p.id] ?? 0, toneOf(p.id)))}
          {((countBy[NO_STORE] ?? 0) > 0 || storeFilter === NO_STORE) && chip(NO_STORE, "Whole business", countBy[NO_STORE] ?? 0, "store-tone-home")}
        </div>
      )}
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {deciding && (
        <form onSubmit={submit} className="card border-success mb-3">
          <div className="card-body">
            <p className="fw-semibold">{deciding.decision === "APPROVE" ? "Approve" : "Decline"}: {deciding.a.summary}</p>
            {deciding.decision === "DECLINE" && (
              <div className="mb-3">
                <label className="form-label" htmlFor="ap-note">Reason</label>
                <input id="ap-note" className="form-control form-control-lg" required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            )}
            <label className="form-label" htmlFor="ap-pin">Your PIN</label>
            <input
              id="ap-pin" className="form-control form-control-lg text-center mb-3" style={{ maxWidth: 200, letterSpacing: "0.5em" }}
              type="password" inputMode="numeric" autoComplete="off" maxLength={4} required
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            />
            <MyPin />
            <div className="d-flex justify-content-between">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => { setDeciding(null); setPin(""); setNote(""); }}>Back</button>
              <button type="submit" className="btn btn-success btn-lg" disabled={busy || pin.length !== 4}>{busy ? "Please wait…" : deciding.decision === "APPROVE" ? "Approve" : "Decline"}</button>
            </div>
          </div>
        </form>
      )}

      {loading ? <p className="text-muted">Loading…</p> : filtered.length === 0 ? (
        <div className="text-center text-muted py-5">
          <i className="bi bi-check2-circle fs-1 d-block mb-2" aria-hidden="true"></i>
          {storeFilter && rows.length > 0
            ? <>Nothing here for this store. <button type="button" className="btn btn-link p-0 align-baseline" onClick={() => setStoreFilter("")}>Show all stores</button></>
            : view === "PENDING" ? "Nothing waiting. All good." : "No approvals yet."}
        </div>
      ) : (
        <div className="list-group">
          {filtered.map((a) => {
            const [badge, word] = STATUS[a.status] ?? ["text-bg-secondary", a.status];
            return (
              <div key={a.id} className="list-group-item py-3">
                <div className="d-flex justify-content-between align-items-start gap-2">
                  <div style={{ minWidth: 0 }}>
                    <div className="mb-1">{storeTag(a)}</div>
                    <div className="small text-muted">{KIND_LABEL[a.kind] ?? a.kind} · {new Date(a.createdAt).toLocaleString("en-PH")}</div>
                    <div className="fw-semibold">{a.summary}</div>
                    {a.decisionNote && <div className="small mt-1">Note: {a.decisionNote}</div>}
                  </div>
                  <span className={`badge ${badge} text-nowrap flex-shrink-0`}>{word}</span>
                </div>
                {a.status === "PENDING" && (
                  a.canDecide ? (
                    <div className="d-flex gap-2 mt-2">
                      <button className="btn btn-outline-danger" onClick={() => { setDeciding({ a, decision: "DECLINE" }); setPin(""); }}>Decline</button>
                      <button className="btn btn-success" onClick={() => { setDeciding({ a, decision: "APPROVE" }); setPin(""); }}>Approve</button>
                    </div>
                  ) : <div className="small text-muted mt-2">The owner decides this one.</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
