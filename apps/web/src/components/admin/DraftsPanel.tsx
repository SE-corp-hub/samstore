"use client";

// Rice Ops M2 — "Tapusin": flows left half-done. Every flow saves itself on the server
// at each step, so another phone can pick it up here. Drafts older than 2 hours are
// flagged. The flows themselves (Ilabas, Tanggapin, Resack, Bilangin…) arrive in later
// modules and open from here; until then a draft can be viewed or cancelled.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";

interface Draft {
  id: string;
  flow: string;
  location: { code: string | null; name: string } | null;
  docNumber: string | null;
  step: number;
  updatedAt: string;
  stale: boolean;
}

const FLOW_LABEL: Record<string, string> = {
  SALE: "Benta", RELEASE: "Ilabas", RECEIVE: "Tanggapin", TRANSFER: "Lipat", RESACK: "Resack", COUNT: "Bilangin",
  WRITE_OFF: "Manual na bawas", STOCK_IN: "Manual na pasok", RETURN: "Ibinalik", PAPER_SLIP: "Galing sa papel", CLOSE: "Pagsasara",
};

export default function DraftsPanel() {
  const [rows, setRows] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/drafts`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Hindi ma-load");
      setRows((await res.json()).drafts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const cancel = async (d: Draft) => {
    if (!confirm(`Kanselahin ang ${FLOW_LABEL[d.flow] ?? d.flow}? Walang stock na gagalaw.`)) return;
    const res = await fetch(`${API_URL}/admin/drafts/${d.id}/close`, {
      method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ status: "CANCELLED" }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setError(body?.errors?.join(", ") ?? body?.message ?? "Hindi natuloy"); return; }
    toast("Kinansela");
    await load();
  };

  return (
    <div style={{ fontSize: 18 }}>
      <h1 className="h4 mb-3">Tapusin</h1>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {loading ? <p className="text-muted">Loading…</p> : rows.length === 0 ? (
        <div className="text-center text-muted py-5">
          <i className="bi bi-check2-all fs-1 d-block mb-2" aria-hidden="true"></i>
          Walang naiwang gawain.
        </div>
      ) : (
        <div className="list-group">
          {rows.map((d) => (
            <div key={d.id} className="list-group-item py-3 d-flex justify-content-between align-items-center gap-2">
              <div>
                <div className="fw-semibold">{FLOW_LABEL[d.flow] ?? d.flow}{d.docNumber ? ` ${d.docNumber}` : ""}</div>
                <div className="small text-muted">
                  {d.location ? `${d.location.code ?? d.location.name} · ` : ""}Hakbang {d.step} · huling galaw {new Date(d.updatedAt).toLocaleString("en-PH")}
                </div>
                {d.stale && <span className="badge text-bg-warning mt-1">Lampas 2 oras na</span>}
              </div>
              <button className="btn btn-outline-secondary" onClick={() => void cancel(d)}>Kanselahin</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
