"use client";

// "Selling below cost" — the one popup every screen shows when a selling price ends up under the
// unit cost (what the store pays). Three ways out, biggest first:
//   1. Fix the selling price   (type the new price right here)
//   2. Change the unit cost    (owner/manager; the cost on record was wrong or old)
//   3. Sell / save anyway      (a real clearance or a favour: allowed, never blocked)
// Go back (or Esc) changes nothing. Staff get the same popup without the peso cost and without
// option 2: they never see what rice costs.
//
//   const pick = await askBelowCost({ name, priceMinor, costMinor, showCost, canChangeCost, proceed: "Sell anyway" });
//   if (!pick) return;                         // went back
//   if (pick.kind === "price") use(pick.priceMinor);
//   if (pick.kind === "cost") await saveUnitCost(id, pick.costMinor);

import { useEffect, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { openDialog } from "../../lib/ask";
import { isBelowCost, lossEach, pesoToMinor } from "../../lib/below-cost";
import { peso } from "../../lib/number-format";
import { PesoInput } from "../NumberBoxes";
import { toast } from "../../lib/toast";

export interface BelowCostAsk {
  name: string;
  priceMinor: number;
  costMinor: number;
  /** "kilo" for loose rice; default "piece". Prices and costs are per this unit. */
  unit?: string;
  /** Owner/manager: show the peso cost and the loss. Staff: words only. */
  showCost: boolean;
  /** true = offer "Change unit cost"; a string = show it switched off with this reason; false = leave it out. */
  canChangeCost: boolean | string;
  /** Like canChangeCost, for "Fix selling price". Default true. */
  canChangePrice?: boolean | string;
  /** The "go ahead" button: "Sell anyway", "Save anyway"… */
  proceed: string;
  /** Which number was just typed: a new cost (stock in) words the title the other way round. */
  trigger?: "price" | "cost";
}

export type BelowCostChoice = { kind: "price"; priceMinor: number } | { kind: "cost"; costMinor: number } | { kind: "proceed" } | null;

const toText = (minor: number) => (minor > 0 ? (minor / 100).toFixed(2) : "");

function WarnIcon() {
  return (
    <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function Dialog({ ask, onDone }: { ask: BelowCostAsk; onDone: (v: BelowCostChoice) => void }) {
  const [mode, setMode] = useState<"choose" | "price" | "cost">("choose");
  const [price, setPrice] = useState(ask.showCost ? toText(ask.costMinor) : "");
  const [cost, setCost] = useState(toText(ask.costMinor));
  const firstRef = useRef<HTMLButtonElement>(null);
  const inputWrap = useRef<HTMLDivElement>(null);
  const unit = ask.unit ?? "piece";
  const per = unit === "kilo" ? "/kg" : "";
  const canPrice = ask.canChangePrice ?? true;

  useEffect(() => {
    if (mode === "choose") firstRef.current?.focus();
    else inputWrap.current?.querySelector("input")?.focus();
  }, [mode]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const newPrice = pesoToMinor(price);
  const newCost = pesoToMinor(cost);
  const title = ask.trigger === "cost" ? "Cost is higher than the selling price" : "Selling below cost";

  return (
    <>
      <div className="modal d-block" tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="bc-title" aria-describedby="bc-what" style={{ zIndex: 1080 }}>
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content rice-ui">
            <div className="modal-body">
              <h2 id="bc-title" className="h5 d-flex align-items-center gap-2 text-danger mb-2"><WarnIcon />{title}</h2>
              <p className="fs-5 fw-semibold mb-2">{ask.name}</p>
              <div id="bc-what">
                {ask.showCost ? (
                  <>
                    <dl className="row g-0 mb-2 fs-5">
                      <dt className="col-7 fw-normal">Selling price</dt><dd className="col-5 text-end mb-1 fw-semibold">{peso(ask.priceMinor)}{per}</dd>
                      <dt className="col-7 fw-normal">Unit cost (what you pay)</dt><dd className="col-5 text-end mb-1 fw-semibold">{peso(ask.costMinor)}{per}</dd>
                    </dl>
                    <p className="alert alert-danger py-2 mb-3">You lose <strong>{peso(lossEach(ask.priceMinor, ask.costMinor))}</strong> on each {unit}.</p>
                  </>
                ) : (
                  <p className="alert alert-danger py-2 mb-3">This price is less than what the store paid for it. Check with the owner before you sell at this price.</p>
                )}
              </div>

              {mode === "choose" && (
                <div className="d-grid gap-2">
                  {canPrice !== false && (
                    <>
                      <button ref={canPrice === true ? firstRef : undefined} type="button" className="btn btn-lg btn-primary" disabled={typeof canPrice === "string"} aria-describedby={typeof canPrice === "string" ? "bc-price-why" : undefined} onClick={() => setMode("price")}>Fix selling price</button>
                      {typeof canPrice === "string" && <small id="bc-price-why" className="text-muted text-center">{canPrice}</small>}
                    </>
                  )}
                  {ask.canChangeCost !== false && (
                    <>
                      <button ref={canPrice === true ? undefined : firstRef} type="button" className="btn btn-lg btn-outline-dark" disabled={typeof ask.canChangeCost === "string"} aria-describedby={typeof ask.canChangeCost === "string" ? "bc-cost-why" : undefined} onClick={() => setMode("cost")}>Change unit cost</button>
                      {typeof ask.canChangeCost === "string" && <small id="bc-cost-why" className="text-muted text-center">{ask.canChangeCost}</small>}
                    </>
                  )}
                  <button type="button" className="btn btn-lg btn-outline-danger" onClick={() => onDone({ kind: "proceed" })}>{ask.proceed}</button>
                  <button type="button" className="btn btn-lg btn-outline-secondary" onClick={() => onDone(null)}>Go back</button>
                </div>
              )}

              {mode === "price" && (
                <form onSubmit={(e) => { e.preventDefault(); if (newPrice && newPrice > 0) onDone({ kind: "price", priceMinor: newPrice }); }}>
                  <div ref={inputWrap}>
                    <label className="form-label fw-semibold" htmlFor="bc-price">New selling price (₱{per})</label>
                    <PesoInput id="bc-price" className="form-control form-control-lg" value={price} onChange={setPrice} placeholder="0.00" aria-describedby="bc-price-help" />
                  </div>
                  <div id="bc-price-help" className="small mt-1 mb-3" aria-live="polite">
                    {newPrice && isBelowCost(newPrice, ask.costMinor)
                      ? <span className="text-danger fw-semibold">Still below cost.</span>
                      : ask.showCost ? <span className="text-muted">{peso(ask.costMinor)}{per} or more covers the cost.</span> : null}
                  </div>
                  <div className="d-flex gap-2">
                    <button type="button" className="btn btn-lg btn-outline-secondary flex-fill" onClick={() => setMode("choose")}>Back</button>
                    <button type="submit" className="btn btn-lg btn-primary flex-fill" disabled={!newPrice || newPrice <= 0}>Use this price</button>
                  </div>
                </form>
              )}

              {mode === "cost" && (
                <form onSubmit={(e) => { e.preventDefault(); if (newCost !== null && newCost >= 0) onDone({ kind: "cost", costMinor: newCost }); }}>
                  <div ref={inputWrap}>
                    <label className="form-label fw-semibold" htmlFor="bc-cost">Unit cost (₱{per})</label>
                    <PesoInput id="bc-cost" className="form-control form-control-lg" value={cost} onChange={setCost} placeholder="0.00" aria-describedby="bc-cost-help" />
                  </div>
                  <div id="bc-cost-help" className="small mt-1 mb-3" aria-live="polite">
                    {newCost !== null && isBelowCost(ask.priceMinor, newCost)
                      ? <span className="text-danger fw-semibold">Still above the selling price of {peso(ask.priceMinor)}{per}.</span>
                      : <span className="text-muted">What the store really pays for one {unit}. Saved on the product.</span>}
                  </div>
                  <div className="d-flex gap-2">
                    <button type="button" className="btn btn-lg btn-outline-secondary flex-fill" onClick={() => setMode("choose")}>Back</button>
                    <button type="submit" className="btn btn-lg btn-primary flex-fill" disabled={newCost === null}>Save unit cost</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" style={{ zIndex: 1070 }} onClick={() => onDone(null)}></div>
    </>
  );
}

/** Shows the popup and resolves what the person chose; null = Go back. */
export function askBelowCost(ask: BelowCostAsk): Promise<BelowCostChoice> {
  if (typeof window === "undefined") return Promise.resolve(null);
  return openDialog<BelowCostChoice>((done) => <Dialog ask={ask} onDone={done} />);
}

async function patchProduct(productId: string, body: { costMinor?: number; priceMinor?: number }, what: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/admin/products/${productId}`, {
      method: "PATCH", headers: { ...adminHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const d = (await res.json().catch(() => null)) as { message?: string; errors?: string[] } | null;
    return d?.errors?.join(", ") ?? d?.message ?? `Could not save the ${what}`;
  } catch {
    return `Could not save the ${what} — check the internet`;
  }
}

/** Saves a new unit cost on the product (owner/manager). Returns an error text, or null when saved. */
export const saveUnitCost = (productId: string, costMinor: number) => patchProduct(productId, { costMinor }, "unit cost");

/** Saves a new main selling price on the product (owner/manager). Returns an error text, or null when saved. */
export const saveSellingPrice = (productId: string, priceMinor: number) => patchProduct(productId, { priceMinor }, "selling price");

export interface CostLine { productId: string; name: string; priceMinor: number; costMinor: number; unit?: string }

/**
 * Stock in, purchases and supplier orders: a new cost above the selling price is asked about line by
 * line. "Fix selling price" saves the product's new price right away; "Change unit cost" returns the
 * corrected cost for the caller to use. Resolves the lines to go on with, or null when someone went back.
 */
export async function checkNewCosts(lines: CostLine[], o: { canChangePrice: boolean | string; proceed: string }): Promise<CostLine[] | null> {
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    const l = out[i]!;
    if (!isBelowCost(l.priceMinor, l.costMinor)) continue;
    const pick = await askBelowCost({ trigger: "cost", name: l.name, priceMinor: l.priceMinor, costMinor: l.costMinor, unit: l.unit, showCost: true, canChangeCost: true, canChangePrice: o.canChangePrice, proceed: o.proceed });
    if (!pick) return null;
    if (pick.kind === "cost") out[i] = { ...l, costMinor: pick.costMinor };
    if (pick.kind === "price") {
      const err = await saveSellingPrice(l.productId, pick.priceMinor);
      if (err) { toast(err); return null; }
      toast(`New selling price for ${l.name}: ${peso(pick.priceMinor)}`);
      out[i] = { ...l, priceMinor: pick.priceMinor };
    }
  }
  return out;
}
