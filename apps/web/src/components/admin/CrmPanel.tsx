"use client";

// P8: CRM — customer aggregates (LTV/AOV/recency/favorite), CRM tags, a segment
// explorer, and follow-up campaigns (enqueue via outbox, suppressed until connected).

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { peso } from "../../lib/number-format";

interface CrmCustomer {
  storeCustomerId: string;
  name: string | null;
  phone: string | null;
  ltvMinor: number;
  orders: number;
  aovMinor: number;
  lastOrderAt: string | null;
  daysSinceLastOrder: number | null;
  favoriteProduct: string | null;
  tags: string[];
  psid: string | null;
  creditBalanceMinor: number;
}

interface Campaign {
  id: string;
  name: string;
  message: string;
  status: string;
  recipientCount: number;
  sentAt: string | null;
  createdAt: string;
}

const toPesos = (m: number) => peso(m);

export default function CrmPanel() {
  const [customers, setCustomers] = useState<CrmCustomer[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Segment explorer
  const [rule, setRule] = useState({ minLtvMinor: "", maxDaysSinceLastOrder: "", hasCredit: false, messengerOnly: false, tag: "" });
  const [segmentCount, setSegmentCount] = useState<number | null>(null);
  // Campaign composer
  const [campForm, setCampForm] = useState({ name: "", message: "", minLtvMinor: "" });
  const [running, setRunning] = useState<string | null>(null);

  const load = async () => {
    setErr(null);
    try {
      const [c, cam] = await Promise.all([
        fetch(`${API_URL}/admin/crm/customers`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/crm/campaigns`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setCustomers(c?.customers ?? []);
      setCampaigns(cam?.campaigns ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    }
  };

  useEffect(() => { void load(); }, []);

  const setTags = async (id: string, tags: string[]) => {
    setErr(null);
    try {
      await fetch(`${API_URL}/admin/crm/customers/${id}/tags`, {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Tag update failed");
    }
  };

  const runSegment = async () => {
    setErr(null);
    try {
      const r = await fetch(`${API_URL}/admin/crm/segment`, {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          rule: {
            ...(rule.minLtvMinor ? { minLtvMinor: parseInt(rule.minLtvMinor, 10) } : {}),
            ...(rule.maxDaysSinceLastOrder ? { maxDaysSinceLastOrder: parseInt(rule.maxDaysSinceLastOrder, 10) } : {}),
            hasCredit: rule.hasCredit || undefined,
            messengerOnly: rule.messengerOnly || undefined,
            ...(rule.tag ? { tag: rule.tag } : {}),
          },
        }),
      });
      const d = await r.json();
      setSegmentCount(d?.count ?? 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Segment failed");
    }
  };

  const createCampaign = async () => {
    setErr(null);
    if (!campForm.name.trim() || !campForm.message.trim()) { setErr("Campaign needs a name + message"); return; }
    try {
      const r = await fetch(`${API_URL}/admin/crm/campaigns`, {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: campForm.name.trim(),
          message: campForm.message.trim(),
          rule: campForm.minLtvMinor ? { minLtvMinor: parseInt(campForm.minLtvMinor, 10) } : {},
        }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d?.errors?.join(", ") ?? d?.message ?? "Create failed"); return; }
      setCampForm({ name: "", message: "", minLtvMinor: "" });
      toast("Campaign created");
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    }
  };

  const runCampaign = async (id: string) => {
    setRunning(id);
    setErr(null);
    try {
      const r = await fetch(`${API_URL}/admin/crm/campaigns/${id}/run`, { method: "POST", headers: adminHeaders() });
      const d = await r.json();
      if (!r.ok) { setErr(d?.message ?? "Run failed"); return; }
      toast(`Campaign sent to ${d.recipients} customer(s)`);
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(null);
    }
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h1 className="h4 mb-0">CRM</h1>
      </div>
      {err && <div className="alert alert-danger py-2 small">{err}</div>}

      {/* Segment explorer */}
      <div className="card mb-3">
        <div className="card-body">
          <h6 className="card-title small fw-bold">Segment explorer</h6>
          <div className="row g-1 align-items-end">
            <div className="col-auto">
              <label htmlFor="crm-min-ltv" className="form-label small d-block">Min LTV (₱)</label>
              <input id="crm-min-ltv" className="form-control form-control-sm" style={{ width: 110 }} type="number" min="0" value={rule.minLtvMinor} onChange={(e) => setRule({ ...rule, minLtvMinor: e.target.value })} />
            </div>
            <div className="col-auto">
              <label htmlFor="crm-inactive-days" className="form-label small d-block">Inactive ≥ days</label>
              <input id="crm-inactive-days" className="form-control form-control-sm" style={{ width: 110 }} type="number" min="0" value={rule.maxDaysSinceLastOrder} onChange={(e) => setRule({ ...rule, maxDaysSinceLastOrder: e.target.value })} />
            </div>
            <div className="col-auto">
              <label htmlFor="crm-tag" className="form-label small d-block">Tag</label>
              <input id="crm-tag" className="form-control form-control-sm" style={{ width: 110 }} value={rule.tag} onChange={(e) => setRule({ ...rule, tag: e.target.value })} />
            </div>
            <div className="col-auto">
              <div className="form-check form-switch">
                <input className="form-check-input" type="checkbox" id="crmCredit" checked={rule.hasCredit} onChange={(e) => setRule({ ...rule, hasCredit: e.target.checked })} />
                <label className="form-check-label small" htmlFor="crmCredit">Has credit</label>
              </div>
            </div>
            <div className="col-auto">
              <div className="form-check form-switch">
                <input className="form-check-input" type="checkbox" id="crmMsg" checked={rule.messengerOnly} onChange={(e) => setRule({ ...rule, messengerOnly: e.target.checked })} />
                <label className="form-check-label small" htmlFor="crmMsg">Messenger opted-in</label>
              </div>
            </div>
            <div className="col-auto">
              <button className="btn btn-sm btn-primary" onClick={() => void runSegment()}>Count</button>
            </div>
            {segmentCount !== null && <span className="col-auto small text-muted">→ {segmentCount} match</span>}
          </div>
        </div>
      </div>

      {/* Customers */}
      <div className="card mb-3">
        <div className="card-body">
          <h6 className="card-title small fw-bold">Customers ({customers?.length ?? 0})</h6>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr><th>Customer</th><th className="text-end">LTV</th><th className="text-end">Orders</th><th className="text-end">AOV</th><th>Favorite</th><th>Last order</th><th>Tags</th></tr>
              </thead>
              <tbody>
                {(customers ?? []).map((c) => (
                  <tr key={c.storeCustomerId}>
                    <td className="fw-semibold">{c.name ?? "—"}{c.psid && <i className="bi bi-messenger ms-1 text-primary" title="Messenger opted-in"></i>}</td>
                    <td className="text-end">{toPesos(c.ltvMinor)}</td>
                    <td className="text-end">{c.orders}</td>
                    <td className="text-end">{toPesos(c.aovMinor)}</td>
                    <td className="small">{c.favoriteProduct ?? "—"}</td>
                    <td className="small text-muted">{c.daysSinceLastOrder != null ? `${c.daysSinceLastOrder}d ago` : "never"}</td>
                    <td>
                      <input
                        className="form-control form-control-sm" style={{ width: 150 }}
                        defaultValue={(c.tags ?? []).join(", ")}
                        onBlur={(e) => { const t = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); if (t.join(",") !== (c.tags ?? []).join(",")) void setTags(c.storeCustomerId, t); }}
                        placeholder="tags…"
                      />
                    </td>
                  </tr>
                ))}
                {(customers ?? []).length === 0 && <tr><td colSpan={7} className="text-muted small">No customers yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Campaigns */}
      <div className="card">
        <div className="card-body">
          <h6 className="card-title small fw-bold">Follow-up campaigns</h6>
          <div className="row g-1 mb-2">
            <div className="col"><input className="form-control form-control-sm" placeholder="Campaign name" value={campForm.name} onChange={(e) => setCampForm({ ...campForm, name: e.target.value })} /></div>
            <div className="col"><input className="form-control form-control-sm" placeholder="Message (sent via Messenger, suppressed until connected)" value={campForm.message} onChange={(e) => setCampForm({ ...campForm, message: e.target.value })} /></div>
            <div className="col-2"><input className="form-control form-control-sm" type="number" min="0" placeholder="Min LTV ₱" value={campForm.minLtvMinor} onChange={(e) => setCampForm({ ...campForm, minLtvMinor: e.target.value })} /></div>
            <div className="col-auto"><button className="btn btn-sm btn-primary" onClick={() => void createCampaign()}>Create</button></div>
          </div>
          <table className="table table-sm align-middle mb-0">
            <thead>
              <tr><th>Name</th><th>Status</th><th className="text-end">Recipients</th><th>Message</th><th></th></tr>
            </thead>
            <tbody>
              {(campaigns ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="fw-semibold">{c.name}</td>
                  <td><span className={`badge ${c.status === "SENT" ? "text-bg-success" : "text-bg-secondary"}`}>{c.status}</span></td>
                  <td className="text-end">{c.recipientCount}</td>
                  <td className="small text-muted text-truncate" style={{ maxWidth: 320 }}>{c.message}</td>
                  <td className="text-end">
                    {c.status !== "SENT" && (
                      <button className="btn btn-sm btn-outline-primary" disabled={running === c.id} onClick={() => void runCampaign(c.id)}>{running === c.id ? "…" : "Send"}</button>
                    )}
                  </td>
                </tr>
              ))}
              {(campaigns ?? []).length === 0 && <tr><td colSpan={5} className="text-muted small">No campaigns yet.</td></tr>}
            </tbody>
          </table>
          <small className="text-muted d-block mt-1">Campaigns target Messenger opted-in customers only; sends stay suppressed until a live provider is approved.</small>
        </div>
      </div>
    </div>
  );
}