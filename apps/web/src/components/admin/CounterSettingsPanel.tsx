"use client";

// Counter settings — the few switches counter staff may change themselves.
// Everything else about the store stays under Settings (owner / manager).

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import PrinterSettingsCard from "./PrinterSettingsCard";
import MyPin from "./MyPin";

export default function CounterSettingsPanel() {
  const [requireOpenShift, setRequireOpenShift] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/admin/counter-settings`, { headers: adminHeaders() });
      const d = await res.json();
      setRequireOpenShift(d?.requireOpenShift === true);
    } catch {
      toast("Could not load the counter settings", "danger");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/admin/counter-settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ requireOpenShift: next }),
      });
      if (!res.ok) { toast("Could not save — try again", "danger"); return; }
      setRequireOpenShift(next);
      toast(next ? "Staff must open a shift before taking cash" : "Staff can sell without opening a shift", "success");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 className="h4 mb-3"><i className="bi bi-sliders me-2"></i>Counter settings</h1>
      <PrinterSettingsCard />
      <div className="mt-3"><MyPin /></div>
      {requireOpenShift === null ? (
        <div className="text-muted">Loading…</div>
      ) : (
        <div className="card">
          <div className="card-body">
            <div className="form-check form-switch">
              <input className="form-check-input" type="checkbox" id="csShift" checked={requireOpenShift} disabled={busy} onChange={(e) => void save(e.target.checked)} />
              <label className="form-check-label fw-semibold" htmlFor="csShift">Open a shift before taking cash</label>
            </div>
            <p className="text-muted small mb-0 mt-2">
              On: the drawer must be opened before any cash sale, and cash payments are counted against that shift.
              Off: staff can sell any time — you can still open a shift when you want to count the drawer.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
