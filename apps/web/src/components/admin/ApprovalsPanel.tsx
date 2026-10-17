"use client";

// Rice Ops M2 — "For your approval": everything waiting for the owner's (or manager's) yes/no.
// Losses over 1%, over-limit utang, manual items, big write-offs and voids land here as
// later modules are built. Each decision asks for the decider's own PIN.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";

interface Approval {
  id: string;
  kind: string;
  documentType: string;
  documentId: string;
  summary: string;
  status: string;
  location: { code: string | null; name: string } | null;
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
};
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

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex align-items-center justify-content-between mb-3">
        <h1 className="h4 mb-0">For your approval</h1>
        <div className="btn-group" role="group" aria-label="Show">
          <button className={`btn btn-sm ${view === "PENDING" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setView("PENDING")}>Waiting</button>
          <button className={`btn btn-sm ${view === "ALL" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setView("ALL")}>All</button>
        </div>
      </div>
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

      {loading ? <p className="text-muted">Loading…</p> : rows.length === 0 ? (
        <div className="text-center text-muted py-5">
          <i className="bi bi-check2-circle fs-1 d-block mb-2" aria-hidden="true"></i>
          {view === "PENDING" ? "Nothing waiting. All good." : "No approvals yet."}
        </div>
      ) : (
        <div className="list-group">
          {rows.map((a) => {
            const [badge, word] = STATUS[a.status] ?? ["text-bg-secondary", a.status];
            return (
              <div key={a.id} className="list-group-item py-3">
                <div className="d-flex justify-content-between align-items-start gap-2">
                  <div>
                    <div className="small text-muted">{KIND_LABEL[a.kind] ?? a.kind}{a.location ? ` · ${a.location.code ?? a.location.name}` : ""} · {new Date(a.createdAt).toLocaleString("en-PH")}</div>
                    <div className="fw-semibold">{a.summary}</div>
                    {a.decisionNote && <div className="small mt-1">Note: {a.decisionNote}</div>}
                  </div>
                  <span className={`badge ${badge}`}>{word}</span>
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

/** "No PIN yet?" — set or change your own PIN (current PIN, or your password if you have no PIN yet). */
function MyPin() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [newPin, setNewPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!open) {
    return <button type="button" className="btn btn-link px-0 mb-3" onClick={() => setOpen(true)}>No PIN yet, or forgot it? Make / change my PIN</button>;
  }
  const save = async () => {
    setBusy(true); setMsg(null);
    const res = await fetch(`${API_URL}/admin/me/pin`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ current, newPin }) });
    const d = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: d?.errors?.join(", ") ?? d?.message ?? "Not saved" }); return; }
    setMsg({ ok: true, text: "New PIN saved. Use it above." });
    setCurrent(""); setNewPin("");
  };
  return (
    <div className="border rounded p-3 mb-3 bg-light">
      <div className="fw-semibold mb-2">My PIN</div>
      {msg && <div className={`alert ${msg.ok ? "alert-success" : "alert-danger"} py-2`}>{msg.text}</div>}
      <label className="form-label" htmlFor="my-cur">Current PIN — or your password if you have no PIN yet</label>
      <input id="my-cur" className="form-control form-control-lg mb-2" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <label className="form-label" htmlFor="my-new">New PIN (4 digits)</label>
      <input id="my-new" className="form-control form-control-lg text-center mb-2" style={{ maxWidth: 200, letterSpacing: "0.5em" }} type="password" inputMode="numeric" autoComplete="new-password" maxLength={4}
        value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
      <div className="d-flex gap-2">
        <button type="button" className="btn btn-outline-secondary" onClick={() => setOpen(false)}>Close</button>
        <button type="button" className="btn btn-success" disabled={busy || !current || newPin.length !== 4} onClick={() => void save()}>{busy ? "Please wait…" : "Save PIN"}</button>
      </div>
    </div>
  );
}
