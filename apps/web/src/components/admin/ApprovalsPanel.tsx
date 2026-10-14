"use client";

// Rice Ops M2 — "Para sa iyo": everything waiting for the owner's (or manager's) yes/no.
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
  LOSS_OVER_TOLERANCE: "Kulang na lampas 1%",
  UTANG_OVER_LIMIT: "Utang lampas sa limit",
  MANUAL_ITEM: "Bagong item",
  WRITE_OFF: "Manual na bawas",
  VOID: "Void",
  TRANSFER: "Lipat",
  STOCK_OVERRIDE: "Lampas sa stock",
};
const STATUS: Record<string, [string, string]> = {
  PENDING: ["text-bg-warning", "Naghihintay"],
  APPROVED: ["text-bg-success", "Inaprubahan"],
  DECLINED: ["text-bg-danger", "Tinanggihan"],
  CANCELLED: ["text-bg-secondary", "Kinansela"],
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
      if (!res.ok) throw new Error("Hindi ma-load");
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
    if (!res.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Hindi natuloy"); return; }
    toast(deciding.decision === "APPROVE" ? "Inaprubahan" : "Tinanggihan");
    setDeciding(null);
    setNote("");
    await load();
  };

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex align-items-center justify-content-between mb-3">
        <h1 className="h4 mb-0">Para sa iyo</h1>
        <div className="btn-group" role="group" aria-label="Ipakita">
          <button className={`btn btn-sm ${view === "PENDING" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setView("PENDING")}>Naghihintay</button>
          <button className={`btn btn-sm ${view === "ALL" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setView("ALL")}>Lahat</button>
        </div>
      </div>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {deciding && (
        <form onSubmit={submit} className="card border-success mb-3">
          <div className="card-body">
            <p className="fw-semibold">{deciding.decision === "APPROVE" ? "Aaprubahan" : "Tatanggihan"}: {deciding.a.summary}</p>
            {deciding.decision === "DECLINE" && (
              <div className="mb-3">
                <label className="form-label" htmlFor="ap-note">Dahilan</label>
                <input id="ap-note" className="form-control form-control-lg" required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            )}
            <label className="form-label" htmlFor="ap-pin">Ang PIN mo</label>
            <input
              id="ap-pin" className="form-control form-control-lg text-center mb-3" style={{ maxWidth: 200, letterSpacing: "0.5em" }}
              type="password" inputMode="numeric" autoComplete="off" maxLength={4} required
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            />
            <div className="d-flex justify-content-between">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => { setDeciding(null); setPin(""); setNote(""); }}>Bumalik</button>
              <button type="submit" className="btn btn-success btn-lg" disabled={busy || pin.length !== 4}>{busy ? "Sandali…" : deciding.decision === "APPROVE" ? "Aprubahan" : "Tanggihan"}</button>
            </div>
          </div>
        </form>
      )}

      {loading ? <p className="text-muted">Loading…</p> : rows.length === 0 ? (
        <div className="text-center text-muted py-5">
          <i className="bi bi-check2-circle fs-1 d-block mb-2" aria-hidden="true"></i>
          {view === "PENDING" ? "Walang naghihintay. Ayos lahat." : "Wala pang approval."}
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
                    {a.decisionNote && <div className="small mt-1">Tala: {a.decisionNote}</div>}
                  </div>
                  <span className={`badge ${badge}`}>{word}</span>
                </div>
                {a.status === "PENDING" && (
                  a.canDecide ? (
                    <div className="d-flex gap-2 mt-2">
                      <button className="btn btn-outline-danger" onClick={() => { setDeciding({ a, decision: "DECLINE" }); setPin(""); }}>Tanggihan</button>
                      <button className="btn btn-success" onClick={() => { setDeciding({ a, decision: "APPROVE" }); setPin(""); }}>Aprubahan</button>
                    </div>
                  ) : <div className="small text-muted mt-2">Ang may-ari ang magpapasya dito.</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
