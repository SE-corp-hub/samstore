"use client";

// P7b: agent inbox — conversations awaiting an agent (bot fallback), with thread,
// reply, canned replies, takeover + resolve. Self-contained modal.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface ConvItem {
  id: string;
  title: string | null;
  status: string;
  mode: string;
  unreadCount: number;
  lastActivityAt: string;
  messages: { body: string; sender: string }[];
}

interface MsgItem {
  sender: string;
  senderId: string | null;
  body: string;
  intent: string | null;
  createdAt: string;
}

interface CannedItem { id: string; label: string; body: string }

interface ChatPanelProps {
  onClose: () => void;
  onChanged: () => void;
}

export default function ChatPanel({ onClose, onChanged }: ChatPanelProps) {
  const [convs, setConvs] = useState<ConvItem[] | null>(null);
  const [open, setOpen] = useState<{ id: string; thread: MsgItem[]; canned: CannedItem[] } | null>(null);
  const [reply, setReply] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("AGENT");

  const load = async () => {
    setErr(null);
    try {
      const r = await fetch(`${API_URL}/admin/chatbot/conversations?status=${status}`, { headers: adminHeaders() });
      const d = await r.json();
      setConvs(d?.conversations ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    void load();
    return () => window.removeEventListener("keydown", onKey);
  }, [status, onClose]);

  const openConv = async (id: string) => {
    setErr(null);
    try {
      const [t, c] = await Promise.all([
        fetch(`${API_URL}/admin/chatbot/conversations/${id}/messages`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/chatbot/canned-replies`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setOpen({ id, thread: t?.messages ?? [], canned: c?.replies ?? [] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    }
  };

  const action = async (path: string, method: string, body?: unknown) => {
    setErr(null);
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: { ...adminHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setErr(d?.errors?.join(", ") ?? d?.message ?? "Failed"); return false; }
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
      return false;
    }
  };

  const sendReply = async () => {
    if (!open || !reply.trim()) return;
    if (await action(`/admin/chatbot/conversations/${open.id}/reply`, "POST", { text: reply.trim() })) {
      setReply("");
      onChanged();
      void openConv(open.id);
      void load();
    }
  };

  const takeover = async () => {
    if (!open) return;
    if (await action(`/admin/chatbot/conversations/${open.id}/takeover`, "POST")) { onChanged(); void load(); }
  };

  const resolve = async () => {
    if (!open) return;
    if (await action(`/admin/chatbot/conversations/${open.id}/resolve`, "POST")) { setOpen(null); onChanged(); void load(); }
  };

  return (
    <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
      <div className="modal-dialog modal-dialog-scrollable modal-xl">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Chat inbox</h5>
            <button type="button" className="btn-close" onClick={onClose} aria-label="Close"></button>
          </div>
          <div className="modal-body">
            {err && <div className="alert alert-danger py-2 small">{err}</div>}
            <div className="d-flex gap-2 align-items-center mb-2">
              <select className="form-select form-select-sm" style={{ width: 140 }} value={status} onChange={(e) => { setStatus(e.target.value); setOpen(null); }}>
                <option value="AGENT">Awaiting agent</option>
                <option value="OPEN">Open</option>
                <option value="RESOLVED">Resolved</option>
                <option value="">All</option>
              </select>
              <span className="text-muted small">{convs?.length ?? 0} conversation(s)</span>
            </div>
            <div className="row g-2">
              <div className="col-md-4" style={{ maxHeight: 420, overflowY: "auto" }}>
                {convs === null ? (
                  <p className="text-muted small">Loading…</p>
                ) : convs.length === 0 ? (
                  <p className="text-muted small text-center py-3">Nothing here.</p>
                ) : (
                  <div className="list-group list-group-flush">
                    {convs.map((c) => (
                      <button key={c.id} type="button" className={`list-group-item list-group-item-action small ${open?.id === c.id ? "active" : ""}`} onClick={() => void openConv(c.id)}>
                        <div className="d-flex justify-content-between">
                          <span className="fw-semibold text-truncate">{c.title ?? "Customer"}</span>
                          {c.unreadCount > 0 && <span className="badge rounded-pill text-bg-danger">{c.unreadCount}</span>}
                        </div>
                        <div className="text-muted text-truncate">{c.messages[0]?.body ?? ""}</div>
                        <div className="text-muted text-opacity-75">{c.status} · {c.mode}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="col-md-8">
                {open === null ? (
                  <p className="text-muted text-center py-5">Select a conversation to read and reply.</p>
                ) : (
                  <>
                    <div style={{ maxHeight: 320, overflowY: "auto" }}>
                      {open.thread.map((m, i) => (
                        <div key={i} className={`mb-1 small ${m.sender === "customer" ? "text-muted" : "bg-light border rounded p-1"}`}>
                          <span className="badge text-bg-light border me-1">{m.sender}</span>
                          {m.body}
                          {m.intent && <div className="text-muted text-opacity-75">intent: {m.intent} · conf {m.intent ? "✓" : ""}</div>}
                        </div>
                      ))}
                    </div>
                    <div className="d-flex gap-1 mt-2">
                      <select className="form-select form-select-sm" defaultValue="" onChange={(e) => { const c = open.canned.find((x) => x.id === e.target.value); if (c) setReply(c.body); }}>
                        <option value="">Canned reply…</option>
                        {open.canned.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                      <button className="btn btn-sm btn-outline-primary" onClick={() => void takeover()}>Take over</button>
                      <button className="btn btn-sm btn-outline-success" onClick={() => void resolve()}>Resolve</button>
                    </div>
                    <div className="d-flex gap-1 mt-1">
                      <input className="form-control form-control-sm" placeholder="Reply as agent…" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void sendReply(); }} />
                      <button className="btn btn-primary btn-sm" disabled={!reply.trim()} onClick={() => void sendReply()}>Send</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-outline-secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}