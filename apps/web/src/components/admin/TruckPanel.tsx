"use client";

// Truck arrived (2026-11-22): one truck counted once. Every good sack that came goes to exactly one place:
// a pre-order handed straight from the truck, or a store's shelf. "Finish" stays grey until
// "Left on truck" is 0 for every rice. Owner and managers only (the owner's answer).
//
// 1 What came (supplier order or typed, good and damaged sacks)  2 Customers at the truck (waiting pre-orders)
// 3 The rest on shelves  4 Sign and finish → the truck sheet, and the pre-orders to collect payment for.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { peso } from "../../lib/number-format";
import { printSlip, type Slip } from "../../lib/slip-print";
import SignaturePad from "./SignaturePad";

interface Loc { id: string; name: string; code: string | null; type: string; isActive: boolean; isDefault?: boolean }
interface Product { id: string; name: string; stockBaseUnit: string | null; stockBaseQuantity: number | null; isActive?: boolean; reviewStatus?: string }
interface PoLine { id: string; productId: string; name: string; loose: boolean; quantity: number; receivedQty: number }
interface Po { id: string; docNumber: string; supplierName: string; locationId: string; locationName: string; expectedAt: string | null; lines: PoLine[] }
interface PreOrder { id: string; orderNumber: string; customerName: string; status: string; totalMinor: number; locationId: string | null; locationName: string | null; createdAt: string; items: { productId: string | null; productName: string; quantity: number }[] }
interface Line { productId: string; good: string; damaged: string; price: string } // price: pesos typed, "" = the store's price
interface Cat { priceMinor: number; floorMinor: number }
interface Cust { id: string; name: string }
interface Draft { poId: string; supplier: string; lines: Line[]; unloadId: string; sellId: string; given: string[]; shelf: Record<string, Record<string, string>> }
interface Summary {
  sellingName: string; unloadName: string; purchaseOrder: { docNumber: string } | null; supplierName: string | null;
  lines: { productId: string; name: string; good: number; damaged: number; short: number; toCustomers: number }[];
  preorders: { orderId: string; orderNumber: string; customerName: string; fromName: string | null; totalMinor: number; items: { name: string; quantity: number }[] }[];
  shelves: { name: string; code: string | null; items: { name: string; quantity: number }[] }[];
  stockIns: { docNumber: string }[];
}
interface Truck { id: string; docNumber: string; createdAt: string; summary: Summary }
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const isLoose = (p?: { stockBaseUnit: string | null; stockBaseQuantity: number | null }) => !!p && p.stockBaseUnit === "g" && p.stockBaseQuantity === 1;
const whole = (v: string) => v.replace(/\D/g, "").slice(0, 6);
const n = (v: string | undefined) => Number(v || 0) || 0;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const get = (path: string) => fetch(`${API_URL}${path}`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const sacks = (q: number) => `${q} sack${q === 1 ? "" : "s"}`;
const money = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 9);
const toMinor = (v: string) => Math.round(Number(v) * 100);
// The truck being counted stays on this tablet while the user looks at other screens (2026-11-22).
const DRAFT_KEY = "sam.truckDraft.v1";
const readDraft = (): Draft | null => { try { const t = localStorage.getItem(DRAFT_KEY); return t ? (JSON.parse(t) as Draft) : null; } catch { return null; } };
const writeDraft = (d: Draft | null) => { try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); } catch { /* private window */ } };
const send = (path: string, method: string, body: unknown) =>
  fetch(`${API_URL}${path}`, { method, headers: { ...adminHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, d: (await r.json().catch(() => null)) as ApiBody | null }))
    .catch(() => ({ ok: false, d: { message: "No internet. Try again when it is back." } as ApiBody }));

export default function TruckPanel({ onNavigate }: { role?: string; onNavigate?: (tab: string) => void }) {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [homeId, setHomeId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Po[]>([]);
  const [preorders, setPreorders] = useState<PreOrder[]>([]);
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [storeName, setStoreName] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [poId, setPoId] = useState("");
  const [supplier, setSupplier] = useState("");
  const [lines, setLines] = useState<Line[]>([{ productId: "", good: "", damaged: "", price: "" }]);
  const [unloadId, setUnloadId] = useState("");
  const [sellId, setSellId] = useState("");
  const [given, setGiven] = useState<Set<string>>(new Set());
  const [shelf, setShelf] = useState<Record<string, Record<string, string>>>({}); // productId → locationId → sacks
  const [sig, setSig] = useState<string | null>(null);
  const [sigKey, setSigKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Truck | null>(null);
  const [paid, setPaid] = useState<Set<string>>(new Set());
  const [cat, setCat] = useState<Record<string, Cat>>({}); // the selling store's prices
  const [custs, setCusts] = useState<Cust[] | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newCust, setNewCust] = useState("");
  const [newName, setNewName] = useState("");
  const [newQty, setNewQty] = useState<Record<string, string>>({});
  const restored = useRef(false);

  const load = useCallback(async () => {
    const [me, locs, ps, po, pre, tr, st] = await Promise.all([
      get("/admin/me/rice"), get("/admin/warehouses"), get("/admin/products"), get("/admin/purchase-orders?status=open"),
      get("/admin/pos/preorders"), get("/admin/trucks"), get("/admin/settings"),
    ]);
    const active = ((locs?.warehouses ?? []) as Loc[]).filter((l) => l.isActive && l.type !== "BUFFER");
    setLocations(active);
    const home = (me?.homeLocationId as string | null) ?? null;
    setHomeId(home);
    const main = active.find((l) => l.isDefault) ?? active.find((l) => l.type === "STORE");
    setSellId((cur) => cur || home || main?.id || "");
    setUnloadId((cur) => cur || active.find((l) => l.type === "WAREHOUSE")?.id || main?.id || "");
    setProducts(((ps?.products ?? []) as Product[]).filter((p) => p.isActive !== false && p.reviewStatus !== "MERGED" && !isLoose(p)));
    setOrders(((po?.orders ?? []) as Po[]).filter((o) => o.lines.some((l) => !l.loose && l.quantity > l.receivedQty)));
    setPreorders(((pre?.preorders ?? []) as PreOrder[]).filter((o) => o.status === "ON_HOLD"));
    setTrucks((tr?.trucks ?? []) as Truck[]);
    setStoreName(st?.name ?? "");
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Bring back the truck typed before (another screen was opened in between). A supplier order that is
  // already filled, or a pre-order that is no longer waiting, is dropped.
  useEffect(() => {
    if (!loaded || restored.current) return;
    restored.current = true;
    const d = readDraft();
    if (!d) return;
    if (d.poId && !orders.some((o) => o.id === d.poId)) { writeDraft(null); return; }
    setPoId(d.poId); setSupplier(d.supplier); setLines(d.lines.length ? d.lines.map((l) => ({ ...l, price: l.price ?? "" })) : lines);
    if (locations.some((l) => l.id === d.unloadId)) setUnloadId(d.unloadId);
    if (!homeId && locations.some((l) => l.id === d.sellId)) setSellId(d.sellId);
    setGiven(new Set(d.given.filter((id) => preorders.some((o) => o.id === id))));
    setShelf(d.shelf ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  const started = !!poId || !!supplier.trim() || lines.some((l) => l.productId || l.good || l.damaged || l.price);
  useEffect(() => {
    if (!restored.current) return;
    writeDraft(started ? { poId, supplier, lines, unloadId, sellId, given: [...given], shelf } : null);
  }, [started, poId, supplier, lines, unloadId, sellId, given, shelf]);
  const startOver = () => {
    writeDraft(null);
    setPoId(""); setLines([{ productId: "", good: "", damaged: "", price: "" }]); setSupplier(""); setGiven(new Set()); setShelf({}); setSig(null); setSigKey((k) => k + 1);
    setNewOpen(false); setNewQty({}); setError(null);
  };

  // The selling store's own prices: what each rice from this truck will sell for there.
  useEffect(() => {
    if (!sellId) return;
    let live = true;
    void get(`/admin/benta/catalog?locationId=${encodeURIComponent(sellId)}`).then((c) => {
      if (!live) return;
      const m: Record<string, Cat> = {};
      for (const p of (c?.products ?? []) as { id: string; priceMinor: number; floorMinor?: number }[]) m[p.id] = { priceMinor: p.priceMinor, floorMinor: p.floorMinor ?? 0 };
      setCat(m);
    });
    return () => { live = false; };
  }, [sellId]);
  const priceOf = (l: Line) => (l.price !== "" ? toMinor(l.price) : cat[l.productId]?.priceMinor ?? 0);
  const priceChanged = (l: Line) => !!l.productId && l.price !== "" && toMinor(l.price) > 0 && toMinor(l.price) !== cat[l.productId]?.priceMinor;
  /** Saves every changed selling price as the selling store's price. Returns an error to show, or null. */
  const savePrices = async (): Promise<string | null> => {
    for (const l of lines.filter(priceChanged)) {
      const r = await send(`/admin/warehouses/${encodeURIComponent(sellId)}/prices/${encodeURIComponent(l.productId)}`, "PUT", { priceMinor: toMinor(l.price) });
      if (!r.ok) return `${nameOf(l.productId)} price: ${errText(r.d, "did not save")}`;
      setCat((c) => ({ ...c, [l.productId]: { priceMinor: toMinor(l.price), floorMinor: c[l.productId]?.floorMinor ?? 0 } }));
    }
    setLines((ls) => ls.map((l) => (priceChanged(l) ? { ...l, price: "" } : l)));
    return null;
  };

  // A customer who orders right at the truck: a pre-order of the selling store, ticked as given.
  const openNew = () => {
    setNewOpen(true); setNewCust(""); setNewName(""); setNewQty({});
    if (!custs) void get("/admin/customers").then((c) => setCusts((((c?.customers ?? []) as Cust[]).slice()).sort((a, b) => a.name.localeCompare(b.name))));
  };
  const newItems = lines.filter((l) => l.productId && n(newQty[l.productId]) > 0).map((l) => ({ productId: l.productId, quantity: n(newQty[l.productId]) }));
  const newReady = newItems.length > 0 && (!!newCust || newName.trim().length > 0);
  const saveNew = async () => {
    if (!newReady || busy) return;
    setBusy(true); setError(null);
    const priceErr = await savePrices();
    if (priceErr) { setBusy(false); setError(priceErr); return; }
    const who = newCust ? { customerId: newCust } : { customerName: newName.trim().slice(0, 80) };
    const r = await send("/admin/pos/preorder", "POST", { ...who, items: newItems, locationId: sellId, idempotencyKey: `truck-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    setBusy(false);
    if (!r.ok) { setError(errText(r.d, "The order did not save")); return; }
    const id = String(r.d?.orderId ?? "");
    toast(`Order saved: ${String(r.d?.orderNumber ?? "")}`);
    setNewOpen(false); setNewQty({});
    if (!newCust) setCusts(null); // a new customer was added
    await load();
    if (id) setGiven((s) => new Set(s).add(id));
  };

  const po = orders.find((o) => o.id === poId);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const nameOf = (pid: string) => po?.lines.find((l) => l.productId === pid)?.name ?? byId.get(pid)?.name ?? "Rice";
  const pickOrder = (id: string) => {
    setPoId(id); setGiven(new Set()); setShelf({});
    const o = orders.find((x) => x.id === id);
    if (!o) { setLines([{ productId: "", good: "", damaged: "", price: "" }]); setSupplier(""); return; }
    setSupplier(o.supplierName);
    setUnloadId(o.locationId);
    setLines(o.lines.filter((l) => !l.loose && l.quantity > l.receivedQty).map((l) => ({ productId: l.productId, good: String(l.quantity - l.receivedQty), damaged: "", price: "" })));
  };
  const onTruck = new Set(lines.filter((l) => l.productId).map((l) => l.productId));

  // Pre-orders waiting for this truck's rice, oldest first.
  const waiting = preorders.filter((o) => o.items.some((i) => i.productId && onTruck.has(i.productId))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const fromTruck = (o: PreOrder) => o.items.filter((i) => i.productId && onTruck.has(i.productId));
  const toCustomers = (pid: string) => waiting.filter((o) => given.has(o.id)).reduce((a, o) => a + o.items.filter((i) => i.productId === pid).reduce((b, i) => b + i.quantity, 0), 0);
  const onShelves = (pid: string) => Object.values(shelf[pid] ?? {}).reduce((a, v) => a + n(v), 0);
  const left = (l: Line) => n(l.good) - toCustomers(l.productId) - onShelves(l.productId);
  const restHere = (pid: string, locId: string) => {
    const l = lines.find((x) => x.productId === pid);
    if (!l) return;
    const others = Object.entries(shelf[pid] ?? {}).filter(([k]) => k !== locId).reduce((a, [, v]) => a + n(v), 0);
    const rest = Math.max(0, n(l.good) - toCustomers(pid) - others);
    setShelf({ ...shelf, [pid]: { ...(shelf[pid] ?? {}), [locId]: String(rest) } });
  };
  const allRestAt = (locId: string) => {
    const next = { ...shelf };
    for (const l of lines) {
      if (!l.productId) continue;
      const others = Object.entries(next[l.productId] ?? {}).filter(([k]) => k !== locId).reduce((a, [, v]) => a + n(v), 0);
      next[l.productId] = { ...(next[l.productId] ?? {}), [locId]: String(Math.max(0, n(l.good) - toCustomers(l.productId) - others)) };
    }
    setShelf(next);
  };

  const filled = lines.length > 0 && lines.every((l) => l.productId && n(l.good) + n(l.damaged) > 0);
  const balanced = filled && lines.every((l) => left(l) === 0);
  const sellLoc = locations.find((l) => l.id === sellId);
  const unloadLoc = locations.find((l) => l.id === unloadId);
  const stores = locations.filter((l) => l.type === "STORE");

  const sheet = (t: Truck): Slip => ({
    storeName: storeName || "SAM STORE", title: "TRUCK SHEET", reference: t.docNumber, when: new Date(t.createdAt).toLocaleString("en-PH"),
    lines: [
      { label: "Truck at", value: t.summary.unloadName },
      ...(t.summary.purchaseOrder ? [{ label: "Order", value: t.summary.purchaseOrder.docNumber }] : []),
      ...(t.summary.supplierName ? [{ label: "From", value: t.summary.supplierName }] : []),
    ],
    rows: [
      ...t.summary.lines.map((l) => ({ name: `${l.name}: came ${l.good}`, qty: "", note: [l.damaged ? `${l.damaged} damaged` : "", l.short ? `${l.short} short` : ""].filter(Boolean).join(" · ") || undefined })),
      ...t.summary.preorders.map((p) => ({ name: `To ${p.customerName} (${p.orderNumber})`, qty: p.items.map((i) => `${i.quantity}`).join("+") })),
      ...t.summary.shelves.map((s) => ({ name: `To ${s.name}`, qty: s.items.map((i) => `${i.quantity}`).join("+"), note: t.summary.lines.length > 1 ? s.items.map((i) => `${i.quantity} ${i.name}`).join(", ") : undefined })),
    ],
    totals: t.summary.lines.map((l) => ({ label: l.name, value: `${l.good} = ${l.toCustomers} customers + ${l.good - l.toCustomers} shelves`, strong: true })),
    signatures: [{ role: "Received by", name: "" }],
    footer: `Stock in: ${t.summary.stockIns.map((s) => s.docNumber).join(", ")}`,
  });

  const finish = async () => {
    if (!balanced || !sig || busy) return;
    setBusy(true); setError(null);
    const priceErr = await savePrices();
    if (priceErr) { setBusy(false); setError(priceErr); return; }
    const body = {
      locationId: sellId, unloadLocationId: unloadId, purchaseOrderId: po?.id, supplierName: po ? undefined : supplier.trim() || undefined,
      lines: lines.map((l) => ({ productId: l.productId, good: n(l.good), damaged: n(l.damaged) })),
      preorders: waiting.filter((o) => given.has(o.id)).map((o) => o.id),
      shelves: Object.entries(shelf).flatMap(([productId, m]) => Object.entries(m).filter(([, v]) => n(v) > 0).map(([locationId, v]) => ({ locationId, productId, quantity: n(v) }))),
      signatures: [{ signerKind: "STAFF", imagePng: sig }],
    };
    const r = await fetch(`${API_URL}/admin/truck`, { method: "POST", headers: { ...adminHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = (r ? await r.json().catch(() => null) : null) as ApiBody | null;
    setBusy(false);
    if (!r) { setError("No internet. A truck needs the internet to save; try again when it is back."); return; }
    if (!r.ok) { setError(errText(d, "Did not go through")); return; }
    const t: Truck = { id: String(d?.id), docNumber: String(d?.docNumber), createdAt: new Date().toISOString(), summary: d?.summary as unknown as Summary };
    toast(`Truck saved: ${t.docNumber}`);
    setDone(t); setPaid(new Set());
    startOver();
    void load();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** A handed-out pre-order paid in cash, exact amount (credit or change: the Pre-order screen). */
  const payCash = async (p: Summary["preorders"][number]) => {
    setBusy(true);
    const r = await fetch(`${API_URL}/admin/pos/preorders/${encodeURIComponent(p.orderId)}/finalize`, {
      method: "POST", headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethod: "cash", tenderedMinor: p.totalMinor, idempotencyKey: `truck-${p.orderId}` }),
    }).catch(() => null);
    const d = (r ? await r.json().catch(() => null) : null) as ApiBody | null;
    setBusy(false);
    if (!r?.ok) { toast(errText(d, "Did not go through"), "danger"); return; }
    setPaid((s) => new Set(s).add(p.orderId));
    toast(`${p.customerName} paid ${peso(p.totalMinor)}`);
  };

  if (!loaded) return <p className="text-muted" style={{ fontSize: 18 }}>Loading…</p>;

  return (
    <div className="truck-ui" style={{ fontSize: 18, maxWidth: 760 }}>
      <h1 className="h4 mb-1">Truck arrived</h1>
      <p className="text-muted mb-3">Count the truck once: what customers take from the truck, and what goes on each shelf.</p>
      {started && !done && (
        <div className="truck-draft d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
          <span><i className="bi bi-cloud-check me-1" aria-hidden="true"></i>Saved on this tablet. You can open other screens and come back.</span>
          <button type="button" className="btn btn-outline-danger" onClick={startOver}>Start over</button>
        </div>
      )}

      {done && (
        <div className="card mb-4 border-success">
          <div className="card-body">
            <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
              <strong className="text-success fs-5"><i className="bi bi-check-circle-fill me-1" aria-hidden="true"></i>Truck saved: {done.docNumber}</strong>
              <span className="d-flex gap-2">
                <button type="button" className="btn btn-dark btn-lg" onClick={() => printSlip(sheet(done))}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print truck sheet</button>
                <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setDone(null)}>Close</button>
              </span>
            </div>
            {done.summary.lines.map((l) => <div key={l.productId}>{l.name}: came <strong>{l.good}</strong> = customers {l.toCustomers} + shelves {l.good - l.toCustomers}{l.damaged ? ` · ${l.damaged} damaged (not paid)` : ""}</div>)}
            {done.summary.preorders.length > 0 && (<>
              <h2 className="h6 mt-3 mb-2">Collect payment for the orders given from the truck</h2>
              <div className="d-flex flex-column gap-2">
                {done.summary.preorders.map((p) => (
                  <div key={p.orderId} className="truck-pay d-flex flex-wrap align-items-center justify-content-between gap-2">
                    <div style={{ minWidth: 0 }}><strong>{p.customerName}</strong> · {p.items.map((i) => `${i.quantity} ${i.name}`).join(", ")}<div className="small text-muted">{p.orderNumber} · {peso(p.totalMinor)}</div></div>
                    {paid.has(p.orderId) ? <span className="badge text-bg-success fs-6">Paid</span> : (
                      <span className="d-flex gap-2">
                        <button type="button" className="btn btn-success" disabled={busy} onClick={() => void payCash(p)}>Paid cash {peso(p.totalMinor)}</button>
                        <button type="button" className="btn btn-outline-dark" onClick={() => onNavigate?.("preorders")}>Credit or other</button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>)}
          </div>
        </div>
      )}

      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {/* 1 What came */}
      <section className="card mb-3" aria-labelledby="tr-1">
        <div className="card-body">
          <h2 id="tr-1" className="h5 truck-step"><span className="truck-num">1</span>What came</h2>
          <label className="form-label fw-semibold" htmlFor="tr-po">Supplier order</label>
          <select id="tr-po" className="form-select form-select-lg mb-3" value={poId} onChange={(e) => pickOrder(e.target.value)}>
            <option value="">No order: type the rice myself</option>
            {orders.map((o) => <option key={o.id} value={o.id}>{o.docNumber} · {o.supplierName} · for {o.locationName}</option>)}
          </select>
          {!po && (<>
            <label className="form-label fw-semibold" htmlFor="tr-sup">Supplier (if any)</label>
            <input id="tr-sup" className="form-control form-control-lg mb-3" value={supplier} onChange={(e) => setSupplier(e.target.value.slice(0, 80))} />
          </>)}
          <div className="fw-semibold mb-1">The truck is at</div>
          <div className="truck-places mb-3" role="group" aria-label="The truck is at">
            {locations.map((l) => (
              <button key={l.id} type="button" className={`btn ${l.id === unloadId ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={l.id === unloadId} onClick={() => setUnloadId(l.id)}>
                {l.id === unloadId && <i className="bi bi-check-lg me-1" aria-hidden="true"></i>}{l.name}
              </button>
            ))}
          </div>
          {lines.map((l, i) => {
            const pl = po?.lines.find((x) => x.productId === l.productId);
            return (
              <div key={i} className="truck-line">
                {po ? <div className="fw-semibold truck-line-name">{nameOf(l.productId)}<div className="small text-muted fw-normal">{pl ? `${pl.quantity - pl.receivedQty} still to come on the order` : ""}</div></div> : (
                  <select className="form-select form-select-lg truck-line-name" aria-label={`Rice ${i + 1}`} value={l.productId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                    <option value="">Choose rice…</option>
                    {products.filter((p) => p.id === l.productId || !onTruck.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
                <label className="truck-field"><span>Good sacks</span>
                  <input className="form-control form-control-lg text-center" inputMode="numeric" value={l.good} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, good: whole(e.target.value) } : x)))} />
                </label>
                <label className="truck-field"><span>Damaged</span>
                  <input className="form-control form-control-lg text-center" inputMode="numeric" placeholder="0" value={l.damaged} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, damaged: whole(e.target.value) } : x)))} />
                </label>
                <label className="truck-field"><span>₱ selling price</span>
                  <input className="form-control form-control-lg text-center" inputMode="decimal" aria-label={`Selling price of ${nameOf(l.productId)} at ${sellLoc?.name ?? "the store"}`}
                    placeholder={cat[l.productId] ? String(cat[l.productId]!.priceMinor / 100) : ""} value={l.price}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, price: money(e.target.value) } : x)))} />
                  {l.productId && cat[l.productId] && cat[l.productId]!.floorMinor > 0 && priceOf(l) > 0 && priceOf(l) < cat[l.productId]!.floorMinor
                    ? <small className="text-danger fw-semibold">Below cost</small>
                    : priceChanged(l) ? <small className="text-primary fw-semibold">New price</small> : null}
                </label>
                {!po && <button type="button" className="btn btn-link text-danger truck-remove" aria-label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}><i className="bi bi-trash3" aria-hidden="true"></i></button>}
              </div>
            );
          })}
          {!po && <button type="button" className="btn btn-outline-dark btn-lg" onClick={() => setLines([...lines, { productId: "", good: "", damaged: "", price: "" }])}>+ Add rice</button>}
          {po && <p className="small text-muted mb-0 mt-2">Change the numbers to what really came. Damaged sacks are not paid to the supplier.</p>}
          <p className="small text-muted mb-0 mt-2">Selling price = the price at <strong>{sellLoc?.name ?? "the store"}</strong>. Type a new one and it becomes that store&apos;s price when you save. The cost comes from the supplier order or the product; only the owner changes costs (Products).</p>
        </div>
      </section>

      {filled && (<>
        {/* 2 Customers at the truck */}
        <section className="card mb-3" aria-labelledby="tr-2">
          <div className="card-body">
            <h2 id="tr-2" className="h5 truck-step"><span className="truck-num">2</span>Customers at the truck</h2>
            <div className="fw-semibold mb-1">Their orders become sales of</div>
            {homeId ? <p className="mb-2"><strong>{sellLoc?.name}</strong> (your store)</p> : (
              <div className="truck-places mb-2" role="group" aria-label="Their orders become sales of">
                {stores.map((l) => (
                  <button key={l.id} type="button" className={`btn ${l.id === sellId ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={l.id === sellId} onClick={() => setSellId(l.id)}>
                    {l.id === sellId && <i className="bi bi-check-lg me-1" aria-hidden="true"></i>}{l.name}
                  </button>
                ))}
              </div>
            )}
            {newOpen ? (
              <div className="truck-new mb-3">
                <div className="fw-semibold mb-2">New order at the truck · sale of {sellLoc?.name}</div>
                <label className="form-label" htmlFor="tr-cust">Customer</label>
                <select id="tr-cust" className="form-select form-select-lg mb-2" value={newCust} onChange={(e) => setNewCust(e.target.value)}>
                  <option value="">New customer (type the name)</option>
                  {(custs ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {!newCust && <input className="form-control form-control-lg mb-2" placeholder="Customer name" aria-label="New customer name" value={newName} onChange={(e) => setNewName(e.target.value.slice(0, 80))} />}
                {lines.filter((l) => l.productId).map((l) => (
                  <div key={l.productId} className="truck-new-line">
                    <span style={{ minWidth: 0 }}><strong>{nameOf(l.productId)}</strong><span className="d-block small text-muted">{peso(priceOf(l))} each</span></span>
                    <label className="truck-field"><span>Sacks</span>
                      <input className="form-control form-control-lg text-center" inputMode="numeric" placeholder="0" value={newQty[l.productId] ?? ""} onChange={(e) => setNewQty({ ...newQty, [l.productId]: whole(e.target.value) })} />
                    </label>
                  </div>
                ))}
                {newItems.length > 0 && <div className="mt-2">Total: <strong>{peso(newItems.reduce((a, it) => a + it.quantity * priceOf(lines.find((l) => l.productId === it.productId)!), 0))}</strong></div>}
                <div className="d-flex flex-wrap gap-2 mt-3">
                  <button type="button" className="btn btn-success btn-lg" disabled={!newReady || busy} onClick={() => void saveNew()}>{busy ? "Please wait…" : "Save order and give from truck"}</button>
                  <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setNewOpen(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="d-flex flex-wrap gap-2 mb-3">
                <button type="button" className="btn btn-outline-success btn-lg" onClick={openNew}><i className="bi bi-person-plus me-1" aria-hidden="true"></i>New order at the truck</button>
                {onNavigate && <button type="button" className="btn btn-link btn-lg" onClick={() => onNavigate("preorders")}>Open Pre-order screen</button>}
              </div>
            )}
            {waiting.length === 0 ? <p className="text-muted mb-0">No pre-orders are waiting for this rice.</p> : (<>
              <p className="small text-muted">Tap each customer who takes their rice from the truck now. You collect the payment after you finish.</p>
              <div className="truck-given mb-2" aria-live="polite">Given from the truck: <strong>{given.size} {given.size === 1 ? "customer" : "customers"}</strong>{lines.filter((l) => l.productId && toCustomers(l.productId) > 0).map((l) => ` · ${toCustomers(l.productId)} ${nameOf(l.productId)}`).join("")}</div>
              <div className="d-flex flex-column gap-2">
                {waiting.map((o) => {
                  const on = given.has(o.id);
                  return (
                    <button key={o.id} type="button" className={`truck-cust btn text-start ${on ? "btn-success" : "btn-outline-dark"}`} aria-pressed={on}
                      onClick={() => setGiven((s) => { const x = new Set(s); if (x.has(o.id)) x.delete(o.id); else x.add(o.id); return x; })}>
                      <i className={`bi ${on ? "bi-check-square-fill" : "bi-square"} fs-4`} aria-hidden="true"></i>
                      <span style={{ minWidth: 0 }}>
                        <strong>{o.customerName}</strong> · {fromTruck(o).map((i) => sacks(i.quantity)).join(" + ")}
                        <span className="d-block small">{o.orderNumber}{o.locationName ? ` · ${o.locationName}` : ""}{o.locationId && o.locationId !== sellId ? ` → becomes ${sellLoc?.name ?? ""}'s` : ""}</span>
                      </span>
                      <span className="ms-auto text-nowrap">{on ? "Given" : "Not yet"}</span>
                    </button>
                  );
                })}
              </div>
            </>)}
          </div>
        </section>

        {/* 3 The rest on shelves */}
        <section className="card mb-3" aria-labelledby="tr-3">
          <div className="card-body">
            <h2 id="tr-3" className="h5 truck-step"><span className="truck-num">3</span>Put the rest on shelves</h2>
            {unloadLoc && <button type="button" className="btn btn-outline-primary btn-lg mb-3" onClick={() => allRestAt(unloadLoc.id)}>Put all the rest at {unloadLoc.name}</button>}
            {lines.filter((l) => l.productId).map((l) => {
              const rest = left(l);
              return (
                <div key={l.productId} className="truck-shelf mb-3">
                  <div className="d-flex flex-wrap justify-content-between align-items-baseline gap-2 mb-2">
                    <strong>{nameOf(l.productId)}</strong>
                    <span className={`truck-left ${rest === 0 ? "ok" : "warn"}`} aria-live="polite">
                      {rest === 0 ? <><i className="bi bi-check-circle-fill me-1" aria-hidden="true"></i>Left on truck: 0</> : rest > 0 ? `Left on truck: ${rest}` : `${-rest} too many`}
                    </span>
                  </div>
                  <div className="small text-muted mb-2">Came {n(l.good)} · to customers {toCustomers(l.productId)}</div>
                  <div className="truck-shelf-grid">
                    {locations.map((loc) => (
                      <div key={loc.id} className="truck-shelf-cell">
                        <label className="truck-field"><span>{loc.name}</span>
                          <input className="form-control form-control-lg text-center" inputMode="numeric" placeholder="0" value={shelf[l.productId]?.[loc.id] ?? ""}
                            onChange={(e) => setShelf({ ...shelf, [l.productId]: { ...(shelf[l.productId] ?? {}), [loc.id]: whole(e.target.value) } })} />
                        </label>
                        {rest > 0 && <button type="button" className="btn btn-link btn-sm p-0" onClick={() => restHere(l.productId, loc.id)}>+ the rest here</button>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 4 Sign and finish */}
        <section className="card mb-4" aria-labelledby="tr-4">
          <div className="card-body">
            <h2 id="tr-4" className="h5 truck-step"><span className="truck-num">4</span>Sign and finish</h2>
            <div className="fw-semibold">Signature of the receiver</div>
            <SignaturePad key={sigKey} onSignature={setSig} />
            {!balanced && <div className="truck-left warn mt-2">Every sack needs a place: make "Left on truck" 0 for each rice.</div>}
            <button type="button" className="btn btn-success btn-lg w-100 mt-3" disabled={!balanced || !sig || busy} onClick={() => void finish()}>
              {busy ? "Please wait…" : "Finish truck"}
            </button>
          </div>
        </section>
      </>)}

      <h2 className="h5">Recent trucks</h2>
      {trucks.length === 0 ? <p className="text-muted">None yet.</p> : (
        <div className="list-group">
          {trucks.map((t) => (
            <div key={t.id} className="list-group-item d-flex justify-content-between align-items-center gap-2">
              <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                <div className="fw-semibold">{t.docNumber}{t.summary.supplierName ? ` · ${t.summary.supplierName}` : ""}</div>
                <div className="small text-muted">{t.summary.lines.map((l) => `${l.good} ${l.name}`).join(", ")} · {new Date(t.createdAt).toLocaleString("en-PH")}</div>
              </div>
              <button type="button" className="btn btn-outline-dark text-nowrap flex-shrink-0" onClick={() => printSlip(sheet(t))}><i className="bi bi-printer me-1" aria-hidden="true"></i>Sheet</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
