"use client";

// Supplier orders (purchase orders), owner and manager only — it shows cost.
//   Orders          what was ordered from a supplier, what has arrived, what is still to come. Counter staff receive a
//                   delivery against an order on Stock in; the order's cost is used, so they never type or see it.
//   New order       supplier, where it goes, expected date, items with quantity and agreed cost
//   To reorder      items about to run out at the pace of the last 2 weeks, with an amount to order; one tap starts a new order
//   Suppliers owe   what arrived (at the agreed cost) minus what was paid; what is still on order; pay, undo, statement
//   Price watch     the new-order form and each order line show the supplier's cost against the last time

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { askConfirm } from "../../lib/ask";
import { toast } from "../../lib/toast";
import { printSlip } from "../../lib/slip-print";
import { PesoInput, KiloInput, WholeInput } from "../NumberBoxes";
import { costMove, draftFromReorder, moveText, type CostMove } from "../../lib/po-view";
import { peso } from "../../lib/number-format";

const qtyText = (loose: boolean, q: number) => (loose ? `${(q / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : q.toLocaleString("en-PH"));
const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" }) : "");

interface Line { id: string; productId: string; name: string; loose: boolean; quantity: number; receivedQty: number; unitCostMinor?: number; lineTotalMinor?: number; move?: CostMove }
interface LastCost { productId: string; name: string; loose: boolean; unitCostMinor: number; at: string; poNumber: string }
interface ReorderItem { productId: string; name: string; loose: boolean; urgency: "OUT" | "NOW" | "SOON"; daysLeft: number | null; availableQty: number; perDay: number; onOrderQty: number; suggestedQty: number; supplierId: string | null; supplierName: string | null; lastCostMinor: number | null; productCostMinor: number }
interface ReorderData { items: ReorderItem[]; soonDays: number; coverDays: number }
interface Order { id: string; docNumber: string; supplierId: string; supplierName: string; locationId: string; locationName: string; status: string; expectedAt: string | null; overdue: boolean; note: string | null; createdAt: string; lines: Line[]; totalMinor?: number; receivedMinor?: number }
interface Supplier { id: string; name: string }
interface Balance { id: string; name: string; contactPerson: string | null; phone: string | null; receivedMinor: number; paidMinor: number; owedMinor: number; pendingMinor: number; openOrders: number; overdueOrders: number; lastPaymentAt: string | null }
interface Entry { id: string; kind: "DELIVERY" | "PAYMENT" | "UNDO"; at: string; ref: string; poNumber: string | null; note: string | null; amountMinor: number; runningMinor: number; canUndo: boolean }
interface Statement { supplier: { id: string; name: string }; owedMinor: number; entries: Entry[] }
interface Loc { id: string; name: string; isActive: boolean; type?: string }
interface Product { id: string; name: string; costMinor?: number; stockBaseUnit: string | null; stockBaseQuantity: number | null; isActive?: boolean }
interface Row { productId: string; qty: string; cost: string }
type Body = { message?: string; errors?: string[] };

const isLoose = (p?: { stockBaseUnit: string | null; stockBaseQuantity: number | null }) => !!p && (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1;
const errText = (d: Body | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const BADGE: Record<string, string> = { OPEN: "text-bg-primary", PARTLY: "text-bg-warning", RECEIVED: "text-bg-success", CANCELLED: "text-bg-secondary" };
const STATUS_TEXT: Record<string, string> = { OPEN: "Waiting", PARTLY: "Partly arrived", RECEIVED: "Complete", CANCELLED: "Cancelled" };
const URGENCY: Record<ReorderItem["urgency"], { text: string; cls: string }> = { OUT: { text: "Out", cls: "text-bg-danger" }, NOW: { text: "Order now", cls: "text-bg-warning" }, SOON: { text: "Soon", cls: "text-bg-secondary" } };
const perDayText = (loose: boolean, q: number) => (loose ? `${(q / 1000).toLocaleString("en-PH", { maximumFractionDigits: 1 })} kg` : q.toLocaleString("en-PH", { maximumFractionDigits: 1 }));

async function call(path: string, method: "GET" | "POST", body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, { method, headers: { "Content-Type": "application/json", ...adminHeaders() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as (Body & Record<string, unknown>) | null };
}

export default function PurchaseOrdersPanel() {
  const [tab, setTab] = useState<"orders" | "reorder" | "owed">("orders");
  const [reorder, setReorder] = useState<ReorderData | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lastCosts, setLastCosts] = useState<LastCost[]>([]);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [balances, setBalances] = useState<{ suppliers: Balance[]; totalOwedMinor: number; totalPendingMinor: number } | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [paying, setPaying] = useState<Balance | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payNote, setPayNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ supplierId: "", supplierName: "", locationId: "", expectedAt: "", note: "" });
  const [rows, setRows] = useState<Row[]>([{ productId: "", qty: "", cost: "" }]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const lastBy = useMemo(() => new Map(lastCosts.map((c) => [c.productId, c])), [lastCosts]);

  const loadOrders = useCallback(async () => {
    const r = await call(`/admin/purchase-orders?status=${filter}`, "GET");
    if (!r.ok) { setError(errText(r.data, "Could not load the orders")); return; }
    setOrders((r.data as unknown as { orders: Order[] }).orders);
  }, [filter]);
  const loadOwed = useCallback(async () => {
    const r = await call("/admin/purchase-orders/owed", "GET");
    if (!r.ok) { setError(errText(r.data, "Could not load what is owed")); return; }
    setBalances(r.data as unknown as NonNullable<typeof balances>);
  }, []);

  const loadReorder = useCallback(async () => {
    const r = await call("/admin/purchase-orders/reorder", "GET");
    if (!r.ok) { setError(errText(r.data, "Could not work out what to reorder")); return; }
    const d = r.data as unknown as ReorderData;
    setReorder(d);
    setPicked(new Set(d.items.map((i) => i.productId)));
  }, []);

  useEffect(() => { void loadOrders().catch(() => setError("Could not load the orders")); }, [loadOrders]);
  useEffect(() => { void loadReorder().catch(() => setError("Could not work out what to reorder")); }, [loadReorder]);
  // Price watch: what the chosen supplier charged last time
  useEffect(() => {
    if (!form.supplierId) { setLastCosts([]); return; }
    let live = true;
    void call(`/admin/purchase-orders/last-costs?supplierId=${encodeURIComponent(form.supplierId)}`, "GET").then((r) => {
      if (live && r.ok) setLastCosts((r.data as unknown as { costs: LastCost[] }).costs);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [form.supplierId]);
  useEffect(() => { if (tab === "owed") void loadOwed().catch(() => setError("Could not load what is owed")); }, [tab, loadOwed]);
  useEffect(() => {
    void call("/admin/purchase-orders/suppliers", "GET").then((r) => { if (r.ok) setSuppliers((r.data as unknown as { suppliers: Supplier[] }).suppliers); }).catch(() => undefined);
    fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      const locs = ((d?.warehouses ?? []) as (Loc & { isDefault?: boolean })[]).filter((l) => l.isActive && l.type !== "BUFFER");
      setLocations(locs);
      setForm((f) => ({ ...f, locationId: f.locationId || locs.find((l) => l.isDefault)?.id || locs[0]?.id || "" }));
    }).catch(() => undefined);
    fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      setProducts(((d?.products ?? d?.items ?? []) as Product[]).filter((p) => p.isActive !== false));
    }).catch(() => undefined);
  }, []);

  const act = async (path: string, body: unknown, done: string): Promise<boolean> => {
    setBusy(true); setError(null);
    const r = await call(path, "POST", body);
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "That did not go through")); return false; }
    toast(done);
    return true;
  };

  // ───────────── new order ─────────────
  const unitsOf = (r: Row) => { const p = byId.get(r.productId); const n = Number(r.qty); return !p || !(n > 0) ? 0 : isLoose(p) ? Math.round(n * 1000) : Number.isInteger(n) ? n : 0; };
  const costOf = (r: Row) => Math.round(Number(r.cost) * 100);
  const rowTotal = (r: Row) => { const p = byId.get(r.productId); const u = unitsOf(r); const c = costOf(r); return !p || u <= 0 || !(c > 0) ? 0 : isLoose(p) ? Math.round((u * c) / 1000) : u * c; };
  const orderTotal = rows.reduce((s, r) => s + rowTotal(r), 0);
  const supplierOk = form.supplierId !== "" || form.supplierName.trim().length >= 2;
  const canCreate = supplierOk && !!form.locationId && rows.length > 0 && rows.every((r) => r.productId && unitsOf(r) > 0 && costOf(r) > 0) && new Set(rows.map((r) => r.productId)).size === rows.length && !busy;

  const createOrder = async () => {
    const ok = await act("/admin/purchase-orders", {
      supplierId: form.supplierId || undefined, supplierName: form.supplierId ? undefined : form.supplierName.trim(),
      locationId: form.locationId, expectedAt: form.expectedAt || undefined, note: form.note.trim() || undefined,
      lines: rows.map((r) => ({ productId: r.productId, quantity: unitsOf(r), unitCostMinor: costOf(r) })),
    }, "Order saved");
    if (!ok) return;
    setCreating(false);
    setRows([{ productId: "", qty: "", cost: "" }]);
    setForm((f) => ({ ...f, supplierId: "", supplierName: "", expectedAt: "", note: "" }));
    setFilter("open");
    await loadOrders();
    void loadReorder().catch(() => undefined);
    const s = await call("/admin/purchase-orders/suppliers", "GET");
    if (s.ok) setSuppliers((s.data as unknown as { suppliers: Supplier[] }).suppliers);
  };

  // ───────────── to reorder ─────────────
  const startOrder = () => {
    if (!reorder) return;
    const chosen = reorder.items.filter((i) => picked.has(i.productId) && byId.has(i.productId));
    if (chosen.length === 0) return;
    const d = draftFromReorder(chosen);
    setForm((f) => ({ ...f, supplierId: d.supplierId, supplierName: "" }));
    setRows(d.rows);
    setCreating(true);
    setFilter("open");
    setTab("orders");
  };
  const togglePick = (id: string) => setPicked((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const cancelOrder = async (o: Order) => {
    const arrived = o.lines.some((l) => l.receivedQty > 0);
    const yes = await askConfirm(arrived ? `Close ${o.docNumber}? What already arrived stays; the rest will no longer be expected.` : `Cancel ${o.docNumber}?`, { ok: arrived ? "Close order" : "Cancel order", danger: true });
    if (!yes) return;
    if (await act(`/admin/purchase-orders/${o.id}/cancel`, {}, arrived ? "Order closed" : "Order cancelled")) await loadOrders();
  };

  const printOrder = (o: Order) => printSlip({
    storeName: "Purchase order", title: `ORDER ${o.docNumber}`, reference: o.docNumber, when: new Date(o.createdAt).toLocaleString("en-PH"),
    lines: [{ label: "Supplier", value: o.supplierName }, { label: "Deliver to", value: o.locationName }, ...(o.expectedAt ? [{ label: "Expected", value: dateText(o.expectedAt) }] : [])],
    rows: o.lines.map((l) => ({ name: l.name, qty: qtyText(l.loose, l.quantity), note: l.unitCostMinor !== undefined ? `@ ${peso(l.unitCostMinor)}${l.loose ? "/kg" : ""}` : undefined })),
    totals: o.totalMinor !== undefined ? [{ label: "Total", value: peso(o.totalMinor) }] : [],
    footer: o.note,
  });

  // ───────────── what we owe ─────────────
  const openStatement = async (b: { id: string }) => {
    const r = await call(`/admin/purchase-orders/owed/${encodeURIComponent(b.id)}`, "GET");
    if (!r.ok) { setError(errText(r.data, "Could not load the statement")); return; }
    setStatement(r.data as unknown as Statement);
  };
  const pay = async () => {
    if (!paying) return;
    const ok = await act("/admin/purchase-orders/pay", { supplierId: paying.id, amountMinor: Math.round(Number(payAmount) * 100), note: payNote.trim() || undefined }, "Payment recorded");
    if (!ok) return;
    const id = paying.id;
    setPaying(null);
    await loadOwed();
    if (statement?.supplier.id === id) await openStatement({ id });
  };
  const undoPay = async (e: Entry) => {
    const yes = await askConfirm(`Undo payment ${e.ref} of ${peso(Math.abs(e.amountMinor))}?`, { ok: "Undo payment", danger: true });
    if (!yes || !statement) return;
    if (await act(`/admin/purchase-orders/pay/${e.id}/undo`, {}, "Payment undone")) { await loadOwed(); await openStatement({ id: statement.supplier.id }); }
  };
  const printStatement = (s: Statement) => printSlip({
    storeName: "Supplier statement", title: `STATEMENT — ${s.supplier.name}`, when: new Date().toLocaleString("en-PH"), a4: true,
    rows: [...s.entries].reverse().map((e) => ({ name: `${e.ref} ${e.kind === "DELIVERY" ? `Delivery${e.poNumber ? ` (${e.poNumber})` : ""}` : e.kind === "PAYMENT" ? "Payment" : "Undo"}`, qty: `${e.amountMinor < 0 ? "−" : ""}${peso(Math.abs(e.amountMinor))}`, note: `balance ${peso(e.runningMinor)}` })),
    totals: [{ label: "We owe", value: peso(s.owedMinor) }],
  });

  return (
    <div className="container-fluid py-3" style={{ maxWidth: 960 }}>
      <h5 className="mb-1">Supplier orders</h5>
      <p className="text-muted small">Order rice from a supplier, receive the delivery on Stock in against the order, and see what you owe.</p>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      <ul className="nav nav-pills mb-3">
        <li className="nav-item"><button type="button" className={`nav-link ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>Orders</button></li>
        <li className="nav-item"><button type="button" className={`nav-link ${tab === "reorder" ? "active" : ""}`} onClick={() => { setTab("reorder"); void loadReorder().catch(() => undefined); }}>To reorder{reorder && reorder.items.length > 0 ? ` (${reorder.items.length})` : ""}</button></li>
        <li className="nav-item"><button type="button" className={`nav-link ${tab === "owed" ? "active" : ""}`} onClick={() => setTab("owed")}>Suppliers owe</button></li>
      </ul>

      {tab === "orders" && (
        <>
          <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
            <button type="button" className="btn btn-primary" onClick={() => setCreating(!creating)}>{creating ? "Close" : "+ New order"}</button>
            <div className="btn-group ms-auto" role="group" aria-label="Show">
              <button type="button" className={`btn btn-outline-secondary btn-sm ${filter === "open" ? "active" : ""}`} onClick={() => setFilter("open")}>Waiting</button>
              <button type="button" className={`btn btn-outline-secondary btn-sm ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All</button>
            </div>
          </div>

          {creating && (
            <div className="border rounded p-3 mb-3 bg-body-tertiary">
              <div className="row g-2 mb-2">
                <div className="col-12 col-md-4">
                  <label className="form-label small mb-1" htmlFor="po-sup">Supplier</label>
                  <select id="po-sup" className="form-select" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                    <option value="">New supplier…</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                {!form.supplierId && (
                  <div className="col-12 col-md-4">
                    <label className="form-label small mb-1" htmlFor="po-supname">Supplier name</label>
                    <input id="po-supname" className="form-control" value={form.supplierName} maxLength={80} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} />
                  </div>
                )}
                <div className="col-6 col-md-2">
                  <label className="form-label small mb-1" htmlFor="po-loc">Deliver to</label>
                  <select id="po-loc" className="form-select" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
                <div className="col-6 col-md-2">
                  <label className="form-label small mb-1" htmlFor="po-date">Expected</label>
                  <input id="po-date" type="date" className="form-control" value={form.expectedAt} onChange={(e) => setForm({ ...form, expectedAt: e.target.value })} />
                </div>
              </div>
              {rows.map((r, i) => {
                const p = byId.get(r.productId);
                const last = form.supplierId ? lastBy.get(r.productId) : undefined;
                const mv = last && costOf(r) > 0 ? costMove(last.unitCostMinor, costOf(r)) : null;
                return (
                  <div key={i} className="row g-2 mb-2 align-items-end">
                    <div className="col-12 col-md-5">
                      {i === 0 && <label className="form-label small mb-1">Item</label>}
                      <select className="form-select" aria-label={`Item ${i + 1}`} value={r.productId}
                        onChange={(e) => { const np = byId.get(e.target.value); const lc = lastBy.get(e.target.value); setRows(rows.map((x, j) => (j === i ? { ...x, productId: e.target.value, cost: lc ? String(lc.unitCostMinor / 100) : np?.costMinor ? String(np.costMinor / 100) : x.cost } : x))); }}>
                        <option value="">Choose…</option>
                        {products.map((x) => <option key={x.id} value={x.id} disabled={rows.some((y, j) => j !== i && y.productId === x.id)}>{x.name}</option>)}
                      </select>
                    </div>
                    <div className="col-5 col-md-2">
                      {i === 0 && <label className="form-label small mb-1">{p && isLoose(p) ? "Kilos" : "How many"}</label>}
                      {p && isLoose(p)
                        ? <KiloInput className="form-control" aria-label="Kilos" value={r.qty} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: v } : x)))} />
                        : <WholeInput className="form-control" aria-label="How many" value={r.qty} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: v } : x)))} />}
                    </div>
                    <div className="col-5 col-md-3">
                      {i === 0 && <label className="form-label small mb-1">Agreed cost {p && isLoose(p) ? "per kilo" : "each"}</label>}
                      <PesoInput className="form-control" aria-label="Agreed cost" value={r.cost} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, cost: v } : x)))} placeholder="0.00" />
                      {last && (
                        <div className={`small mt-1 ${mv?.kind === "UP" ? (mv.big ? "text-danger fw-semibold" : "text-warning-emphasis") : mv?.kind === "DOWN" ? "text-success" : "text-muted"}`}>
                          {mv ? moveText(mv, peso) : `Last time ${peso(last.unitCostMinor)}${last.loose ? "/kg" : ""} (${dateText(last.at)})`}
                        </div>
                      )}
                    </div>
                    <div className="col-2 col-md-2 text-end">
                      {rows.length > 1 && <button type="button" className="btn btn-link text-danger" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>}
                    </div>
                  </div>
                );
              })}
              <div className="d-flex flex-wrap gap-2 align-items-center mt-2">
                <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setRows([...rows, { productId: "", qty: "", cost: "" }])}>+ One more item</button>
                <input className="form-control form-control-sm" style={{ maxWidth: 260 }} placeholder="Note (optional)" aria-label="Note" maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                <span className="ms-auto fw-semibold">Total {peso(orderTotal)}</span>
                <button type="button" className="btn btn-success" disabled={!canCreate} onClick={() => void createOrder()}>{busy ? "Please wait…" : "Save order"}</button>
              </div>
            </div>
          )}

          {orders === null ? <p className="text-muted">Loading…</p> : orders.length === 0 ? (
            <p className="text-muted">{filter === "open" ? "Nothing is waiting for a delivery." : "No orders yet."}</p>
          ) : (
            <div className="d-flex flex-column gap-2">
              {orders.map((o) => (
                <div key={o.id} className="border rounded p-3">
                  <div className="d-flex flex-wrap justify-content-between gap-2 mb-1">
                    <div>
                      <span className="fw-semibold">{o.docNumber}</span> · {o.supplierName}
                      <span className={`badge ms-2 ${BADGE[o.status] ?? "text-bg-secondary"}`}>{STATUS_TEXT[o.status] ?? o.status}</span>
                      {o.overdue && <span className="badge text-bg-danger ms-1">Late</span>}
                    </div>
                    <div className="small text-muted">To {o.locationName}{o.expectedAt ? ` · expected ${dateText(o.expectedAt)}` : ""}</div>
                  </div>
                  <div className="table-responsive">
                    <table className="table table-sm mb-1">
                      <thead><tr><th>Item</th><th className="text-end">Ordered</th><th className="text-end">Arrived</th><th className="text-end">Left</th><th className="text-end">Cost</th></tr></thead>
                      <tbody>{o.lines.map((l) => (
                        <tr key={l.id}>
                          <td>{l.name}</td>
                          <td className="text-end">{qtyText(l.loose, l.quantity)}</td>
                          <td className="text-end">{qtyText(l.loose, l.receivedQty)}</td>
                          <td className="text-end">{qtyText(l.loose, Math.max(0, l.quantity - l.receivedQty))}</td>
                          <td className="text-end">
                            {l.unitCostMinor !== undefined ? `${peso(l.unitCostMinor)}${l.loose ? "/kg" : ""}` : ""}
                            {l.move && (l.move.kind === "UP" || l.move.kind === "DOWN") && (
                              <div className={`small ${l.move.kind === "UP" ? (l.move.big ? "text-danger fw-semibold" : "text-warning-emphasis") : "text-success"}`} title={moveText(l.move, peso)}>
                                {l.move.kind === "UP" ? "Up" : "Down"} {Math.abs(l.move.pct)}%
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div className="d-flex flex-wrap align-items-center gap-2">
                    <span className="small text-muted">Order {peso(o.totalMinor ?? 0)} · arrived {peso(o.receivedMinor ?? 0)}{o.note ? ` · ${o.note}` : ""}</span>
                    <span className="ms-auto d-flex gap-2">
                      <button type="button" className="btn btn-outline-dark btn-sm" onClick={() => printOrder(o)}><i className="bi bi-printer me-1"></i>Print</button>
                      {(o.status === "OPEN" || o.status === "PARTLY") && (
                        <button type="button" className="btn btn-outline-danger btn-sm" disabled={busy} onClick={() => void cancelOrder(o)}>{o.lines.some((l) => l.receivedQty > 0) ? "Close order" : "Cancel order"}</button>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="small text-muted mt-3">To receive a delivery, open <b>Stock in</b>, choose the store, then pick the order. Counter staff see what was ordered but not the cost.</p>
        </>
      )}

      {tab === "reorder" && (
        <>
          {reorder === null ? <p className="text-muted">Loading…</p> : reorder.items.length === 0 ? (
            <p className="text-muted">Nothing is about to run out. An item is listed here when, at the pace of the last 2 weeks, it would run out within {reorder.soonDays} days, counting what is already on order.</p>
          ) : (
            <>
              <p className="small text-muted">
                These would run out within {reorder.soonDays} days at the pace of the last 2 weeks (all stores and the warehouse together). The amount to order is enough for {reorder.coverDays} days of selling; rice already on order is taken off.
                Untick what you do not want, then start an order.
              </p>
              <div className="table-responsive">
                <table className="table table-sm align-middle">
                  <thead><tr><th /><th>Item</th><th className="text-end">Left</th><th className="text-end">Sells a day</th><th className="text-end">Days left</th><th className="text-end">On order</th><th className="text-end">Order</th><th>Last supplier</th></tr></thead>
                  <tbody>{reorder.items.map((i) => (
                    <tr key={i.productId}>
                      <td><input type="checkbox" className="form-check-input" aria-label={`Order ${i.name}`} checked={picked.has(i.productId)} onChange={() => togglePick(i.productId)} /></td>
                      <td>{i.name} <span className={`badge ${URGENCY[i.urgency].cls}`}>{URGENCY[i.urgency].text}</span></td>
                      <td className="text-end">{qtyText(i.loose, i.availableQty)}</td>
                      <td className="text-end">{perDayText(i.loose, i.perDay)}</td>
                      <td className="text-end">{i.daysLeft === null ? "" : i.daysLeft.toLocaleString("en-PH", { maximumFractionDigits: 1 })}</td>
                      <td className="text-end">{i.onOrderQty > 0 ? qtyText(i.loose, i.onOrderQty) : ""}</td>
                      <td className="text-end fw-semibold">{qtyText(i.loose, i.suggestedQty)}</td>
                      <td className="small">{i.supplierName ?? <span className="text-muted">none yet</span>}{i.lastCostMinor !== null ? <div className="text-muted">{peso(i.lastCostMinor)}{i.loose ? "/kg" : ""}</div> : null}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <button type="button" className="btn btn-primary" disabled={picked.size === 0} onClick={startOrder}>Start an order with the {picked.size} ticked item{picked.size === 1 ? "" : "s"}</button>
              <p className="small text-muted mt-2 mb-0">The new order opens with the amounts filled in. Change anything, choose the supplier if it is empty, then save.</p>
            </>
          )}
        </>
      )}

      {tab === "owed" && (
        <>
          {balances === null ? <p className="text-muted">Loading…</p> : (
            <>
              <div className="row g-2 mb-3">
                <div className="col-6"><div className="border rounded p-3"><div className="small text-muted">You owe suppliers</div><div className="fs-3 fw-semibold">{peso(balances.totalOwedMinor)}</div></div></div>
                <div className="col-6"><div className="border rounded p-3"><div className="small text-muted">Still on order (not yet delivered)</div><div className="fs-3 fw-semibold">{peso(balances.totalPendingMinor)}</div></div></div>
              </div>
              {balances.suppliers.length === 0 && <p className="text-muted">No suppliers yet. Make an order and the supplier is added.</p>}
              <div className="d-flex flex-column gap-2">
                {balances.suppliers.map((b) => (
                  <div key={b.id} className={`border rounded p-3 ${b.owedMinor > 0 ? "border-warning" : ""}`}>
                    <div className="d-flex flex-wrap justify-content-between gap-2">
                      <div>
                        <div className="fw-semibold">{b.name}{b.overdueOrders > 0 && <span className="badge text-bg-danger ms-2">{b.overdueOrders} late</span>}</div>
                        <div className="small text-muted">{[b.contactPerson, b.phone].filter(Boolean).join(" · ")}</div>
                      </div>
                      <div className="text-end">
                        <div className="small text-muted">{b.owedMinor < 0 ? "Paid ahead" : "You owe"}</div>
                        <div className="fs-4 fw-semibold">{peso(Math.abs(b.owedMinor))}</div>
                      </div>
                    </div>
                    <div className="small text-muted my-1">Delivered {peso(b.receivedMinor)} · Paid {peso(b.paidMinor)} · On order {peso(b.pendingMinor)} ({b.openOrders} order{b.openOrders === 1 ? "" : "s"}){b.lastPaymentAt ? ` · last paid ${dateText(b.lastPaymentAt)}` : ""}</div>
                    <div className="d-flex gap-2">
                      <button type="button" className="btn btn-success btn-sm" disabled={b.owedMinor <= 0 && b.pendingMinor <= 0} onClick={() => { setPaying(b); setPayAmount(""); setPayNote(""); }}>Record payment</button>
                      <button type="button" className="btn btn-outline-dark btn-sm" onClick={() => void openStatement(b)}>Statement</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {paying && (
            <div className="border rounded p-3 my-3 bg-body-tertiary">
              <div className="fw-semibold mb-2">Pay {paying.name} ({peso(Math.max(0, paying.owedMinor))} owed)</div>
              <div className="row g-2 align-items-end">
                <div className="col-6 col-md-4"><label className="form-label small mb-1" htmlFor="sp-amt">Amount paid</label><PesoInput id="sp-amt" className="form-control form-control-lg" value={payAmount} onChange={setPayAmount} placeholder="0.00" /></div>
                <div className="col-12 col-md-4"><label className="form-label small mb-1" htmlFor="sp-note">Note (optional)</label><input id="sp-note" className="form-control form-control-lg" value={payNote} maxLength={200} onChange={(e) => setPayNote(e.target.value)} /></div>
                <div className="col-12 col-md-4 d-flex gap-2">
                  <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setPaying(null)}>Cancel</button>
                  <button type="button" className="btn btn-success btn-lg flex-fill" disabled={busy || !(Number(payAmount) > 0)} onClick={() => void pay()}>Save payment</button>
                </div>
              </div>
            </div>
          )}

          {statement && (
            <div className="border rounded p-3 my-3">
              <div className="d-flex flex-wrap justify-content-between gap-2 mb-2">
                <div className="fw-semibold">{statement.supplier.name}: statement (we owe {peso(statement.owedMinor)})</div>
                <div className="d-flex gap-2">
                  <button type="button" className="btn btn-outline-dark btn-sm" onClick={() => printStatement(statement)}><i className="bi bi-printer me-1"></i>Print</button>
                  <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setStatement(null)}>Close</button>
                </div>
              </div>
              {statement.entries.length === 0 ? <p className="text-muted small mb-0">Nothing yet.</p> : (
                <div className="table-responsive"><table className="table table-sm align-middle mb-0">
                  <thead><tr><th>Date</th><th>What</th><th className="text-end">Amount</th><th className="text-end">Balance</th><th /></tr></thead>
                  <tbody>{statement.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="text-nowrap">{dateText(e.at)}</td>
                      <td>{e.kind === "DELIVERY" ? <>Delivery {e.ref}{e.poNumber ? ` · ${e.poNumber}` : ""}</> : <>{e.kind === "PAYMENT" ? "Payment" : "Undo"} {e.ref}{e.note ? <span className="text-muted"> · {e.note}</span> : null}</>}</td>
                      <td className={`text-end ${e.amountMinor < 0 ? "text-success" : ""}`}>{e.amountMinor < 0 ? "−" : ""}{peso(Math.abs(e.amountMinor))}</td>
                      <td className="text-end">{peso(e.runningMinor)}</td>
                      <td className="text-end">{e.canUndo && <button type="button" className="btn btn-link btn-sm py-0" disabled={busy} onClick={() => void undoPay(e)}>Undo</button>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
