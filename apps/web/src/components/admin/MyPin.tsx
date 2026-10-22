"use client";

// "My PIN": set or change your own PIN (current PIN, or your password if you have no PIN yet).
// Used on For your approval (owner/manager) and on Counter settings (staff).

import { useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

/** "No PIN yet?" — set or change your own PIN (current PIN, or your password if you have no PIN yet). */
export default function MyPin() {
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
