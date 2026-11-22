"use client";

import ProductPhoto from "./ProductPhoto";
import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, isStoreLogin, roleCan } from "../../lib/admin";
import { cachedGet } from "../../lib/offlineCache";
import { kg, peso } from "../../lib/number-format";
import { adjustUnits, isLooseItem, unitsText } from "../../lib/stock-units";
import { sizeButtons, sizeOf, sortGroups } from "../../lib/product-find";

interface InvItem {
  photoKey?: string | null;
  id: string; name: string; sku: string; category: string | null;
  quantityOnHand: number; quantityReserved: number; availableQuantity: number;
  reorderThreshold: number; costMinor: number; valueMinor: number; status: "in" | "low" | "out";
  trackStock?: boolean;
  /** The stores (location ids) where this rice is low against that store's own reorder level. */
  lowAt?: (string | null)[];
  stockBaseUnit: string | null; stockBaseQuantity: number | null;
  stockConversionFamily: string | null;
  stockLevels: { warehouseId: string | null; quantityOnHand: number; quantityReserved: number; reorderThreshold?: number }[];
  variants: { id: string; name: string; sku: string; costMinor: number; stockBaseQuantity: number | null; quantityOnHand: number; quantityReserved: number; availableQuantity: number; isActive: boolean }[];
}
interface Warehouse { id: string; name: string; isDefault: boolean; code?: string | null; type?: string; isActive?: boolean }
interface ConversionOption {
  key: string;
  productId: string;
  variantId?: string;
  label: string;
  sku: string;
  baseUnit: string;
  baseQuantity: number;
  conversionFamily: string;
  available: number;
}

const toPesos = (m: number) => peso(m);
const formatBaseQty = (qty: number, unit: string) => {
  if ((unit === "g" || unit === "ml") && qty % 1000 === 0) return `${qty / 1000} ${unit === "g" ? "kg" : "L"}`;
  return `${qty} ${unit}`;
};

const SHOW_CONVERT = false;
/** Plain words for the stock badge. */
const STATUS_WORD: Record<InvItem["status"], string> = { in: "In stock", low: "Low", out: "Sold out" };
/** Loose rice is kept in grams (1 g per unit): show it in kilos, like everywhere else in the app. */
const qtyText = (r: Pick<InvItem, "stockBaseUnit" | "stockBaseQuantity">, q: number) => (isLooseItem(r) ? kg(q) : String(q));
/** The number alone, for the big digits on the stock board (kilos for loose rice, the word sits in the row). */
const bigNum = (r: Pick<InvItem, "stockBaseUnit" | "stockBaseQuantity">, q: number) => (isLooseItem(r) ? kg(q).replace(/ kg$/, "") : String(q));
/** What the numbers count: kilos for loose rice, sacks for 10 kg and up, packs for smaller bags. */
const unitWord = (r: Pick<InvItem, "name" | "stockBaseUnit" | "stockBaseQuantity">) => {
  if (isLooseItem(r)) return "kilos";
  const s = sizeOf(r.name);
  if (!s) return "";
  return parseFloat(s) >= 10 ? "sacks" : "packs";
};
/** The same store colours as Orders (easy-read.css §21), so a store looks the same everywhere. */
const STORE_TONES = ["store-tone-1", "store-tone-2", "store-tone-3", "store-tone-4", "store-tone-5"];

export default function InventoryPanel({ role = "" }: { role?: string }) {
  const walled = isStoreLogin(role);
  // Changing a number by hand is for the owner and managers (the server refuses everyone else): staff use Stock in and Count.
  const canChange = roleCan(role, "profit");
  const [items, setItems] = useState<InvItem[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [totalValue, setTotalValue] = useState(0);
  const hasCost = items.length === 0 || typeof items[0]!.costMinor === "number";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  // A login tied to one store opens on its own store (it can still look at the others' sack counts).
  const [homeId, setHomeId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void cachedGet<{ homeLocationId?: string | null }>("/admin/me/rice").then((me) => {
      if (me?.homeLocationId) { setHomeId(me.homeLocationId); setWarehouseId(me.homeLocationId); }
    }).finally(() => setReady(true));
  }, []);
  // Filters on the board are done here (counts for every tile come from one list).
  const [statusPick, setStatusPick] = useState<"" | "out" | "low" | "in">("");
  const [sizePick, setSizePick] = useState("");
  const [sort, setSort] = useState<"group" | "name" | "fewest">("group");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (search) q.set("search", search);
      if (warehouseId) q.set("warehouseId", warehouseId);
      const res = await fetch(`${API_URL}/admin/inventory?${q.toString()}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load inventory");
      const data = await res.json();
      setItems(data.items ?? []);
      setError(null);
      setWarehouses(data.warehouses ?? []);
      setTotalValue(data.totalValueMinor ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [search, warehouseId]);

  useEffect(() => { if (!ready) return; const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load, ready]);

  // ── M2: reasoned adjustments + the ledger views ──
  const [view, setView] = useState<"stock" | "history">("stock");
  const [adjust, setAdjust] = useState<InvItem | null>(null);
  const [adjustMode, setAdjustMode] = useState<"delta" | "setTo">("delta");
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustAllowNegative, setAdjustAllowNegative] = useState(false);
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  // Which shelf Adjust changes: the location chosen in the filter, else the main store (asked in the dialog).
  const [adjustWh, setAdjustWh] = useState("");
  const shelfOf = (r: InvItem, wh: string) => r.stockLevels.find((l) => l.warehouseId === wh) ?? { quantityOnHand: 0, quantityReserved: 0, reorderThreshold: 0 };
  // The places stock can be changed at: open stores, Bodega and the Buffer (turned-off ones are left out).
  const places = warehouses.filter((w) => w.isActive !== false);
  const adjustPlace = places.find((w) => w.id === adjustWh) ?? null;
  const placeName = (id: string | null) => places.find((w) => w.id === id)?.name ?? "a store";
  /** The badge words: one store picked → its own reorder level; all stores → where it is low. */
  const statusText = (r: InvItem) => {
    if (r.status !== "low") return STATUS_WORD[r.status];
    if (warehouseId) return `${STATUS_WORD.low} (reorder at ${qtyText(r, r.reorderThreshold)})`;
    const at = (r.lowAt ?? []).map(placeName);
    return `${STATUS_WORD.low} at ${at.join(", ")}`;
  };
  // Each store's own reorder level, saved from the Adjust dialog.
  const [reorderAt, setReorderAt] = useState("");
  const [reorderBusy, setReorderBusy] = useState(false);
  const [reorderMsg, setReorderMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saveReorder = async () => {
    if (!adjust || !adjustWh) return;
    const level = reorderAt.trim() === "" ? 0 : adjustUnits(adjust, reorderAt);
    if (!Number.isFinite(level) || level < 0) { setReorderMsg({ ok: false, text: "Enter 0 or more" }); return; }
    setReorderBusy(true);
    try {
      const res = await fetch(`${API_URL}/admin/stock/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ productId: adjust.id, warehouseId: adjustWh, reorderThreshold: level }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setReorderMsg({ ok: false, text: d?.message ?? (Array.isArray(d?.errors) ? d.errors.join("; ") : "Could not save") }); return; }
      setReorderMsg({ ok: true, text: level > 0 ? `Saved. ${adjustPlace?.name ?? "This store"} shows Low at ${qtyText(adjust, level)} or less.` : `Saved. No low-stock alert at ${adjustPlace?.name ?? "this store"}.` });
      await load();
    } catch {
      setReorderMsg({ ok: false, text: "Could not save" });
    } finally {
      setReorderBusy(false);
    }
  };
  const [historyProduct, setHistoryProduct] = useState("");
  const [history, setHistory] = useState<{
    id: string; productName: string; sku: string | null; variantName?: string | null; variantSku?: string | null; delta: number; type: string;
    note: string | null; balanceAfter: number | null; actor: string | null; createdAt: string; conversionId?: string | null;
  }[]>([]);
  const [conversionOpen, setConversionOpen] = useState(false);
  const [conversionItems, setConversionItems] = useState<InvItem[]>([]);
  const [conversionWarehouses, setConversionWarehouses] = useState<Warehouse[]>([]);
  const [conversionWarehouseId, setConversionWarehouseId] = useState("__none__");
  const [sourceKey, setSourceKey] = useState("");
  const [destinationKey, setDestinationKey] = useState("");
  const [sourceQuantity, setSourceQuantity] = useState("1");
  const [outputQuantity, setOutputQuantity] = useState("");
  const [conversionReason, setConversionReason] = useState("");
  const [wasteReason, setWasteReason] = useState("");
  const [conversionIdempotencyKey, setConversionIdempotencyKey] = useState<string | null>(null);
  const [conversionBusy, setConversionBusy] = useState(false);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [conversionMessage, setConversionMessage] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    const q = new URLSearchParams({ limit: "100" });
    if (historyProduct) q.set("productId", historyProduct);
    const res = await fetch(`${API_URL}/admin/stock/movements?${q.toString()}`, { headers: adminHeaders() });
    if (res.ok) {
      const d = await res.json();
      setHistory(d.movements ?? []);
    }
  }, [historyProduct]);

  useEffect(() => { if (view === "history") void loadHistory(); }, [view, loadHistory]);

  const submitAdjust = async () => {
    if (!adjust) return;
    setAdjustBusy(true);
    setAdjustError(null);
    try {
      const qty = adjustUnits(adjust, adjustQty);
      if (!Number.isFinite(qty) || (adjustMode === "delta" && qty === 0) || (adjustMode === "setTo" && qty < 0)) { setAdjustError(isLooseItem(adjust) ? "Enter the kilos (e.g. 12.5)" : "Enter a whole number"); return; }
      if (!adjustWh) { setAdjustError("Choose the store"); return; }
      if (adjustReason.trim().length < 3) { setAdjustError("A reason is required (3+ characters) — it is stored on the ledger row"); return; }
      const body: Record<string, unknown> = {
        productId: adjust.id,
        warehouseId: adjustWh,
        reason: adjustReason.trim(),
        allowNegative: adjustAllowNegative,
      };
      if (adjustMode === "delta") body.delta = qty;
      else body.setTo = qty;
      const res = await fetch(`${API_URL}/admin/stock/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setAdjustError(d?.message ?? (Array.isArray(d?.errors) ? d.errors.join("; ") : "Adjustment failed"));
        return;
      }
      setAdjust(null); setAdjustQty(""); setAdjustReason(""); setAdjustAllowNegative(false);
      await load();
      if (view === "history") await loadHistory();
    } catch (e) {
      setAdjustError(e instanceof Error ? e.message : "Adjustment failed");
    } finally {
      setAdjustBusy(false);
    }
  };

  const openConversion = async () => {
    setConversionError(null);
    setConversionMessage(null);
    try {
      const res = await fetch(`${API_URL}/admin/inventory`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Could not load conversion stock items");
      const data = await res.json();
      const allWarehouses = (data.warehouses ?? []) as Warehouse[];
      setConversionItems((data.items ?? []) as InvItem[]);
      setConversionWarehouses(allWarehouses);
      setConversionWarehouseId(warehouseId || allWarehouses.find((w) => w.isDefault)?.id || allWarehouses[0]?.id || "__none__");
      setSourceKey("");
      setDestinationKey("");
      setSourceQuantity("1");
      setOutputQuantity("");
      setConversionReason("");
      setWasteReason("");
      setConversionIdempotencyKey(null);
      setConversionOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load conversion stock items");
    }
  };

  const conversionOptions: ConversionOption[] = conversionItems.flatMap((item) => {
    const productLevel = conversionWarehouseId === "__none__"
      ? item.stockLevels.find((level) => level.warehouseId === null)
      : item.stockLevels.find((level) => level.warehouseId === conversionWarehouseId);
    const options: ConversionOption[] = [];
    if (item.stockBaseUnit && item.stockBaseQuantity && item.stockConversionFamily) {
      options.push({
        key: `product:${item.id}`,
        productId: item.id,
        label: item.name,
        sku: item.sku,
        baseUnit: item.stockBaseUnit,
        baseQuantity: item.stockBaseQuantity,
        conversionFamily: item.stockConversionFamily,
        available: (productLevel?.quantityOnHand ?? 0) - (productLevel?.quantityReserved ?? 0),
      });
    }
    for (const variant of item.variants ?? []) {
      const baseQuantity = variant.stockBaseQuantity ?? item.stockBaseQuantity;
      if (!item.stockBaseUnit || !item.stockConversionFamily || !baseQuantity || !variant.isActive) continue;
      options.push({
        key: `variant:${variant.id}`,
        productId: item.id,
        variantId: variant.id,
        label: `${item.name} — ${variant.name}`,
        sku: variant.sku,
        baseUnit: item.stockBaseUnit,
        baseQuantity,
        conversionFamily: item.stockConversionFamily,
        available: variant.availableQuantity,
      });
    }
    return options;
  });

  const sourceOption = conversionOptions.find((item) => item.key === sourceKey);
  const destinationOption = conversionOptions.find((item) => item.key === destinationKey);
  const sourceQtyNumber = Number.parseInt(sourceQuantity, 10);
  const outputQtyNumber = Number.parseInt(outputQuantity, 10);
  const maxOutputQuantity = sourceOption && destinationOption
    && sourceOption.baseUnit === destinationOption.baseUnit
    && Number.isInteger(sourceQtyNumber) && sourceQtyNumber > 0
    ? Math.floor((sourceQtyNumber * sourceOption.baseQuantity) / destinationOption.baseQuantity)
    : 0;
  const wasteBaseQuantity = sourceOption && destinationOption
    && Number.isInteger(sourceQtyNumber) && sourceQtyNumber > 0
    && Number.isInteger(outputQtyNumber) && outputQtyNumber > 0
    ? sourceQtyNumber * sourceOption.baseQuantity - outputQtyNumber * destinationOption.baseQuantity
    : 0;

  const submitConversion = async () => {
    if (!sourceOption || !destinationOption) { setConversionError("Choose both a source and an output item"); return; }
    if (sourceKey === destinationKey) { setConversionError("Source and output must be different stock items"); return; }
    if (!Number.isInteger(sourceQtyNumber) || sourceQtyNumber < 1 || sourceQtyNumber > sourceOption.available) {
      setConversionError(`Enter a source quantity from 1 to ${sourceOption.available} available`); return;
    }
    if (!Number.isInteger(outputQtyNumber) || outputQtyNumber < 1 || outputQtyNumber > maxOutputQuantity) {
      setConversionError(`Output quantity must be 1–${maxOutputQuantity} based on the pack contents`); return;
    }
    if (conversionReason.trim().length < 3) { setConversionError("A conversion reason is required (3+ characters)"); return; }
    if (wasteBaseQuantity > 0 && wasteReason.trim().length < 3) { setConversionError("Explain the leftover/waste (3+ characters)"); return; }

    setConversionBusy(true);
    setConversionError(null);
    const idempotencyKey = conversionIdempotencyKey ?? (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `convert-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setConversionIdempotencyKey(idempotencyKey);
    try {
      const res = await fetch(`${API_URL}/admin/stock/conversions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          idempotencyKey,
          sourceProductId: sourceOption.productId,
          sourceVariantId: sourceOption.variantId,
          destinationProductId: destinationOption.productId,
          destinationVariantId: destinationOption.variantId,
          warehouseId: conversionWarehouseId === "__none__" ? undefined : conversionWarehouseId,
          sourceQuantity: sourceQtyNumber,
          outputQuantity: outputQtyNumber,
          reason: conversionReason.trim(),
          wasteReason: wasteBaseQuantity > 0 ? wasteReason.trim() : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setConversionError(data?.message ?? (Array.isArray(data?.errors) ? data.errors.join("; ") : "Conversion failed"));
        return;
      }
      setConversionMessage(`Converted ${sourceQtyNumber} ${sourceOption.label} into ${outputQtyNumber} ${destinationOption.label}${wasteBaseQuantity > 0 ? ` · ${formatBaseQty(wasteBaseQuantity, sourceOption.baseUnit)} recorded as waste` : ""}.`);
      setConversionOpen(false);
      await load();
      if (view === "history") await loadHistory();
    } catch (e) {
      setConversionError(e instanceof Error ? e.message : "Conversion failed");
    } finally {
      setConversionBusy(false);
    }
  };

  // ── The stock board (2026-11-22): see every rice's stock at a glance ──
  const shown = places.filter((w) => !walled || w.id === homeId);
  const allStores = !warehouseId && shown.length > 1;
  const sizes = sizeButtons(items.map((r) => (isLooseItem(r) ? null : sizeOf(r.name))));
  const hasLoose = items.some(isLooseItem);
  const sized = items.filter((r) => !sizePick || (sizePick === "loose" ? isLooseItem(r) : !isLooseItem(r) && sizeOf(r.name) === sizePick));
  const counts = { all: sized.length, out: 0, low: 0, in: 0 };
  for (const r of sized) if (r.status === "out" || r.status === "low" || r.status === "in") counts[r.status] += 1;
  const picked = sized.filter((r) => !statusPick || r.status === statusPick);
  const fewest = (a: InvItem, b: InvItem) => a.availableQuantity - b.availableQuantity || a.name.localeCompare(b.name);
  const rows = [...picked].sort(sort === "fewest" ? fewest : (a, b) => a.name.localeCompare(b.name));
  const groups = sort === "group" ? sortGroups(rows.map((r) => r.category || "Other")) : [""];
  const colCount = 1 + (allStores ? shown.length + 1 : 1 + (hasCost ? 1 : 0)) + (canChange ? 1 : 0);
  const openAdjust = (r: InvItem) => {
    const wh = warehouseId || places.find((w) => w.isDefault)?.id || places[0]?.id || "";
    setAdjust(r); setAdjustWh(wh); setReorderAt(unitsText(r, shelfOf(r, wh).reorderThreshold ?? 0)); setReorderMsg(null);
    setAdjustMode("delta"); setAdjustQty(""); setAdjustReason(""); setAdjustAllowNegative(false); setAdjustError(null);
  };
  /** One number on the board: big digits, and the word "None" / "Low" beside it, so colour is never the only cue. */
  const numCell = (r: InvItem, free: number, low: boolean, label: string, key?: string, extra = "") => {
    if (r.trackStock === false) return <td key={key} className={`inv-num ${extra}`} data-label={label}><span className="inv-big">—</span></td>;
    const state = free <= 0 ? "is-none" : low ? "is-low" : "";
    return (
      <td key={key} className={`inv-num ${extra} ${state}`} data-label={label}>
        <span className="inv-big">{bigNum(r, free)}</span>
        {free <= 0 ? <span className="inv-flag">None</span> : low ? <span className="inv-flag">Low</span> : null}
      </td>
    );
  };
  const STATUS_TILES: { id: "" | "out" | "low" | "in"; word: string; icon: string; tone: string }[] = [
    { id: "", word: "All rice", icon: "bi-boxes", tone: "inv-tile-all" },
    { id: "out", word: "Sold out", icon: "bi-x-octagon", tone: "inv-tile-out" },
    { id: "low", word: "Low", icon: "bi-exclamation-triangle", tone: "inv-tile-low" },
    { id: "in", word: "Enough", icon: "bi-check-circle", tone: "inv-tile-in" },
  ];

  return (
    <div className="inv-board">
      {/* The top bar already says "Inventory": the heading stays for screen readers, and the store buttons and the
          Stock now / Stock flow switch share one row so more rice fit on the tablet sideways. */}
      <h1 className="visually-hidden">Inventory</h1>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      <div className="inv-top mb-2">
        {/* Which store's stock is on screen: one store, or every store side by side. */}
        <div className="inv-stores" role="group" aria-label="Which store">
          {!walled && (
            <button type="button" aria-pressed={warehouseId === ""} className={`btn store-chip store-chip-all ${warehouseId === "" ? "is-on" : ""}`} onClick={() => setWarehouseId("")}>
              All stores
            </button>
          )}
          {/* 2026-11-22: a store login sees its own store only (the server sends nothing else). */}
          {shown.map((w, i) => (
            <button key={w.id} type="button" aria-pressed={warehouseId === w.id} className={`btn store-chip ${STORE_TONES[i % STORE_TONES.length]} ${warehouseId === w.id ? "is-on" : ""}`} onClick={() => setWarehouseId(w.id)}>
              {w.name}{w.id === homeId ? " (yours)" : ""}
            </button>
          ))}
        </div>
        <div className="btn-group inv-view" role="group" aria-label="Inventory view">
          <button type="button" aria-pressed={view === "stock"} className={`btn ${view === "stock" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setView("stock")}>
            <i className="bi bi-boxes me-1" aria-hidden="true"></i>Stock now
          </button>
          <button type="button" aria-pressed={view === "history"} className={`btn ${view === "history" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setView("history")}>
            <i className="bi bi-clock-history me-1" aria-hidden="true"></i>Stock flow
          </button>
        </div>
      </div>

      {conversionMessage && <div className="alert alert-success py-2">{conversionMessage}</div>}

      {view === "history" ? (
        <div>
          <div className="row g-2 mb-2">
            <div className="col-md-5">
              <select className="form-select" aria-label="Product" value={historyProduct} onChange={(e) => setHistoryProduct(e.target.value)}>
                <option value="">All rice</option>
                {items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="col-md-3">
              <button type="button" className="btn btn-outline-primary" onClick={() => void loadHistory()}>
                <i className="bi bi-arrow-clockwise me-1" aria-hidden="true"></i>Refresh
              </button>
            </div>
          </div>
          {history.length === 0 ? (
            <p className="text-muted">No stock movements yet.</p>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm table-hover align-middle">
                <thead>
                  <tr>
                    <th>When</th><th>Product</th><th>Type</th>
                    <th className="text-end">Change</th><th className="text-end">Balance</th>
                    <th>Reason / note</th><th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((m) => (
                    <tr key={m.id}>
                      <td className="small text-muted">{new Date(m.createdAt).toLocaleString()}</td>
                      <td className="small">{m.productName}{m.variantName ? ` — ${m.variantName}` : ""}{(m.variantSku ?? m.sku) ? <span className="text-muted"> · {m.variantSku ?? m.sku}</span> : null}</td>
                      <td>
                        <span className="badge text-bg-secondary">{m.type}</span>
                        {m.conversionId && <small className="d-block text-muted" title={m.conversionId}>Conv. {m.conversionId.slice(0, 8)}</small>}
                      </td>
                      <td className={`text-end fw-semibold ${m.delta < 0 ? "text-danger" : "text-success"}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                      <td className="text-end">{m.balanceAfter ?? "—"}</td>
                      <td className="small">{m.note ?? "—"}</td>
                      <td className="small text-muted">{m.actor ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* At a glance: how many rice are sold out, low, or have enough. Tap one to see only those. */}
          <div className="inv-tiles mb-2" role="group" aria-label="Show rice by stock">
            {STATUS_TILES.map((t) => {
              const n = t.id === "" ? counts.all : counts[t.id];
              return (
                <button key={t.id || "all"} type="button" aria-pressed={statusPick === t.id} className={`inv-tile ${t.tone} ${statusPick === t.id ? "is-on" : ""}`} onClick={() => setStatusPick(t.id)}>
                  <span className="inv-tile-num">{loading && items.length === 0 ? "…" : n}</span>
                  <span className="inv-tile-word"><i className={`bi ${t.icon}`} aria-hidden="true"></i>{t.word}</span>
                </button>
              );
            })}
          </div>

          <div className="inv-tools mb-2">
            <input className="form-control inv-search" type="search" aria-label="Search rice" placeholder="Search rice…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {(sizes.length > 0 || hasLoose) && (
              <div className="inv-seg" role="group" aria-label="Size">
                {["", ...sizes, ...(hasLoose ? ["loose"] : [])].map((s) => (
                  <button key={s || "all"} type="button" aria-pressed={sizePick === s} className={`btn ${sizePick === s ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setSizePick(s)}>
                    {s === "" ? "All sizes" : s === "loose" ? "Per kilo" : s.replace("kg", " kg")}
                  </button>
                ))}
              </div>
            )}
            <div className="inv-seg" role="group" aria-label="Order">
              {([["group", "By group"], ["name", "A to Z"], ["fewest", "Fewest first"]] as const).map(([id, word]) => (
                <button key={id} type="button" aria-pressed={sort === id} className={`btn ${sort === id ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setSort(id)}>{word}</button>
              ))}
            </div>
          </div>

          {canChange && SHOW_CONVERT && (
            <button type="button" className="btn btn-outline-success mb-2" onClick={() => void openConversion()}>
              <i className="bi bi-arrow-left-right me-1" aria-hidden="true"></i>Convert stock
            </button>
          )}

          {loading && items.length === 0 ? (
            <p className="text-muted" role="status">Loading stock…</p>
          ) : rows.length === 0 ? (
            <div className="inv-empty" role="status">
              <p className="mb-2">No rice here.</p>
              {(statusPick || sizePick || search) && (
                <button type="button" className="btn btn-outline-primary" onClick={() => { setStatusPick(""); setSizePick(""); setSearch(""); }}>Show all rice</button>
              )}
            </div>
          ) : (
            <table className={`inv-table ${allStores ? "inv-all" : "inv-one"}`}>
              <caption className="visually-hidden">
                {allStores ? "Free to sell at each store" : `Free to sell at ${placeName(warehouseId || shown[0]?.id || null)}`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Rice</th>
                  {allStores ? (
                    <>
                      {shown.map((w) => <th key={w.id} scope="col" className="inv-num">{w.name}</th>)}
                      <th scope="col" className="inv-num inv-total">Total</th>
                    </>
                  ) : (
                    <>
                      <th scope="col" className="inv-num">Free to sell</th>
                      {hasCost && <th scope="col" className="inv-num inv-money">Value at cost</th>}
                    </>
                  )}
                  {canChange && <th scope="col"><span className="visually-hidden">Change</span></th>}
                </tr>
              </thead>
              {groups.map((g) => {
                const inGroup = sort === "group" ? rows.filter((r) => (r.category || "Other") === g) : rows;
                return (
                  <tbody key={g || "all"}>
                    {g && (
                      <tr className="inv-group">
                        <th scope="colgroup" colSpan={colCount}>{g} <span className="inv-group-n">{inGroup.length}</span></th>
                      </tr>
                    )}
                    {inGroup.map((r) => {
                      const loose = isLooseItem(r);
                      const size = loose ? "Per kilo" : sizeOf(r.name);
                      return (
                        <tr key={r.id} className={`inv-row inv-${r.status}`}>
                          <th scope="row" className="inv-name">
                            <span className="inv-name-in">
                              <ProductPhoto photoKey={r.photoKey} size="thumb" />
                              <span>
                                <span className="inv-rice">{r.name}</span>
                                <span className="inv-sub">
                                  {unitWord(r) && <span>in {unitWord(r)}</span>}
                                  {r.status === "out" && <span className="inv-badge inv-badge-out"><i className="bi bi-x-octagon" aria-hidden="true"></i>Sold out</span>}
                                  {r.status === "low" && !allStores && <span className="inv-badge inv-badge-low"><i className="bi bi-exclamation-triangle" aria-hidden="true"></i>{statusText(r)}</span>}
                                  {r.quantityReserved > 0 && <span>{qtyText(r, r.quantityReserved)} held for orders</span>}
                                  {!allStores && size && !unitWord(r) && <span>{size}</span>}
                                </span>
                              </span>
                            </span>
                          </th>
                          {allStores ? (
                            <>
                              {shown.map((w) => {
                                const sh = shelfOf(r, w.id);
                                return numCell(r, sh.quantityOnHand - sh.quantityReserved, (r.lowAt ?? []).includes(w.id), w.name, w.id);
                              })}
                              {numCell(r, r.availableQuantity, false, "Total", "total", "inv-sum")}
                            </>
                          ) : (
                            <>
                              {numCell(r, r.availableQuantity, r.status === "low", "Free to sell")}
                              {hasCost && <td className="inv-num inv-money" data-label="Value at cost">{r.trackStock === false ? "—" : toPesos(r.valueMinor)}</td>}
                            </>
                          )}
                          {canChange && (
                            <td className="inv-act">
                              <button type="button" className="btn btn-outline-primary" aria-label={`Adjust ${r.name}`} onClick={() => openAdjust(r)}>
                                <i className="bi bi-sliders" aria-hidden="true"></i><span className="inv-act-word">Adjust</span>
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          )}
          {/* Staff get no cost from the server; the value line is for the owner and managers. */}
          {hasCost && items.length > 0 && (
            <p className="inv-value mt-2 mb-1">Stock value at cost{warehouseId ? ` at ${placeName(warehouseId)}` : ", all stores"}: <strong>{toPesos(totalValue)}</strong></p>
          )}
          {allStores && rows.length > 0 && (
            <p className="inv-note mt-2">Numbers are what each store can still sell ({items.some((r) => r.quantityReserved > 0) ? "held for orders not counted" : "nothing is held for orders now"}). Red = none left, amber = low.</p>
          )}
        </>
      )}

      {/* M2: the 5-step adjustment — product → current stock → delta/count + reason → confirm */}
      {adjust && (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="adjustModalTitle">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title" id="adjustModalTitle"><i className="bi bi-sliders me-1"></i>Adjust {adjust.name}{adjustPlace ? <> at <span className="text-nowrap">{adjustPlace.name}</span></> : null}</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setAdjust(null)}></button>
                </div>
                <div className="modal-body">
                  <div className="small text-muted mb-1" id="adjustWhLabel">Which store's stock</div>
                  <div className="d-flex flex-wrap gap-2 mb-2" role="group" aria-labelledby="adjustWhLabel">
                    {places.map((w) => (
                      <button key={w.id} type="button" aria-pressed={w.id === adjustWh}
                        className={`btn ${w.id === adjustWh ? "btn-dark" : "btn-outline-dark"}`} style={{ minHeight: 44 }}
                        onClick={() => { setAdjustWh(w.id); setReorderAt(unitsText(adjust, shelfOf(adjust, w.id).reorderThreshold ?? 0)); setReorderMsg(null); }}>
                        {w.code ? `${w.code} · ` : ""}{w.name}
                      </button>
                    ))}
                  </div>
                  <p className="small mb-2">
                    Now at <strong>{adjustPlace?.name ?? "this store"}</strong>: <strong>{qtyText(adjust, shelfOf(adjust, adjustWh).quantityOnHand)}</strong> on hand · {qtyText(adjust, shelfOf(adjust, adjustWh).quantityReserved)} held for orders
                  </p>
                  <div className="btn-group btn-group-sm w-100 mb-2" role="group" aria-label="Adjustment mode">
                    <button type="button" className={`btn ${adjustMode === "delta" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setAdjustMode("delta")}>
                      Add / remove
                    </button>
                    <button type="button" className={`btn ${adjustMode === "setTo" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setAdjustMode("setTo")}>
                      Counted total
                    </button>
                  </div>
                  <label className="form-label small mb-1" htmlFor="adjustQty">
                    {adjustMode === "delta" ? "Change (+ to add, − to remove)" : "Counted quantity on the shelf"}{isLooseItem(adjust) ? ", in kilos" : ""}
                  </label>
                  <input id="adjustQty" className="form-control form-control-sm mb-2" type="number" step={isLooseItem(adjust) ? "0.5" : "1"} inputMode="decimal" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} placeholder={adjustMode === "delta" ? "e.g. 5 or -2" : "e.g. 37"} />
                  <label className="form-label small mb-1" htmlFor="adjustReason">Reason (stored on the ledger row)</label>
                  <input id="adjustReason" className="form-control form-control-sm mb-2" type="text" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="e.g. Delivery received / spillage / stock-take" />
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" id="adjustAllowNegative" checked={adjustAllowNegative} onChange={(e) => setAdjustAllowNegative(e.target.checked)} />
                    <label className="form-check-label small" htmlFor="adjustAllowNegative">
                      Allow a negative balance (stock-take correction — recorded, never hidden)
                    </label>
                  </div>
                  {adjustMode === "delta" && adjustQty !== "" && Number.isFinite(adjustUnits(adjust, adjustQty)) && (
                    <div className="small text-muted mt-2">
                      New on hand: <strong>{qtyText(adjust, shelfOf(adjust, adjustWh).quantityOnHand + adjustUnits(adjust, adjustQty))}</strong>
                    </div>
                  )}
                  {adjustError && <div className="alert alert-danger py-1 px-2 small mt-2 mb-0">{adjustError}</div>}
                  <hr className="my-3" />
                  <label className="form-label small mb-1" htmlFor="reorderAt">Reorder at {adjustPlace?.name ?? "this store"}{isLooseItem(adjust) ? ", in kilos" : ""} <span className="text-muted">(0 = no alert)</span></label>
                  <div className="d-flex gap-2">
                    <input id="reorderAt" className="form-control" type="number" min={0} step={isLooseItem(adjust) ? "0.5" : "1"} inputMode="decimal" value={reorderAt} onChange={(e) => { setReorderAt(e.target.value); setReorderMsg(null); }} placeholder="0" />
                    <button type="button" className="btn btn-outline-primary text-nowrap" style={{ minHeight: 44 }} disabled={reorderBusy} onClick={() => void saveReorder()}>
                      {reorderBusy ? "Saving…" : "Save level"}
                    </button>
                  </div>
                  {reorderMsg && <div className={`small mt-1 ${reorderMsg.ok ? "text-success" : "text-danger"}`} role="status">{reorderMsg.text}</div>}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setAdjust(null)}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={adjustBusy} onClick={() => void submitAdjust()}>
                    {adjustBusy ? "Saving…" : "Save adjustment"}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {conversionOpen && (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="conversionModalTitle">
            <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title" id="conversionModalTitle"><i className="bi bi-arrow-left-right me-1"></i>Convert stock</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setConversionOpen(false)}></button>
                </div>
                <div className="modal-body">
                  <p className="small text-muted">Convert available stock between products or variants. The system calculates the maximum output from each item's configured pack contents; reserved stock cannot be converted.</p>
                  {conversionError && <div className="alert alert-danger py-2 small">{conversionError}</div>}
                  {conversionOptions.length === 0 ? (
                    <div className="alert alert-warning small">No stock items have conversion unit and contents configured. Set these in Products first.</div>
                  ) : (
                    <>
                      <div className="mb-3">
                        <label className="form-label small" htmlFor="conversionWarehouse">Warehouse</label>
                        <select id="conversionWarehouse" className="form-select form-select-sm" value={conversionWarehouseId} onChange={(e) => { setConversionWarehouseId(e.target.value); setConversionIdempotencyKey(null); }}>
                          {conversionWarehouses.length === 0 && <option value="__none__">No warehouse</option>}
                          {conversionWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.isDefault ? " (default)" : ""}</option>)}
                          <option value="__none__">Warehouse-less stock</option>
                        </select>
                      </div>
                      <div className="row g-2">
                        <div className="col-md-6">
                          <label className="form-label small" htmlFor="conversionSource">Convert from</label>
                          <select id="conversionSource" className="form-select" value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setOutputQuantity(""); setConversionIdempotencyKey(null); }}>
                            <option value="">Select source item…</option>
                            {conversionOptions.map((item) => <option key={item.key} value={item.key}>{item.label} · {item.sku} · {formatBaseQty(item.baseQuantity, item.baseUnit)} · {item.available} available</option>)}
                          </select>
                          {sourceOption && <small className="text-muted">Available here: {sourceOption.available}</small>}
                        </div>
                        <div className="col-md-6">
                          <label className="form-label small" htmlFor="conversionDestination">Convert into</label>
                          <select id="conversionDestination" className="form-select" value={destinationKey} onChange={(e) => { setDestinationKey(e.target.value); setOutputQuantity(""); setConversionIdempotencyKey(null); }}>
                            <option value="">Select output item…</option>
                            {conversionOptions.filter((item) => item.key !== sourceKey && (!sourceOption || (item.baseUnit === sourceOption.baseUnit && item.conversionFamily.toLowerCase() === sourceOption.conversionFamily.toLowerCase()))).map((item) => <option key={item.key} value={item.key}>{item.label} · {item.sku} · {formatBaseQty(item.baseQuantity, item.baseUnit)}</option>)}
                          </select>
                          {destinationOption && <small className="text-muted">Current stock here: {destinationOption.available}</small>}
                        </div>
                      </div>
                      <div className="row g-2 mt-1">
                        <div className="col-md-6">
                          <label className="form-label small" htmlFor="conversionSourceQty">Source quantity</label>
                          <input id="conversionSourceQty" className="form-control" type="number" min="1" max={sourceOption?.available ?? 1} step="1" value={sourceQuantity} onChange={(e) => { setSourceQuantity(e.target.value); setConversionIdempotencyKey(null); }} />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label small" htmlFor="conversionOutputQty">Actual output quantity</label>
                          <input id="conversionOutputQty" className="form-control" type="number" min="1" max={maxOutputQuantity || undefined} step="1" value={outputQuantity} onChange={(e) => { setOutputQuantity(e.target.value); setConversionIdempotencyKey(null); }} />
                          <small className="text-muted">Maximum possible: {maxOutputQuantity} unit(s)</small>
                        </div>
                      </div>
                      {wasteBaseQuantity > 0 && sourceOption && <div className="alert alert-warning py-2 small mt-2 mb-2">Remainder recorded as waste: {formatBaseQty(wasteBaseQuantity, sourceOption.baseUnit)}.</div>}
                      <div className="mt-2">
                        <label className="form-label small" htmlFor="conversionReason">Conversion reason</label>
                        <input id="conversionReason" className="form-control" maxLength={200} value={conversionReason} onChange={(e) => { setConversionReason(e.target.value); setConversionIdempotencyKey(null); }} placeholder="e.g. Repacked rice for retail sale" />
                      </div>
                      {wasteBaseQuantity > 0 && (
                        <div className="mt-2">
                          <label className="form-label small" htmlFor="conversionWasteReason">Waste/loss reason *</label>
                          <input id="conversionWasteReason" className="form-control" required maxLength={200} value={wasteReason} onChange={(e) => { setWasteReason(e.target.value); setConversionIdempotencyKey(null); }} placeholder="e.g. Spillage during repacking" />
                        </div>
                      )}
                      <div className="small text-muted mt-2">Both stock movements and the conversion audit record are saved together. The remaining material is recorded as waste when actual output is below the maximum.</div>
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConversionOpen(false)}>Cancel</button>
                  <button type="button" className="btn btn-success" disabled={conversionBusy || conversionOptions.length === 0} onClick={() => void submitConversion()}>
                    {conversionBusy ? "Converting…" : "Confirm conversion"}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
