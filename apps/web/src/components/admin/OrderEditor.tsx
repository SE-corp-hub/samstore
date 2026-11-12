"use client";

// Orders → Change items: add products, take some off, change how many and the price of each.
// Works for every open order (shop link, SE Corp Hub, agent, POS hold, pre-order): the server picks the
// right stock rule (PATCH /admin/orders/:id/items). Same line look as Pre-order: − / + (48 px), "Price each"
// on the line, a reason when the price is not the usual one, and the below-cost popup before saving.

import { useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminRole } from "../../lib/admin";
import { savedThenFresh } from "../../lib/offlineCache";
import { peso } from "../../lib/number-format";
import { isBelowCost, okKey, seesCostRole } from "../../lib/below-cost";
import { PesoInput } from "../NumberBoxes";
import PriceReason, { reasonOk } from "./PriceReason";
import { askBelowCost, saveUnitCost } from "./BelowCostDialog";
import { toast } from "../../lib/toast";

interface Product { id: string; name: string; sku: string; priceMinor: number; availableQuantity?: number; category?: { name: string } | null }
interface Line {
  productId: string;
  name: string;
  /** The usual (list) price; null when the product is no longer sold. */
  listPrice: number | null;
  quantity: number;
  /** What is typed in the price box, kept while typing. */
  priceText?: string;
  /** Price each when it differs from the list price (centavos). */
  price?: number;
  reason?: string;
}
interface Floor { floorMinor: number; ownShelfCost: boolean; unit: string }

const unitOf = (l: Line) => l.price ?? l.listPrice ?? 0;
const changed = (l: Line) => l.price !== undefined && l.price !== l.listPrice;
const needsReason = (l: Line) => changed(l) && !reasonOk(l.reason);
const readJson = (res: Response) => res.json().catch(() => null);

export default function OrderEditor({ orderId, orderNumber, customerName, onClose, onSaved }: {
  orderId: string;
  orderNumber: string;
  customerName?: string;
  onClose: () => void;
  onSaved: (totalMinor: number) => void;
}) {
  const role = getAdminRole();
  const seesCost = seesCostRole(role);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [extraMinor, setExtraMinor] = useState(0); // delivery fee − discount: kept as they are
  const [products, setProducts] = useState<Product[]>([]);
  const [floors, setFloors] = useState<Map<string, Floor>>(new Map());
  // The order's own store and its own prices: the usual price of a line is its store's price, not the main one.
  const [storePrices, setStorePrices] = useState<Record<string, number>>({});
  const [storeName, setStoreName] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keptBelow = useRef(new Set<string>());
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { closeRef.current?.focus(); }, []);

  // The order as it is now, then the product list and costs (the copy saved on this tablet first).
  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/admin/orders/${orderId}`, { headers: adminHeaders() })
      .then(async (r) => (r.ok ? readJson(r) : Promise.reject(new Error((await readJson(r))?.message ?? "Could not open the order"))))
      .then((d) => {
        if (!alive) return;
        setExtraMinor((d?.deliveryFeeMinor ?? 0) - (d?.discountMinor ?? 0));
        setStorePrices(d?.storePrices && typeof d.storePrices === "object" ? d.storePrices as Record<string, number> : {});
        setStoreName(typeof d?.sellingLocationName === "string" ? d.sellingLocationName : null);
        setLines(((d?.items ?? []) as { productId: string | null; productName: string; quantity: number; unitPriceMinor: number; catalogUnitPriceMinor?: number | null; priceOverridden?: boolean; priceOverrideReason?: string | null }[])
          .filter((i) => i.productId)
          .map((i) => ({
            productId: i.productId!,
            name: i.productName,
            listPrice: null, // filled from the product list below
            quantity: i.quantity,
            price: i.unitPriceMinor,
            reason: i.priceOverrideReason ?? undefined,
          })));
      })
      .catch((e: Error) => alive && setError(e.message));
    void savedThenFresh<{ products?: Product[] }>("/admin/products", (p) => alive && setProducts(p?.products ?? []));
    void savedThenFresh<{ products?: { id: string; floorMinor?: number; ownShelfCost?: boolean; loose?: boolean; gramsPerUnit?: number | null }[] }>("/admin/benta/catalog", (cat) => {
      if (alive) setFloors(new Map((cat?.products ?? []).map((x) => [x.id, { floorMinor: x.floorMinor ?? 0, ownShelfCost: !!x.ownShelfCost, unit: x.loose ? "kilo" : x.gramsPerUnit ? "sack" : "piece" }])));
    });
    return () => { alive = false; };
  }, [orderId]);

  // Once both are in: each line learns its usual price; a line still at the usual price is "not changed".
  const priced = useMemo(() => products.map((p) => ({ ...p, priceMinor: storePrices[p.id] ?? p.priceMinor })), [products, storePrices]);
  const byId = useMemo(() => new Map(priced.map((p) => [p.id, p])), [priced]);
  useEffect(() => {
    if (!lines || products.length === 0 || lines.every((l) => l.listPrice !== null || !byId.has(l.productId))) return;
    setLines((cur) => cur && cur.map((l) => {
      const p = byId.get(l.productId);
      if (!p || l.listPrice !== null) return l;
      const same = l.price === undefined || l.price === p.priceMinor;
      return { ...l, listPrice: p.priceMinor, price: same ? undefined : l.price, reason: same ? undefined : l.reason };
    }));
  }, [byId, lines, products.length]);

  const change = (productId: string, patch: (l: Line) => Line | null) =>
    setLines((cur) => cur && cur.flatMap((l) => (l.productId === productId ? (patch(l) ? [patch(l)!] : []) : [l])));
  const setQty = (l: Line, qty: number) => change(l.productId, (x) => (qty <= 0 ? null : { ...x, quantity: Math.min(qty, 999) }));
  const setPrice = (l: Line, v: string) => {
    const m = v.trim() === "" ? undefined : Math.round(Number(v.replace(/,/g, "")) * 100);
    const same = m === undefined || !Number.isFinite(m) || m === l.listPrice;
    change(l.productId, (x) => ({ ...x, priceText: v, price: same ? undefined : m, reason: same ? undefined : x.reason }));
  };
  const add = (p: Product) => {
    setError(null);
    setLines((cur) => {
      const list = cur ?? [];
      return list.some((l) => l.productId === p.id)
        ? list.map((l) => (l.productId === p.id ? { ...l, quantity: Math.min(l.quantity + 1, 999) } : l))
        : [...list, { productId: p.id, name: p.name, listPrice: p.priceMinor, quantity: 1 }];
    });
  };

  const floorOf = (l: Line) => floors.get(l.productId)?.floorMinor ?? 0;
  const itemsTotal = (lines ?? []).reduce((s, l) => s + unitOf(l) * l.quantity, 0);
  const total = Math.max(0, itemsTotal + extraMinor);
  const count = (lines ?? []).reduce((s, l) => s + l.quantity, 0);
  const q = find.trim().toLowerCase();
  const matches = priced.filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.category?.name ?? "").toLowerCase().includes(q));

  /** Below cost: one popup per line before saving. False = stop (the person went back or is fixing a price). */
  const passesCost = async (): Promise<boolean> => {
    for (const l of lines ?? []) {
      let floor = floorOf(l);
      const unit = unitOf(l);
      while (isBelowCost(unit, floor) && !keptBelow.current.has(okKey(l.productId, unit, floor))) {
        const f = floors.get(l.productId);
        const pick = await askBelowCost({
          name: l.name, priceMinor: unit, costMinor: floor, unit: f?.unit, showCost: seesCost, proceed: "Save anyway",
          canChangeCost: !seesCost ? false : f?.ownShelfCost ? "This location has its own cost. Change it in Inventory." : true,
        });
        if (!pick) return false;
        if (pick.kind === "proceed") { keptBelow.current.add(okKey(l.productId, unit, floor)); break; }
        if (pick.kind === "price") {
          setPrice(l, (pick.priceMinor / 100).toFixed(2));
          if (pick.priceMinor !== l.listPrice) setError(`Pick a reason for the new price of ${l.name}, then save.`);
          else toast("Usual price set. Check it, then tap Save again.");
          return false;
        }
        const err = await saveUnitCost(l.productId, pick.costMinor);
        if (err) { setError(err); return false; }
        toast("Unit cost saved");
        floor = pick.costMinor;
        const saved = floor;
        setFloors((m) => new Map(m).set(l.productId, { floorMinor: saved, ownShelfCost: false, unit: m.get(l.productId)?.unit ?? "piece" }));
      }
    }
    return true;
  };

  const save = async () => {
    if (!lines) return;
    setError(null);
    if (lines.length === 0) { setError("Add at least one product. To drop the whole order, use Cancel order instead."); return; }
    const gone = lines.find((l) => !byId.has(l.productId) && products.length > 0);
    if (gone) { setError(`${gone.name} is no longer sold. Take it off the order (bin button), then save.`); return; }
    if (lines.some(needsReason)) { setError("Pick a reason for every price you changed."); return; }
    if (!(await passesCost())) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/admin/orders/${orderId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          items: lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            ...(changed(l) ? { unitPriceMinorOverride: l.price, priceOverrideReason: l.reason } : {}),
          })),
        }),
      });
      const d = await readJson(res);
      if (!res.ok) {
        setError(d?.message ?? (Array.isArray(d?.errors) ? d.errors.join(" ") : "Could not save the changes. Check the internet and try again."));
        return;
      }
      onSaved(typeof d?.totalMinor === "number" ? d.totalMinor : total);
    } catch {
      setError("No answer from the server. Check the internet and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="order-edit-title">
        <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable order-edit">
          <div className="modal-content">
            <div className="modal-header">
              <div className="min-w-0">
                <h2 className="modal-title fs-4 mb-0" id="order-edit-title">Change order {orderNumber}</h2>
                {customerName && <div className="text-muted text-truncate">{customerName}</div>}
                {storeName && <div className="fw-semibold text-truncate"><i className="bi bi-shop me-1" aria-hidden="true"></i>{storeName} prices</div>}
              </div>
              <button ref={closeRef} type="button" className="btn btn-outline-dark ms-auto order-edit-close" onClick={onClose} aria-label="Close without saving">
                <i className="bi bi-x-lg" aria-hidden="true"></i>
              </button>
            </div>
            <div className="modal-body">
              <h3 className="fs-5 fw-bold mb-2">In this order</h3>
              {lines === null && !error && <div className="text-muted py-3" role="status"><span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Opening the order…</div>}
              {lines !== null && lines.length === 0 && <p className="text-muted">No products yet. Add one below.</p>}
              {(lines ?? []).map((l) => {
                const isChanged = changed(l);
                const below = isBelowCost(unitOf(l), floorOf(l));
                const gone = products.length > 0 && !byId.has(l.productId);
                return (
                  <div key={l.productId} className="border-bottom py-2">
                    <div className="d-flex justify-content-between align-items-baseline gap-2">
                      <div className="fw-semibold">{l.name}</div>
                      <div className="fw-bold text-end text-nowrap num">{peso(unitOf(l) * l.quantity)}</div>
                    </div>
                    <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2">
                      <div className="d-flex align-items-center gap-1" role="group" aria-label={`How many ${l.name}`}>
                        <button type="button" className={`btn qty-btn ${l.quantity === 1 ? "btn-outline-danger" : "btn-outline-dark"}`}
                          aria-label={l.quantity === 1 ? `Take ${l.name} off the order` : `One less ${l.name}`} onClick={() => setQty(l, l.quantity - 1)}>
                          {l.quantity === 1 ? <i className="bi bi-trash" aria-hidden="true"></i> : "−"}
                        </button>
                        <span className="qty-num" aria-live="polite">{l.quantity}</span>
                        <button type="button" className="btn btn-outline-dark qty-btn" aria-label={`One more ${l.name}`} onClick={() => setQty(l, l.quantity + 1)}>+</button>
                      </div>
                      <label className="d-flex align-items-center gap-2 mb-0">
                        <span className="text-muted">Price each</span>
                        <PesoInput className={`form-control ${isChanged ? "border-warning bg-warning-subtle" : ""}`} style={{ width: "8.5rem" }} aria-label={`Price each of ${l.name}`}
                          value={l.priceText ?? (unitOf(l) / 100).toFixed(2)} placeholder={((l.listPrice ?? 0) / 100).toFixed(2)} onChange={(v) => setPrice(l, v)} />
                      </label>
                    </div>
                    {gone && <div className="text-danger fw-semibold mt-1" role="status">No longer sold: take it off to save.</div>}
                    {below && (
                      <div className="small text-danger fw-semibold mt-1" role="status">
                        <i className="bi bi-exclamation-triangle-fill me-1" aria-hidden="true"></i>
                        {seesCost ? `Below the unit cost of ${peso(floorOf(l))}` : "Below cost: check with the owner"}
                      </div>
                    )}
                    {isChanged && (
                      <div className="mt-2">
                        <div className="text-muted mb-1">Usual price {peso(l.listPrice ?? 0)}. Why the new price?</div>
                        <PriceReason className="form-select" invalid={needsReason(l)} value={reasonOk(l.reason) ? l.reason! : ""} onChange={(v) => change(l.productId, (x) => ({ ...x, reason: v }))} />
                      </div>
                    )}
                  </div>
                );
              })}

              <h3 className="fs-5 fw-bold mt-4 mb-2"><label htmlFor="order-edit-find" className="mb-0">Add a product</label></h3>
              <input id="order-edit-find" type="search" className="form-control form-control-lg mb-2" placeholder="Type a rice name…" value={find} onChange={(e) => setFind(e.target.value)} autoComplete="off" />
              <div className="order-edit-list" role="list">
                {matches.length === 0 && <p className="text-muted mb-0">{products.length === 0 ? "Loading products…" : "No product with that name."}</p>}
                {matches.map((p) => {
                  const inOrder = lines?.find((l) => l.productId === p.id)?.quantity ?? 0;
                  return (
                    <div role="listitem" key={p.id}>
                      <button type="button" className={`btn w-100 text-start d-flex align-items-center gap-2 order-edit-add ${inOrder ? "btn-outline-success" : "btn-outline-dark"}`} onClick={() => add(p)}>
                        <span className="flex-grow-1 min-w-0">
                          <span className="d-block fw-semibold text-truncate">{p.name}</span>
                          <span className="d-block text-muted small">{peso(p.priceMinor)}{inOrder ? ` · ${inOrder} in this order` : ""}</span>
                        </span>
                        <span className="fw-bold text-nowrap"><i className="bi bi-plus-lg me-1" aria-hidden="true"></i>Add</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="modal-footer d-block">
              {error && <div className="alert alert-danger py-2 mb-2" role="alert">{error}</div>}
              <div className="d-flex align-items-center gap-2 flex-wrap">
                <div className="me-auto">
                  <div className="text-muted">Total · {count} item{count === 1 ? "" : "s"}{extraMinor > 0 ? " · with delivery" : extraMinor < 0 ? " · less discount" : ""}</div>
                  <div className="fs-3 fw-bold num">{peso(total)}</div>
                </div>
                <button type="button" className="btn btn-outline-dark btn-lg" onClick={onClose} disabled={busy}>Cancel</button>
                <button type="button" className="btn btn-success btn-lg fw-bold" onClick={() => void save()} disabled={busy || lines === null}>
                  {busy ? <><span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Saving…</> : <><i className="bi bi-check-lg me-1" aria-hidden="true"></i>Save changes</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}
