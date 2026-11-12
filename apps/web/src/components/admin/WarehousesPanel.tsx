"use client";

// Rice Ops M1 — Locations (stores + warehouse): add, edit and set up each place. A "warehouse" row in
// the API is a stock location. Moving rice is on Move stock and each store's prices on Store prices
// (2026-11-12: the copies that were here are gone, one screen per job); old unfinished transfers can
// still be cancelled here.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";

type LocationType = "STORE" | "WAREHOUSE" | "BUFFER";
interface Location {
  id: string;
  name: string;
  code: string | null;
  type: LocationType;
  address: string | null;
  isActive: boolean;
  isDefault: boolean;
  needsReview?: boolean;
  consignment?: boolean;
  /** The Facebook Page that sells for this store. */
  facebookPageUrl?: string | null;
  /** Step 9: the store's own receipt name and text, daily target and order-number start. */
  receiptName?: string | null; receiptHeader?: string | null; receiptFooter?: string | null; receiptContact?: string | null;
  dailySalesTargetMinor?: number | null; orderPrefix?: string | null;
  /** The other places it may take rice from, in order. null = no rule set yet (any place). [] = its own shelf only. */
  takesFrom?: string[] | null;
  stockCount: number;
}
interface Transfer {
  id: string;
  docNumber?: string | null;
  kind?: "RESTOCK" | "ORDER_RELEASE";
  shortQty?: number;
  status: string;
  quantity: number;
  reason: string | null;
  createdAt: string;
  fromWarehouse: { name: string; code: string | null };
  toWarehouse: { name: string; code: string | null };
  product: { name: string; sku: string };
}
interface PriceRow {
  productId: string;
  name: string;
  sku: string;
  mainPriceMinor: number;
  locationPriceMinor: number | null;
  effectivePriceMinor: number;
  /** Unit cost here (owner/manager only). */
  costMinor?: number;
  loose?: boolean;
  ownShelfCost?: boolean;
}
type ApiBody = { message?: string; errors?: string[]; prices?: PriceRow[] };

const label = (l: { name: string; code: string | null }) => (l.code ? `${l.code} · ${l.name}` : l.name);
const emptyForm = { name: "", code: "", type: "STORE" as LocationType, address: "", consignment: false, facebookPageUrl: "", ruleOn: false, takesFrom: [] as string[], receiptName: "", receiptHeader: "", receiptFooter: "", receiptContact: "", dailyTarget: "", orderPrefix: "" };
const errorText = (d: ApiBody, fallback: string) => d?.errors?.join(", ") ?? d?.message ?? fallback;

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: ApiBody }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? adminHeaders() : { "Content-Type": "application/json", ...adminHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as ApiBody;
  return { ok: res.ok, data };
}

const STATUS_BADGE: Record<string, string> = {
  REQUESTED: "text-bg-warning", APPROVED: "text-bg-info", IN_TRANSIT: "text-bg-primary",
  COMPLETED: "text-bg-success", CANCELLED: "text-bg-secondary", RETURNING: "text-bg-warning",
};

export default function WarehousesPanel({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const openTransfers = transfers.filter((t) => (t.status === "REQUESTED" || t.status === "APPROVED") && t.kind !== "ORDER_RELEASE");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [w, t] = await Promise.all([
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/transfers`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setLocations(w.warehouses ?? []);
      setTransfers(t.transfers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load locations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const saveLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      name: form.name, code: form.code || null, type: form.type, address: form.address || null, consignment: form.consignment,
      // The Page and the take-rice-from rule are set on a place that already exists (the rule names other places).
      ...(editingId ? { facebookPageUrl: form.type === "STORE" ? form.facebookPageUrl.trim() || null : null, takesFrom: form.ruleOn ? form.takesFrom : null } : {}),
      // The store's own name and text on receipts, its target and its order numbers (empty = the business's, from Settings).
      ...(editingId && form.type === "STORE" ? {
        receiptName: form.receiptName.trim() || null, receiptHeader: form.receiptHeader.trim() || null, receiptFooter: form.receiptFooter.trim() || null,
        receiptContact: form.receiptContact.trim() || null, orderPrefix: form.orderPrefix.trim() || null,
        dailySalesTargetMinor: form.dailyTarget.trim() ? Math.round(Number(form.dailyTarget.replace(/,/g, "")) * 100) || null : null,
      } : {}),
    };
    const { ok, data } = editingId
      ? await call(`${API_URL}/admin/warehouses/${editingId}`, "PATCH", body)
      : await call(`${API_URL}/admin/warehouses`, "POST", body);
    setSaving(false);
    if (!ok) { setError(errorText(data, "Could not save the location")); return; }
    toast(editingId ? "Location saved" : "Location added");
    setForm(emptyForm);
    setEditingId(null);
    await load();
  };

  const patchLocation = async (l: Location, patch: Partial<Pick<Location, "isActive" | "isDefault" | "needsReview">>, done: string) => {
    setError(null);
    const { ok, data } = await call(`${API_URL}/admin/warehouses/${l.id}`, "PATCH", patch);
    if (!ok) { setError(errorText(data, "Could not update the location")); return; }
    toast(done);
    await load();
  };

  const startEdit = (l: Location) => {
    setEditingId(l.id);
    setForm({
      name: l.name, code: l.code ?? "", type: l.type, address: l.address ?? "", consignment: l.consignment === true,
      facebookPageUrl: l.facebookPageUrl ?? "", ruleOn: Array.isArray(l.takesFrom), takesFrom: l.takesFrom ?? [],
      receiptName: l.receiptName ?? "", receiptHeader: l.receiptHeader ?? "", receiptFooter: l.receiptFooter ?? "", receiptContact: l.receiptContact ?? "",
      dailyTarget: l.dailySalesTargetMinor ? String(l.dailySalesTargetMinor / 100) : "", orderPrefix: l.orderPrefix ?? "",
    });
  };

  const act = async (t: Transfer, step: "approve" | "cancel", done: string) => {
    setError(null);
    const { ok, data } = await call(`${API_URL}/admin/transfers/${t.id}/${step}`, "PATCH", step === "cancel" ? {} : undefined);
    if (!ok) { setError(errorText(data, "Action failed")); return; }
    toast(done);
    await load();
  };

  return (
    <div>
      <h1 className="h4 mb-1"><i className="bi bi-geo-alt me-2" aria-hidden="true"></i>Locations</h1>
      <p className="text-muted small mb-3">Your stores and warehouse: add one, change its name, receipt text, Facebook Page and where it takes rice from.</p>
      {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}

      <div className="row g-3 mb-3">
        <div className="col-lg-5">
          <form onSubmit={saveLocation} className="card h-100">
            <div className="card-body">
              <h2 className="h6 card-title">{editingId ? "Edit location" : "Add a location"}</h2>
              <div className="row g-2">
                <div className="col-8">
                  <label className="form-label small mb-1" htmlFor="loc-name">Name</label>
                  <input id="loc-name" className="form-control form-control-sm" placeholder="e.g. Lipa" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={60} />
                </div>
                <div className="col-4">
                  <label className="form-label small mb-1" htmlFor="loc-code">Code</label>
                  <input id="loc-code" className="form-control form-control-sm text-uppercase" placeholder="S2" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={6} />
                </div>
                <div className="col-12">
                  <label className="form-label small mb-1" htmlFor="loc-type">Type</label>
                  <select id="loc-type" className="form-select form-select-sm" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as LocationType })}>
                    <option value="STORE">Store (counter)</option>
                    <option value="WAREHOUSE">Warehouse (bulk stock)</option>
                    <option value="BUFFER">Buffer store (covers shortages, no limit)</option>
                  </select>
                </div>
                {form.type === "STORE" && (
                  <div className="col-12">
                    <div className="form-check">
                      <input id="loc-consign" type="checkbox" className="form-check-input" checked={form.consignment} onChange={(e) => setForm({ ...form, consignment: e.target.checked })} />
                      <label className="form-check-label small" htmlFor="loc-consign">Consignment store: sells the main store&apos;s rice and owes its cost for each sale</label>
                    </div>
                  </div>
                )}
                <div className="col-12">
                  <label className="form-label small mb-1" htmlFor="loc-address">Address (for the porter)</label>
                  <input id="loc-address" className="form-control form-control-sm" placeholder="Street, barangay" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={300} />
                </div>
                {editingId && form.type === "STORE" && (
                  <div className="col-12">
                    <label className="form-label small mb-1" htmlFor="loc-page">Facebook Page of this store</label>
                    <input id="loc-page" className="form-control" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="facebook.com/yourpage" value={form.facebookPageUrl} onChange={(e) => setForm({ ...form, facebookPageUrl: e.target.value })} maxLength={300} aria-describedby="loc-page-help" />
                    <div id="loc-page-help" className="form-text">Orders from this Page are this store&apos;s sales, at this store&apos;s prices. Leave empty if the store has no Page.</div>
                  </div>
                )}
                {editingId && form.type === "STORE" && (
                  <fieldset className="col-12 border rounded p-2" id="loc-identity">
                    <legend className="form-label fw-semibold mb-1 float-none w-auto px-1 fs-6">On {form.name || "this store"}&apos;s receipts</legend>
                    <p className="form-text mt-0 mb-2">Leave a box empty to use what is in Settings.</p>
                    <div className="row g-2">
                      <div className="col-sm-6">
                        <label className="form-label small mb-1" htmlFor="loc-rname">Store name on the receipt</label>
                        <input id="loc-rname" className="form-control" maxLength={60} placeholder={form.name} value={form.receiptName} onChange={(e) => setForm({ ...form, receiptName: e.target.value })} />
                      </div>
                      <div className="col-sm-6">
                        <label className="form-label small mb-1" htmlFor="loc-rcontact">Phone number on the receipt</label>
                        <input id="loc-rcontact" className="form-control" maxLength={60} inputMode="tel" placeholder="0917 123 4567" value={form.receiptContact} onChange={(e) => setForm({ ...form, receiptContact: e.target.value })} />
                      </div>
                      <div className="col-sm-6">
                        <label className="form-label small mb-1" htmlFor="loc-rhead">Line under the name</label>
                        <input id="loc-rhead" className="form-control" maxLength={120} placeholder="Street, barangay, town" value={form.receiptHeader} onChange={(e) => setForm({ ...form, receiptHeader: e.target.value })} />
                      </div>
                      <div className="col-sm-6">
                        <label className="form-label small mb-1" htmlFor="loc-rfoot">Last line of the receipt</label>
                        <input id="loc-rfoot" className="form-control" maxLength={120} placeholder="Thank you!" value={form.receiptFooter} onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })} />
                      </div>
                      <div className="col-sm-6">
                        <label className="form-label small mb-1" htmlFor="loc-target">Sales target for one day (₱)</label>
                        <input id="loc-target" className="form-control" inputMode="decimal" placeholder="No own target" value={form.dailyTarget} onChange={(e) => setForm({ ...form, dailyTarget: e.target.value.replace(/[^0-9.,]/g, "") })} aria-describedby="loc-target-help" />
                        <div id="loc-target-help" className="form-text">Shown on Home for this store&apos;s logins.</div>
                      </div>
                      <div className="col-sm-6">
                        <label className="form-label small mb-1" htmlFor="loc-prefix">Order numbers start with</label>
                        <input id="loc-prefix" className="form-control text-uppercase" maxLength={6} autoCapitalize="characters" placeholder="LIPA" value={form.orderPrefix} onChange={(e) => setForm({ ...form, orderPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} aria-describedby="loc-prefix-help" />
                        <div id="loc-prefix-help" className="form-text">Example: <strong>{form.orderPrefix || "LIPA"}-{new Date().getFullYear()}-000001</strong>. For new orders only.</div>
                      </div>
                    </div>
                  </fieldset>
                )}
                {editingId && form.type !== "BUFFER" && (
                  <fieldset className="col-12">
                    <legend className="form-label small mb-1">Where may {form.name || "this place"} take rice from?</legend>
                    <div className="form-check py-1">
                      <input id="loc-rule-off" type="radio" name="loc-rule" className="form-check-input" checked={!form.ruleOn} onChange={() => setForm({ ...form, ruleOn: false })} />
                      <label className="form-check-label" htmlFor="loc-rule-off">Any place that has it (no rule)</label>
                    </div>
                    <div className="form-check py-1">
                      <input id="loc-rule-on" type="radio" name="loc-rule" className="form-check-input" checked={form.ruleOn} onChange={() => setForm({ ...form, ruleOn: true })} />
                      <label className="form-check-label" htmlFor="loc-rule-on">Its own shelf first, then only the places I choose</label>
                    </div>
                    {form.ruleOn && (
                      <div className="border rounded p-2 mt-1" id="loc-rule-list">
                        {form.takesFrom.length === 0 && <div className="small mb-2"><i className="bi bi-info-circle me-1" aria-hidden="true"></i>No other place chosen: it sells from its own shelf only.</div>}
                        {form.takesFrom.length > 0 && (
                          <ol className="list-group list-group-numbered mb-2">
                            {form.takesFrom.map((id, i) => {
                              const o = locations.find((x) => x.id === id);
                              const move = (to: number) => { const next = [...form.takesFrom]; next.splice(i, 1); next.splice(to, 0, id); setForm({ ...form, takesFrom: next }); };
                              return (
                                <li key={id} className="list-group-item d-flex align-items-center gap-2 py-1">
                                  <span className="flex-grow-1 text-break">{o ? label(o) : "A place that was removed"}</span>
                                  <button type="button" className="btn btn-outline-secondary" style={{ minWidth: 44, minHeight: 44 }} disabled={i === 0} onClick={() => move(i - 1)} aria-label={`Move ${o?.name ?? "place"} up`}><i className="bi bi-arrow-up" aria-hidden="true"></i></button>
                                  <button type="button" className="btn btn-outline-secondary" style={{ minWidth: 44, minHeight: 44 }} disabled={i === form.takesFrom.length - 1} onClick={() => move(i + 1)} aria-label={`Move ${o?.name ?? "place"} down`}><i className="bi bi-arrow-down" aria-hidden="true"></i></button>
                                  <button type="button" className="btn btn-outline-danger" style={{ minWidth: 44, minHeight: 44 }} onClick={() => setForm({ ...form, takesFrom: form.takesFrom.filter((x) => x !== id) })} aria-label={`Remove ${o?.name ?? "place"}`}><i className="bi bi-x-lg" aria-hidden="true"></i></button>
                                </li>
                              );
                            })}
                          </ol>
                        )}
                        <div className="d-flex flex-wrap gap-2">
                          {locations.filter((o) => o.id !== editingId && o.isActive && o.type !== "BUFFER" && !form.takesFrom.includes(o.id)).map((o) => (
                            <button key={o.id} type="button" className="btn btn-outline-primary" style={{ minHeight: 44 }} onClick={() => setForm({ ...form, takesFrom: [...form.takesFrom, o.id] })}><i className="bi bi-plus-lg me-1" aria-hidden="true"></i>{o.name}</button>
                          ))}
                        </div>
                        <div className="form-text">It takes from the first place on the list that has the rice, then the next.</div>
                      </div>
                    )}
                  </fieldset>
                )}
              </div>
              <div className="d-flex gap-2 mt-3">
                <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? "Saving…" : editingId ? "Save location" : "Add location"}</button>
                {editingId && <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel</button>}
              </div>
              {locations.length === 0 && <p className="text-muted small mt-2 mb-0">The first location becomes the default.</p>}
            </div>
          </form>
        </div>

        <div className="col-lg-7">
          {/* Moving rice and each store's prices have their own screens (Move stock, Store prices); this screen only sets up the places. */}
          <div className="card h-100"><div className="card-body">
            <h2 className="h6 card-title">Move rice or set a store&apos;s prices</h2>
            <p className="mb-2">These have their own screens now, so there is one place for each job.</p>
            <div className="d-flex flex-wrap gap-2">
              <button type="button" className="btn btn-outline-primary btn-lg" onClick={() => onNavigate?.("moves")}><i className="bi bi-arrow-left-right me-1" aria-hidden="true"></i>Move stock</button>
              <button type="button" className="btn btn-outline-primary btn-lg" onClick={() => onNavigate?.("storeprices")}><i className="bi bi-tags me-1" aria-hidden="true"></i>Store prices</button>
            </div>
          </div></div>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <div className={openTransfers.length > 0 ? "col-lg-5" : "col-12"}>
          <div className="card h-100"><div className="card-body">
            <h2 className="h6 card-title">Locations</h2>
            {loading ? <p className="text-muted small">Loading…</p> : locations.length === 0 ? (
              <p className="text-muted small mb-0">No locations yet — add your first store above.</p>
            ) : (
              <ul className="list-group list-group-flush">
                {locations.map((l) => (
                  <li key={l.id} className={`list-group-item px-0 ${l.isActive ? "" : "opacity-50"}`}>
                    <div className="d-flex justify-content-between align-items-start gap-2">
                      <div>
                        <div className="fw-semibold">{label(l)}</div>
                        <div className="small text-muted">
                          {l.type === "WAREHOUSE" ? "Warehouse" : l.type === "BUFFER" ? "Buffer" : l.consignment ? "Consignment store" : "Store"} · {l.stockCount} products stocked
                          {l.isDefault && <span className="badge text-bg-primary ms-2">Default</span>}
                          {!l.isActive && <span className="badge text-bg-secondary ms-2">Switched off</span>}
                          {l.needsReview && <span className="badge text-bg-warning ms-2">Added by staff — please check</span>}
                        </div>
                        {l.address && <div className="small text-muted">{l.address}</div>}
                        {l.facebookPageUrl && <div className="small text-break"><i className="bi bi-facebook me-1" aria-hidden="true"></i>Page: {l.facebookPageUrl.replace(/^https:\/\/www\./, "")}</div>}
                        {l.type !== "BUFFER" && l.isActive && (
                          <div className="small">
                            <i className="bi bi-box-arrow-in-down me-1" aria-hidden="true"></i>
                            {l.takesFrom == null ? "Takes rice from: any place (no rule yet)"
                              : l.takesFrom.length === 0 ? "Takes rice from: its own shelf only"
                                : `Takes rice from: its own shelf, then ${l.takesFrom.map((id) => locations.find((x) => x.id === id)?.name ?? "?").join(", then ")}`}
                          </div>
                        )}
                      </div>
                      <div className="d-flex flex-wrap gap-1 justify-content-end">
                        {l.needsReview && <button type="button" className="btn btn-sm btn-warning" onClick={() => void patchLocation(l, { needsReview: false }, `${l.name} checked`)}>Mark checked</button>}
                        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => startEdit(l)}>Edit</button>
                        {!l.isDefault && l.isActive && (
                          <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => void patchLocation(l, { isDefault: true }, `${l.name} is now the default`)}>Make default</button>
                        )}
                        {!l.isDefault && (
                          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void patchLocation(l, { isActive: !l.isActive }, l.isActive ? "Location switched off" : "Location switched on")}>
                            {l.isActive ? "Switch off" : "Switch on"}
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div></div>
        </div>

        {openTransfers.length > 0 && <div className="col-lg-7">
          <div className="card h-100"><div className="card-body">
            <h2 className="h6 card-title">Old moves not finished</h2>
            <p className="small mb-2">Moves made the old way that never finished. Cancel the ones that will not happen. New moves are on Move stock.</p>
            {(

              <div className="table-responsive">
                <table className="table table-sm align-middle mb-0">
                  <thead><tr><th>Product</th><th>From → To</th><th className="text-end">Qty</th><th>Status</th><th className="text-end">Actions</th></tr></thead>
                  <tbody>
                    {openTransfers.map((t) => (
                      <tr key={t.id}>
                        <td className="small">{t.docNumber && <div className="text-muted">{t.docNumber}</div>}{t.product.name}{t.reason && <div className="text-muted">{t.reason}</div>}{!!t.shortQty && <div><span className="badge text-bg-danger">Short {t.shortQty}</span></div>}</td>
                        <td className="small text-muted">{label(t.fromWarehouse)} → {label(t.toWarehouse)}</td>
                        <td className="text-end">{t.quantity}</td>
                        <td><span className={`badge ${STATUS_BADGE[t.status] ?? "text-bg-secondary"}`}>{t.status}</span></td>
                        <td className="text-end text-nowrap">
                          {(t.status === "REQUESTED" || t.status === "APPROVED") && t.kind !== "ORDER_RELEASE" && (
                            <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => void act(t, "cancel", "Transfer cancelled")}>Cancel</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div></div>
        </div>}
      </div>
    </div>
  );
}
