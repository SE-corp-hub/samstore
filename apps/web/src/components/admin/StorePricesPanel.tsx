"use client";

// Store prices — each store's own selling price for every rice. Per-store build, step 7.
// The owner side may set any price and the lowest price a store head may go down to.
// The head of a store may change that store's prices, never under the lowest price. The server
// checks every rule again; this screen only makes them easy to follow.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { askConfirm } from "../../lib/ask";
import { cleanTyping, peso, pesosToMinor } from "../../lib/number-format";
import StoreBar, { type StoreOption } from "./StoreBar";

interface Row {
  productId: string; name: string; sku: string;
  mainPriceMinor: number; locationPriceMinor: number | null; effectivePriceMinor: number;
  costMinor?: number; floorPriceMinor?: number | null; lowestPriceMinor?: number;
}
interface Answer { prices: Row[]; canEdit?: boolean; canSetLowest?: boolean }
type Editing = { productId: string; kind: "price" | "lowest" } | null;
const errOf = (d: unknown, fallback: string) => { const e = d as { errors?: string[]; message?: string } | null; return e?.errors?.[0] ?? e?.message ?? fallback; };

export default function StorePricesPanel() {
  const [places, setPlaces] = useState<StoreOption[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [find, setFind] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState("");
  const [rowError, setRowError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [me, locs] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      const active = ((locs?.warehouses ?? []) as (StoreOption & { isActive?: boolean })[]).filter((l) => l.isActive !== false && l.type === "STORE");
      setPlaces(active);
      setHome(me?.homeLocationId ?? null);
      setLocationId(me?.homeLocationId ?? active[0]?.id ?? "");
      if (!me?.homeLocationId && active.length === 0) setLoading(false);
    })().catch(() => { setError("Could not load the stores. Check the connection and open this screen again."); setLoading(false); });
  }, []);

  const load = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/warehouses/${encodeURIComponent(locationId)}/prices`, { headers: adminHeaders() });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setError(errOf(d, "Could not load the prices. Try again.")); return; }
      setData(d as Answer);
      setError(null);
    } catch {
      setError("No connection. Could not load the prices.");
    } finally {
      setLoading(false);
    }
  }, [locationId]);
  useEffect(() => { setData(null); setEditing(null); void load(); }, [load]);

  const storeName = places.find((l) => l.id === locationId)?.name ?? "this store";
  const rows = useMemo(() => {
    const q = find.trim().toLowerCase();
    return (data?.prices ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [data, find]);

  const open = (row: Row, kind: "price" | "lowest") => {
    setEditing({ productId: row.productId, kind });
    setRowError(null);
    const now = kind === "price" ? row.locationPriceMinor ?? row.effectivePriceMinor : row.floorPriceMinor ?? null;
    setDraft(now === null ? "" : (now / 100).toFixed(2));
  };

  const put = async (path: string, body: unknown, done: string) => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}${path}`, { method: "PUT", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setRowError(errOf(d, "Not saved. Try again.")); return; }
      toast(done);
      setEditing(null);
      await load();
    } catch {
      setRowError("No connection. Not saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  /** Would this selling price be refused (head) or need a second look (owner)? Returns false to stop. */
  const mayGo = async (row: Row, sellAt: number): Promise<boolean> => {
    if (!data?.canSetLowest) {
      if (typeof row.lowestPriceMinor === "number" && sellAt < row.lowestPriceMinor) {
        setRowError(`${peso(sellAt)} is under the lowest price for this rice (${peso(row.lowestPriceMinor)}). Ask the owner to go lower.`);
        return false;
      }
      return true;
    }
    if (typeof row.costMinor === "number" && row.costMinor > 0 && sellAt < row.costMinor) {
      return askConfirm(`${peso(sellAt)} is under the cost of ${row.name} (${peso(row.costMinor)}). Save it anyway?`, { ok: "Yes, save it", cancel: "No, go back" });
    }
    return true;
  };

  const savePrice = async (row: Row) => {
    setRowError(null);
    const minor = pesosToMinor(draft);
    if (!minor || minor <= 0) { setRowError("Type a price above ₱0."); return; }
    if (!(await mayGo(row, minor))) return;
    await put(`/admin/warehouses/${locationId}/prices/${row.productId}`, { priceMinor: minor }, `${row.name}: ${peso(minor)} at ${storeName}`);
  };
  const useMain = async (row: Row) => {
    setRowError(null);
    if (!(await mayGo(row, row.mainPriceMinor))) {
      // Show why, right at this rice, with its price ready to change instead.
      setEditing({ productId: row.productId, kind: "price" });
      setDraft(((row.locationPriceMinor ?? row.effectivePriceMinor) / 100).toFixed(2));
      return;
    }
    await put(`/admin/warehouses/${locationId}/prices/${row.productId}`, { priceMinor: null }, `${row.name}: back to the main price`);
  };
  const saveLowest = async (row: Row, clear = false) => {
    setRowError(null);
    const minor = clear ? null : pesosToMinor(draft);
    if (!clear && (!minor || minor <= 0)) { setRowError("Type the lowest price, or choose No lowest price."); return; }
    await put(`/admin/products/${row.productId}/lowest-price`, { floorPriceMinor: minor }, minor === null ? `${row.name}: no lowest price` : `${row.name}: lowest price ${peso(minor)}`);
  };

  const canEdit = !!data?.canEdit;
  const canSetLowest = !!data?.canSetLowest;

  return (
    <div className="prices-screen">
      <h1 className="h4 mb-1"><i className="bi bi-tags me-2" aria-hidden="true"></i>Store prices</h1>
      <p className="text-muted mb-3">
        {canSetLowest ? "Each store can sell at its own price. Set the lowest price a store head may go down to." : "Your store's own selling prices. You cannot go under the lowest price set by the owner."}
      </p>
      {places.length > 0 && <StoreBar label="Prices of" locations={places} value={locationId} homeLocationId={home} onPick={setLocationId} size="md" />}
      {error && <div className="alert alert-danger py-2" role="alert">{error} <button type="button" className="btn btn-outline-dark ms-2" onClick={load}>Try again</button></div>}
      {loading && !data && <p className="text-muted">Loading…</p>}

      {data && (
        <>
          <div className="mb-3" style={{ maxWidth: 420 }}>
            <label className="form-label fw-semibold mb-1" htmlFor="sp-find">Find a rice</label>
            <input id="sp-find" className="form-control form-control-lg" type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Type a name" autoComplete="off" />
          </div>
          {!canEdit && <div className="alert alert-secondary py-2">Only the owner or the head of this store can change these prices.</div>}
          {rows.length === 0 && <p className="text-muted">{find ? "No rice with that name." : "No rice yet."}</p>}
          <ul className="list-unstyled mb-0">
            {rows.map((row) => {
              const mine = editing?.productId === row.productId ? editing.kind : null;
              const own = row.locationPriceMinor !== null;
              return (
                <li key={row.productId} className="card mb-2">
                  <div className="card-body py-2">
                    <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
                      <div style={{ minWidth: 0, flex: "1 1 240px" }}>
                        <div className="fw-semibold text-break">{row.name}</div>
                        <div className="text-muted">
                          {own ? <>Main price {peso(row.mainPriceMinor)}</> : <>Uses the main price</>}
                          {typeof row.lowestPriceMinor === "number" && (canSetLowest
                            ? <> · Lowest price {row.floorPriceMinor != null ? peso(row.floorPriceMinor) : <>not set (the cost, {peso(row.lowestPriceMinor)})</>}</>
                            : <> · Lowest price {peso(row.lowestPriceMinor)}</>)}
                        </div>
                      </div>
                      <div className="fs-4 fw-bold text-nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>
                        <span className="visually-hidden">Price at {storeName}: </span>{peso(row.effectivePriceMinor)}
                      </div>
                      {canEdit && !mine && (
                        <div className="d-flex flex-wrap gap-2">
                          <button type="button" className="btn btn-outline-primary" style={{ minHeight: 48 }} onClick={() => open(row, "price")}><i className="bi bi-pencil me-1" aria-hidden="true"></i>Change price</button>
                          {own && <button type="button" className="btn btn-outline-secondary" style={{ minHeight: 48 }} disabled={saving} onClick={() => void useMain(row)}>Use main price</button>}
                          {canSetLowest && <button type="button" className="btn btn-outline-secondary" style={{ minHeight: 48 }} onClick={() => open(row, "lowest")}>Lowest price</button>}
                        </div>
                      )}
                    </div>
                    {mine && (
                      <form className="border-top mt-2 pt-2" onSubmit={(e) => { e.preventDefault(); void (mine === "price" ? savePrice(row) : saveLowest(row)); }}>
                        <label className="form-label fw-semibold mb-1" htmlFor={`sp-in-${row.productId}`}>
                          {mine === "price" ? `New price of ${row.name} at ${storeName} (₱)` : `Lowest price a store head may sell ${row.name} at (₱)`}
                        </label>
                        <div className="d-flex flex-wrap align-items-center gap-2">
                          <input
                            id={`sp-in-${row.productId}`} className={`form-control form-control-lg${rowError ? " is-invalid" : ""}`} style={{ maxWidth: 200 }}
                            inputMode="decimal" autoComplete="off" autoFocus value={draft} aria-describedby={rowError ? `sp-err-${row.productId}` : undefined}
                            onChange={(e) => { setDraft(cleanTyping(e.target.value, "peso")); setRowError(null); }}
                          />
                          <button type="submit" className="btn btn-success btn-lg" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                          {mine === "lowest" && row.floorPriceMinor != null && <button type="button" className="btn btn-outline-secondary btn-lg" disabled={saving} onClick={() => void saveLowest(row, true)}>No lowest price</button>}
                          <button type="button" className="btn btn-outline-dark btn-lg" disabled={saving} onClick={() => { setEditing(null); setRowError(null); }}>Cancel</button>
                        </div>
                        {mine === "lowest" && <div className="form-text">The same lowest price counts at every store. Leave it unset and a head cannot sell under the cost.</div>}
                        {rowError && <div id={`sp-err-${row.productId}`} className="text-danger fw-semibold mt-1" role="alert">{rowError}</div>}
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
