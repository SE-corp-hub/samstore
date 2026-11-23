"use client";

import { AddedAtFilter, AddedLine } from "./AddedTag";
import { addedStores, matchesAddedAt } from "../../lib/added-where";
import { ScopeTag } from "./WhoCan";
import { PesoInput, WholeInput } from "../NumberBoxes";
import { askBelowCost } from "./BelowCostDialog";
import { isBelowCost } from "../../lib/below-cost";
import { useCallback, useEffect, useMemo, useState } from "react";
import AddSeveralProducts from "./AddSeveralProducts";
import { API_URL } from "../../config";
import { adminHeaders, roleCan } from "../../lib/admin";
import { cachedGet } from "../../lib/offlineCache";
import LabelSheet from "./LabelSheet";
import VariantEditor from "./VariantEditor";
import PhotoPicker, { type PhotoChange } from "./PhotoPicker";
import ProductPhoto from "./ProductPhoto";
import { kg, peso, pesosToMinor } from "../../lib/number-format";
import { toast } from "../../lib/toast";

/** A sack big enough to also sell per kilo (10 kg or more; the 5 kg packs stay packs). */
const canSellPerKilo = (p: AdminProduct) => !p.soldByWeight && p.stockBaseUnit === "g" && (p.stockBaseQuantity ?? 0) >= 10_000;

/**
 * "Also sell per kilo" on a sack rice (2026-11-20). Saved at once (not with Save): On makes the
 * kilo item ("Sinandomeng · per kilo"), with a starting price of sack ÷ kilos, rounded up, + ₱2.
 * Its price is then changed on its own line in Products like any price. Only stores with
 * Settings → This store → "Sell per kilo here" on show it on POS and Pre-order.
 */
function AlsoPerKilo({ sack, onChanged }: { sack: AdminProduct; onChanged: () => void }) {
  const [item, setItem] = useState(sack.kiloItem ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stuck, setStuck] = useState<string | null>(null);
  const on = !!item?.isActive;
  const flip = async (next: boolean, force = false) => {
    setBusy(true); setProblem(null);
    try {
      const res = await fetch(`${API_URL}/admin/products/${encodeURIComponent(sack.id)}/kilo-item`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ on: next, force: next ? undefined : force }),
      });
      const d = await res.json().catch(() => null);
      // Kilos still on the rack: say so, and offer "Hide anyway".
      if (res.status === 409) { setStuck(d?.message ?? "Kilos are still left."); return; }
      if (!res.ok) { setProblem(d?.errors?.join(", ") ?? d?.message ?? "Did not save. Try again."); return; }
      setStuck(null);
      setItem(d?.kiloItem ?? null);
      toast(next ? `${d?.kiloItem?.name ?? "Kilo rice"} added` : "Kilo rice hidden", "success");
      onChanged();
    } catch {
      setProblem("No internet. Nothing was saved. Try again when the tablet is online.");
    } finally { setBusy(false); }
  };
  return (
    <div className="border rounded p-2 mb-2" style={{ background: "var(--bs-tertiary-bg, #f7f5f2)" }}>
      <div className="form-check form-switch mb-1">
        <input className="form-check-input" type="checkbox" role="switch" id="alsoPerKilo" checked={on} disabled={busy} onChange={(e) => void flip(e.target.checked)} />
        <label className="form-check-label fw-semibold" htmlFor="alsoPerKilo">Also sell per kilo</label>
      </div>
      <div className="small text-muted">
        {on && item
          ? <>Sold as its own item: <strong>{item.name}</strong> at {peso(item.priceMinor)} a kilo. To change the kilo price, edit that item in Products.</>
          : "On: adds a kilo item for this rice, priced at the sack price ÷ kilos, rounded up, + ₱2. It shows only at stores with Sell per kilo here on (Settings → This store)."}
      </div>
      {busy && <div className="small mt-1" role="status">Saving…</div>}
      {problem && <div className="alert alert-danger py-1 px-2 mt-1 mb-0 small" role="alert">{problem}</div>}
      {stuck && (
        <div className="alert alert-warning py-2 px-2 mt-1 mb-0" role="alert">
          <div className="mb-2">{stuck}</div>
          <div className="d-flex gap-2">
            <button type="button" className="btn btn-outline-dark" disabled={busy} onClick={() => setStuck(null)}>Keep selling per kilo</button>
            <button type="button" className="btn btn-outline-danger" disabled={busy} onClick={() => void flip(false, true)}>Hide anyway</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Display rack (2026-11-20): a kilo rice with one price (e.g. "Rack ₱50") that staff fill from any of the
 * ticked sacks with "Open sacks" on the POS. Any loose rice can be a rack, also one made by hand earlier.
 * Saved at once. Its own sack ("Also sell per kilo") always counts and is not listed here.
 */
function RackSacks({ kilo, onChanged }: { kilo: AdminProduct; onChanged: () => void }) {
  const [ticked, setTicked] = useState<string[]>(kilo.rackSackIds ?? []);
  // Every rice (the Products list may be narrowed by a search).
  const [all, setAll] = useState<AdminProduct[]>([]);
  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/admin/products`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d?.products) setAll([...d.products].sort((a: AdminProduct, b: AdminProduct) => a.name.localeCompare(b.name))); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const own = kilo.kiloOfId ? all.find((p) => p.id === kilo.kiloOfId) : undefined;
  const options = all.filter((p) => canSellPerKilo(p) && p.isActive && p.id !== kilo.kiloOfId);
  const save = async (next: string[]) => {
    setBusy(true); setProblem(null);
    try {
      const res = await fetch(`${API_URL}/admin/products/${encodeURIComponent(kilo.id)}/rack-sacks`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ sackIds: next }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setProblem(d?.errors?.join(", ") ?? d?.message ?? "Did not save. Try again."); return; }
      setTicked(next);
      onChanged();
    } catch {
      setProblem("No internet. Nothing was saved. Try again when the tablet is online.");
    } finally { setBusy(false); }
  };
  return (
    <div className="border rounded p-2 mb-2" style={{ background: "var(--bs-tertiary-bg, #f7f5f2)" }}>
      <div className="fw-semibold mb-1">Sacks that go in this rack</div>
      <div className="small text-muted mb-2">
        Tick every rice staff may pour into <strong>{kilo.name}</strong>. On the POS, <strong>Open sacks</strong> asks which one. The kilo cost becomes the average of what goes in.
        {own && <> Its own sack, <strong>{own.name}</strong>, always counts.</>}
      </div>
      {all.length === 0
        ? <div className="small" role="status">Loading the rice…</div>
        : options.length === 0
        ? <div className="small">No sacks of 10 kg or more to choose from.</div>
        : (
          <div className="d-grid gap-1" style={{ maxHeight: "16rem", overflowY: "auto" }}>
            {options.map((p) => {
              const id = `rack-${p.id}`;
              const on = ticked.includes(p.id);
              return (
                <div key={p.id} className="form-check">
                  <input className="form-check-input" type="checkbox" id={id} checked={on} disabled={busy}
                    onChange={() => void save(on ? ticked.filter((x) => x !== p.id) : [...ticked, p.id])} />
                  <label className="form-check-label" htmlFor={id}>{p.name}</label>
                </div>
              );
            })}
          </div>
        )}
      {busy && <div className="small mt-1" role="status">Saving…</div>}
      {problem && <div className="alert alert-danger py-1 px-2 mt-1 mb-0 small" role="alert">{problem}</div>}
    </div>
  );
}

export interface AdminProduct {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  barcode: string | null;
  unit: string | null;
  soldByWeight: boolean;
  trackStock?: boolean;
  priceMinor: number;
  costMinor: number;
  stockBaseUnit: string | null;
  stockBaseQuantity: number | null;
  stockConversionFamily: string | null;
  isActive: boolean;
  taxExempt: boolean;
  featured: boolean;
  tags: string[];
  /** The product's picture (see lib/product-photo.ts), or null. */
  photoKey?: string | null;
  /** A kilo item: the sack rice it is opened from. */
  kiloOfId?: string | null;
  /** A sack rice: its kilo item ("Also sell per kilo"), or null. */
  kiloItem?: { id: string; name: string; isActive: boolean; priceMinor: number } | null;
  /** A kilo rice (display rack): the other sacks that can fill it. */
  rackSackIds?: string[];
  /** Where it was made (store, screen, who); empty = made before this was kept. */
  addedAt?: { id: string; name: string } | null;
  addedVia?: string | null;
  addedBy?: string | null;
  /** Made by counter staff: waits for the owner's "Looks right". */
  toCheck?: boolean;
  related: { id: string; name: string; priceMinor: number; isActive: boolean }[];
  upsell: { id: string; name: string; priceMinor: number; isActive: boolean }[];
  category: { id: string; name: string; slug: string } | null;
  quantityOnHand: number;
  quantityReserved: number;
  availableQuantity: number;
  reorderThreshold: number;
  variants?: { id: string; name: string; sku: string; priceMinor: number; costMinor: number; stockBaseQuantity: number | null; quantityOnHand: number; availableQuantity: number; isActive: boolean }[];
  addons?: { id: string; name: string; required: boolean; options: { id: string; name: string; priceMinor: number; isActive: boolean }[] }[];
}

interface ProductForm {
  name: string;
  sku: string;
  barcode: string;
  unit: string;
  soldByWeight: boolean;
  trackStock: boolean; // off = sells at any time, no stock check
  priceMinor: string; // pesos input, converted to minor units
  costMinor: string; // acquisition cost in pesos, converted to minor units
  conversionEnabled: boolean;
  packageSize: string;
  packageUnit: string;
  stockConversionFamily: string;
  stock: string;
  categorySlug: string;
  categoryName: string;
  description: string;
  /** M4: VAT-exempt product (basic/zero-rated goods). */
  taxExempt: boolean;
  /** P3d: merchandising — featured flag, tags (comma input), related/upsell id lists. */
  featured: boolean;
  tags: string;
  related: string[];
  upsell: string[];
  /** P3f: quantity-on-hand at/below which the item is flagged LOW stock. */
  reorderThreshold: string;
  /** New sack rice only: make its kilo item right after saving ("Also sell per kilo"). */
  alsoPerKilo: boolean;
}

const EMPTY_FORM: ProductForm = { name: "", sku: "", barcode: "", unit: "", soldByWeight: false, trackStock: true, priceMinor: "", costMinor: "", conversionEnabled: false, packageSize: "", packageUnit: "kg", stockConversionFamily: "", stock: "", categorySlug: "", categoryName: "", description: "", taxExempt: false, featured: false, tags: "", related: [], upsell: [], reorderThreshold: "", alsoPerKilo: false };
const formatStockSize = (quantity: number, unit: string) => {
  if ((unit === "g" || unit === "ml") && quantity % 1000 === 0) {
    return `${quantity / 1000} ${unit === "g" ? "kg" : "L"}`;
  }
  return `${quantity} ${unit}`;
};
const stockMeasureFromBase = (unit: string | null, quantity: number | null) => {
  if (unit === "g") return quantity && quantity % 1000 === 0 ? { packageSize: String(quantity / 1000), packageUnit: "kg" } : { packageSize: quantity?.toString() ?? "", packageUnit: "g" };
  if (unit === "ml") return quantity && quantity % 1000 === 0 ? { packageSize: String(quantity / 1000), packageUnit: "L" } : { packageSize: quantity?.toString() ?? "", packageUnit: "ml" };
  if (unit === "each") return { packageSize: quantity?.toString() ?? "", packageUnit: "each" };
  return { packageSize: "", packageUnit: "kg" };
};
const stockMeasureToBase = (packageSize: string, packageUnit: string) => {
  const size = Number.parseFloat(packageSize);
  if (!Number.isFinite(size) || size <= 0) return { stockBaseUnit: packageUnit === "ml" || packageUnit === "L" ? "ml" : packageUnit === "each" ? "each" : "g", stockBaseQuantity: null };
  const factor = packageUnit === "kg" || packageUnit === "L" ? 1000 : 1;
  const stockBaseUnit = packageUnit === "ml" || packageUnit === "L" ? "ml" : packageUnit === "each" ? "each" : "g";
  return { stockBaseUnit, stockBaseQuantity: Math.round(size * factor) };
};

/** One rice's price at the manager's own store (GET /admin/warehouses/:id/prices). */
interface HerePrice { mainPriceMinor: number; locationPriceMinor: number | null; effectivePriceMinor: number; lowestPriceMinor?: number }
/** The manager's own-store boxes in the Manage window. */
interface HereForm { name: string; price: string; reorder: string; useMain: boolean }

type PriceHistoryRow = { id: string; field: string; oldMinor: number; newMinor: number; source: string; reason: string | null; who: string | null; at: string };
const HISTORY_SOURCE: Record<string, string> = { MANUAL: "Edited by hand", PURCHASE: "New stock received", CONVERSION: "Resack", LOCATION: "Location price" };

/** Every cost and price change for one product, newest first. Opens on tap. */
const pesosText = (minor: number) => peso(minor);

function PriceHistoryList({ productId }: { productId: string }) {
  const [rows, setRows] = useState<PriceHistoryRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && rows === null) {
      try {
        const res = await fetch(`${API_URL}/admin/products/${productId}/price-history`, { headers: adminHeaders() });
        const data = await res.json();
        if (!res.ok) { setErr("Could not load the history."); return; }
        setRows(data.rows ?? []);
      } catch { setErr("Could not load the history."); }
    }
  }
  return (
    <div className="mb-2">
      <button type="button" className="btn btn-link btn-sm px-0" onClick={toggle}>{open ? "Hide cost and price history" : "Show cost and price history"}</button>
      {open && err && <div className="text-danger small">{err}</div>}
      {open && !err && rows === null && <div className="text-muted small">Loading...</div>}
      {open && rows !== null && rows.length === 0 && <div className="text-muted small">No changes yet.</div>}
      {open && rows !== null && rows.length > 0 && (
        <div className="table-responsive" style={{ maxHeight: 220, overflowY: "auto" }}>
          <table className="table table-sm small mb-0">
            <thead><tr><th>When</th><th>What</th><th className="text-end">Was</th><th className="text-end">Now</th><th>Who / why</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.at).toLocaleDateString()}</td>
                  <td>{r.field === "COST" ? "Cost" : "Price"}</td>
                  <td className="text-end">{pesosText(r.oldMinor)}</td>
                  <td className="text-end fw-semibold">{pesosText(r.newMinor)}</td>
                  <td>{r.who ?? ""} <span className="text-muted">{HISTORY_SOURCE[r.source] ?? r.source}{r.reason ? ` (${r.reason})` : ""}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ProductsPanel({ role = "" }: { role?: string }) {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  // Owner: everything. Manager: add a new product (its opening stock goes to their own store), and on an
  // existing one the picture only (2026-11-22: the main price and reorder level change every store; a
  // manager sets their store's price on Store prices). Staff: look only (they add at POS with "+ New item").
  const canSetUp = roleCan(role, "setUpProducts");
  const canPrice = roleCan(role, "changePrices");
  const canAdd = roleCan(role, "addProducts");
  const canPhoto = canAdd; // the owner and a manager change the picture
  // 2026-11-22 ("make manager role can manage own location products"): a manager with a home store runs
  // that store's side of every rice right here: its own selling price, its reorder level, the picture.
  // The rice's NAME too (owner's choice: "Yes, any rice"; every store shows the new name). Cost, setup and
  // the price for all stores stay the owner's: every store shares them.
  const [homeId, setHomeId] = useState<string | null>(null);
  const storeMode = !canSetUp && canAdd && !!homeId;
  // 2026-11-23 (Products made easy for every role): every login tied to one store sees ITS price and stock.
  // A store head may change the store's price here too (the server says so: canEdit); counter staff only look.
  const hereMode = !canSetUp && !!homeId;
  const [hereCanPrice, setHereCanPrice] = useState(false);
  const [herePrices, setHerePrices] = useState<Record<string, HerePrice>>({});
  const [here, setHere] = useState<HereForm>({ name: "", price: "", reorder: "", useMain: false });

  // Staff get no cost from the server, so the cost column and field are hidden for them.
  const hasCost = products.length === 0 || typeof products[0]!.costMinor === "number";
  const [categories, setCategories] = useState<{ id: string; slug: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ open: boolean; editing: AdminProduct | null }>({ open: false, editing: null });
  // A new product is filled in whole by whoever may add one; an existing one's details are the owner's.
  const locked = modal.editing ? !canSetUp : !canAdd;
  const viewOnly = modal.editing ? !canPhoto : !canAdd;
  /** Price fields: the owner always; a manager only on a new product they are adding. */
  const priceLocked = modal.editing ? !canPrice : !canAdd;
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [saving, setSaving] = useState(false);
  // Finding a rice: search (server), then group buttons, the tiles (All / Below cost / To check / Hidden) and sort.
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [view, setView] = useState<"all" | "below" | "check" | "hidden">("all");
  const [sort, setSort] = useState<"name" | "price" | "stock" | "newest">("name");
  // Print labels: tick boxes show only while choosing.
  const [picking, setPicking] = useState(false);
  // M3: batch label printing — the selected product ids open the 57 × 40 mm label sheet.
  const [selected, setSelected] = useState<string[]>([]);
  const [labelOpen, setLabelOpen] = useState(false);
  const [several, setSeveral] = useState(false);
  // P2c: variant + add-on management modal
  const [optionsFor, setOptionsFor] = useState<AdminProduct | null>(null);
  // The Picture field: what happens to the product's picture on Save.
  const [photo, setPhoto] = useState<PhotoChange>({ kind: "keep" });
  // Where each one was made: the "Made at" filter, and counter-made items the owner still has to check.
  const [madeAt, setMadeAt] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const looksRight = async (p: AdminProduct) => {
    setChecking(p.id);
    try {
      const res = await fetch(`${API_URL}/admin/products/${encodeURIComponent(p.id)}/checked`, { method: "POST", headers: adminHeaders() });
      if (!res.ok) { toast("Could not save. Try again.", "danger"); return; }
      setProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, toCheck: false } : x)));
      toast(`${p.name}: checked`, "success");
    } catch { toast("No internet. Try again when it is back.", "danger"); } finally { setChecking(null); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (search) q.set("search", search);
      const [pRes, cRes] = await Promise.all([
        fetch(`${API_URL}/admin/products?${q.toString()}`, { headers: adminHeaders() }),
                fetch(`${API_URL}/admin/products/categories`, { headers: adminHeaders() }),
      ]);
      if (!pRes.ok) throw new Error("Failed to load products");
      const p = await pRes.json();
      const c = await cRes.json();
      setProducts(p.products as AdminProduct[]);
      setCategories(c.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  // The stores (for "Opening stock goes to" on a new rice). The main store comes first.
  const [places, setPlaces] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [stockAt, setStockAt] = useState("");
  const mainPlace = places.find((w) => w.isDefault) ?? null;
  // A login tied to one store (e.g. the Lipa manager): a new rice's opening stock goes there unless they pick another.
  useEffect(() => { void cachedGet<{ homeLocationId?: string | null }>("/admin/me/rice").then((me) => setHomeId(me?.homeLocationId ?? null)); }, []);
  useEffect(() => {
    void fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      setPlaces(((d?.warehouses ?? []) as { id: string; name: string; isDefault: boolean; isActive?: boolean; type?: string }[]).filter((w) => w.isActive !== false && w.type !== "BUFFER"));
    }).catch(() => undefined);
  }, []);
  const homeName = places.find((w) => w.id === homeId)?.name ?? "your store";
  const loadHere = useCallback(async () => {
    if (!hereMode || !homeId) return;
    try {
      const res = await fetch(`${API_URL}/admin/warehouses/${encodeURIComponent(homeId)}/prices`, { headers: adminHeaders() });
      const d = await res.json().catch(() => null);
      if (!res.ok) return;
      const next: Record<string, HerePrice> = {};
      for (const r of (d?.prices ?? []) as (HerePrice & { productId: string })[]) next[r.productId] = r;
      setHerePrices(next);
      setHereCanPrice(!!d?.canEdit);
    } catch { /* the list still shows; the price box falls back to the main price */ }
  }, [hereMode, homeId]);
  useEffect(() => { void loadHere(); }, [loadHere]);
  /** The price this rice sells at, at the manager's store (its own price, else the main price). */
  const priceHere = (p: AdminProduct) => herePrices[p.id]?.effectivePriceMinor ?? p.priceMinor;

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setStockAt(homeId && places.some((w) => w.id === homeId) ? homeId : "");
    setPhoto({ kind: "keep" });
    setCreatingCategory(false);
    setModal({ open: true, editing: null });
  };

  const openEdit = (p: AdminProduct) => {
    const measure = stockMeasureFromBase(p.stockBaseUnit, p.stockBaseQuantity);
    setForm({
      name: p.name,
      sku: p.sku,
      barcode: p.barcode ?? "",
      unit: p.unit ?? "",
      soldByWeight: p.soldByWeight ?? false,
      trackStock: p.trackStock !== false,
      priceMinor: (p.priceMinor / 100).toString(),
      costMinor: typeof p.costMinor === "number" ? (p.costMinor / 100).toString() : "",
      conversionEnabled: Boolean(p.stockBaseUnit),
      packageSize: measure.packageSize,
      packageUnit: measure.packageUnit,
      stockConversionFamily: p.stockConversionFamily ?? "",
      stock: p.quantityOnHand.toString(),
      categorySlug: p.category?.slug ?? "",
      categoryName: "",
      description: p.description ?? "",
      taxExempt: p.taxExempt ?? false,
      featured: p.featured ?? false,
      tags: (p.tags ?? []).join(", "),
      related: p.related?.filter((r) => r.isActive).map((r) => r.id) ?? [],
      upsell: p.upsell?.filter((r) => r.isActive).map((r) => r.id) ?? [],
      reorderThreshold: (p.reorderThreshold || 0).toString(),
      alsoPerKilo: false,
    });
    setError(null);
    const hp = herePrices[p.id];
    setHere({ name: p.name, price: ((hp?.locationPriceMinor ?? hp?.effectivePriceMinor ?? p.priceMinor) / 100).toFixed(2), reorder: (p.reorderThreshold || 0).toString(), useMain: false });
    setCreatingCategory(false);
    setPhoto({ kind: "keep" });
    setModal({ open: true, editing: p });
  };

  // A new sack of 10 kg or more can get its kilo item when it is first saved.
  const newSackMeasure = form.conversionEnabled ? stockMeasureToBase(form.packageSize, form.packageUnit) : null;
  const newSackCanKilo = !form.soldByWeight && newSackMeasure?.stockBaseUnit === "g" && (newSackMeasure.stockBaseQuantity ?? 0) >= 10_000;
  /** Manager, existing rice: save this store's price, its reorder level and the picture. */
  const saveHere = async (p: AdminProduct) => {
    const hp = herePrices[p.id];
    const ownNow = hp?.locationPriceMinor ?? null;
    const sellsNow = hp?.effectivePriceMinor ?? p.priceMinor;
    const mayPrice = hereCanPrice, mayRest = storeMode; // rest = reorder level, picture, name (a manager)
    const typed = pesosToMinor(here.price);
    if (mayPrice && !here.useMain && (!typed || typed <= 0)) { setError("Type the price at your store, above ₱0."); return; }
    const wouldSellAt = here.useMain ? (hp?.mainPriceMinor ?? p.priceMinor) : typed!;
    if (mayPrice && typeof hp?.lowestPriceMinor === "number" && wouldSellAt < hp.lowestPriceMinor) {
      setError(`${peso(wouldSellAt)} is under the lowest price for ${p.name} (${peso(hp.lowestPriceMinor)}). Ask the owner to go lower.`);
      return;
    }
    const name = here.name.trim();
    if (!name) { setError("Type the rice name."); return; }
    const reorder = here.reorder.trim() === "" ? 0 : parseInt(here.reorder, 10);
    if (!Number.isInteger(reorder) || reorder < 0) { setError("Reorder level: type a whole number, 0 or more."); return; }
    const send = async (path: string, method: string, body?: unknown) => {
      const res = await fetch(`${API_URL}${path}`, { method, headers: { "Content-Type": "application/json", ...adminHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.ok) return null;
      const d = await res.json().catch(() => null);
      return (d?.errors?.join(", ") ?? d?.message ?? "Not saved. Try again.") as string;
    };
    setSaving(true);
    try {
      const done: string[] = [];
      if (mayRest && name !== p.name) {
        const why = await send(`/admin/products/${encodeURIComponent(p.id)}`, "PATCH", { name });
        if (why) { setError(`Name not saved: ${why}`); return; }
        done.push(`now called ${name}`);
      }
      // Price: only when it changed. Back to the main price = remove this store's own price.
      const priceBody = !mayPrice ? undefined : here.useMain ? (ownNow === null ? undefined : null) : typed === sellsNow && ownNow === null ? undefined : typed === ownNow ? undefined : typed;
      if (priceBody !== undefined) {
        const why = await send(`/admin/warehouses/${encodeURIComponent(homeId!)}/prices/${encodeURIComponent(p.id)}`, "PUT", { priceMinor: priceBody });
        if (why) { setError(`Price not saved: ${why}`); return; }
        done.push(priceBody === null ? "back to the main price" : `${peso(priceBody)} at ${homeName}`);
      }
      if (mayRest && reorder !== (p.reorderThreshold || 0)) {
        const why = await send("/admin/stock/reorder", "POST", { productId: p.id, warehouseId: homeId, reorderThreshold: reorder });
        if (why) { setError(`Reorder level not saved: ${why}`); return; }
        done.push(`reorder at ${reorder}`);
      }
      if (mayRest && photo.kind !== "keep") {
        const why = await send(`/admin/products/${encodeURIComponent(p.id)}/photo`, photo.kind === "new" ? "PUT" : "DELETE", photo.kind === "new" ? { dataUrl: photo.dataUrl } : undefined);
        if (why) { setError(`Picture not saved: ${why}`); return; }
        done.push(photo.kind === "new" ? "new picture" : "picture removed");
      }
      setModal({ open: false, editing: null });
      if (done.length) toast(`${p.name}: ${done.join(", ")}`, "success");
      else toast("Nothing changed.");
      await Promise.all([load(), loadHere()]);
    } catch {
      setError("No connection. Not saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (hereMode && modal.editing) { await saveHere(modal.editing); return; }
    try {
      let priceMinor = Math.round(parseFloat(form.priceMinor) * 100);
      let costMinor = form.costMinor.trim() === "" ? undefined : Math.round(parseFloat(form.costMinor) * 100);
      // Selling price under the unit cost: fix the price, change the cost, or save anyway.
      const costNow = costMinor ?? modal.editing?.costMinor;
      if (isBelowCost(priceMinor, costNow)) {
        const pick = await askBelowCost({ name: form.name.trim() || "This product", priceMinor, costMinor: costNow!, unit: form.soldByWeight ? "kilo" : form.conversionEnabled && form.packageUnit === "kg" ? "sack" : "piece", showCost: true, canChangeCost: hasCost && !locked, proceed: "Save anyway" });
        if (!pick) return;
        if (pick.kind === "price") priceMinor = pick.priceMinor;
        if (pick.kind === "cost") costMinor = pick.costMinor;
        setForm((f) => ({ ...f, priceMinor: (priceMinor / 100).toFixed(2), costMinor: costMinor === undefined ? f.costMinor : (costMinor / 100).toFixed(2) }));
      }
      setSaving(true);
      const fullPayload = (() => {
      const measure = form.conversionEnabled ? stockMeasureToBase(form.packageSize, form.packageUnit) : { stockBaseUnit: null, stockBaseQuantity: null };
      const payload = {
        name: form.name,
        // No code typed on a new rice: the app makes one from the name (2026-11-23: one box less to fill).
        sku: form.sku.trim() || (modal.editing ? form.sku : `${form.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "RICE"}-${Date.now().toString(36).slice(-4).toUpperCase()}`),
        barcode: form.barcode.trim() || null,
        unit: form.unit.trim() || null,
        soldByWeight: form.soldByWeight,
        trackStock: form.trackStock,
        priceMinor,
        costMinor,
        stockBaseUnit: measure.stockBaseUnit,
        stockBaseQuantity: measure.stockBaseQuantity,
        stockConversionFamily: form.conversionEnabled ? form.stockConversionFamily.trim() || null : null,
        // Opening stock is for a new product only: an edit never changes stock (the box showed every store's total).
        stock: modal.editing || form.stock === "" ? undefined : parseInt(form.stock, 10),
        // The store that gets the opening stock (empty = the main store).
        ...(!modal.editing && form.stock !== "" && stockAt ? { stockLocationId: stockAt } : {}),
        categorySlug: creatingCategory ? undefined : form.categorySlug || undefined,
        categoryName: !modal.editing && creatingCategory ? form.categoryName.trim() || undefined : undefined,
        description: form.description || undefined,
        taxExempt: form.taxExempt,
        featured: form.featured,
        tags: form.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0),
        reorderThreshold: form.reorderThreshold === "" ? undefined : parseInt(form.reorderThreshold, 10),
        ...(modal.editing
          ? { relatedProductIds: form.related, upsellProductIds: form.upsell }
          : {}),
      };
      return payload;
      })();
      // A manager changes only the picture of an existing product (sent below): nothing else to save.
      const payload = !locked ? fullPayload : null;
      const res = !payload ? null : await fetch(
        `${API_URL}/admin/products${modal.editing ? `/${modal.editing.id}` : ""}`,
        {
          method: modal.editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
                    body: JSON.stringify(payload),
        },
      );
      const data = res ? await res.json() : null;
      if (res && !res.ok) {
        setError(data?.errors?.join(", ") ?? data?.message ?? "Save failed");
        return;
      }
      // The picture goes up after the product is saved (a new product needs its id first).
      const productId: string | undefined = modal.editing?.id ?? data?.id;
      if (productId && photo.kind !== "keep") {
        const pr = await fetch(`${API_URL}/admin/products/${productId}/photo`, photo.kind === "new"
          ? { method: "PUT", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ dataUrl: photo.dataUrl }) }
          : { method: "DELETE", headers: adminHeaders() });
        if (!pr.ok) {
          const pd = await pr.json().catch(() => null);
          setModal({ open: false, editing: null });
          await load();
          setError(`The product was saved, but the picture was not: ${pd?.errors?.join(", ") ?? pd?.message ?? "try again"}`);
          return;
        }
      }
      // "Also sell per kilo" ticked on a new sack: make its kilo item now that the sack has an id.
      if (!modal.editing && productId && form.alsoPerKilo && newSackCanKilo) {
        const kr = await fetch(`${API_URL}/admin/products/${encodeURIComponent(productId)}/kilo-item`, {
          method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ on: true }),
        });
        if (!kr.ok) {
          const kd = await kr.json().catch(() => null);
          setModal({ open: false, editing: null });
          await load();
          setError(`The rice was saved, but its kilo item was not: ${kd?.errors?.join(", ") ?? kd?.message ?? "open the rice and turn on Also sell per kilo"}`);
          return;
        }
        toast(`${form.name.trim()} saved, with its kilo item in the 1 kg group`, "success");
      }
      setModal({ open: false, editing: null });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (p: AdminProduct) => {
    try {
      const res = await fetch(`${API_URL}/admin/products/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ isActive: !p.isActive }),
      });
      if (!res.ok) { const d = await res.json().catch(() => null); setError(d?.errors?.join(", ") ?? d?.message ?? "Not saved. Try again."); return; }
      toast(p.isActive ? `${p.name} is hidden from sale` : `${p.name} is back on sale`, "success");
      setModal({ open: false, editing: null });
      await load();
    } catch { setError("No connection. Not saved. Try again."); }
  };

  // ── What this login sees ──────────────────────────────────────────────────────────────────────────
  /** The price shown for a rice: a store login's own store price, the owner's price for all stores. */
  const shownPrice = (p: AdminProduct) => (hereMode ? priceHere(p) : p.priceMinor);
  const isBelow = (p: AdminProduct) => isBelowCost(shownPrice(p), p.costMinor);
  const isLow = (p: AdminProduct) => hereMode && p.trackStock !== false && p.reorderThreshold > 0 && p.availableQuantity <= p.reorderThreshold;
  const belowCount = products.filter(isBelow).length;
  const checkCount = canSetUp ? products.filter((p) => p.toCheck).length : 0;
  const hiddenCount = products.filter((p) => !p.isActive).length;
  const sellingCount = products.length - hiddenCount;
  // A tile whose count dropped to 0 (the last one was fixed) falls back to All.
  const viewNow = (view === "below" && belowCount === 0) || (view === "check" && checkCount === 0) || (view === "hidden" && hiddenCount === 0) ? "all" : view;
  const NO_GROUP = "none";
  const groups = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of products) { const k = p.category?.id ?? NO_GROUP; count.set(k, (count.get(k) ?? 0) + 1); }
    const named = categories.filter((c) => count.has(c.id)).map((c) => ({ id: c.id, name: c.name, n: count.get(c.id)! }));
    return count.has(NO_GROUP) ? [...named, { id: NO_GROUP, name: "No group", n: count.get(NO_GROUP)! }] : named;
  }, [products, categories]);
  const groupNow = groups.some((g) => g.id === group) ? group : "";
  const shown = useMemo(() => {
    const rows = products.filter((p) =>
      matchesAddedAt(p, madeAt)
      && (!groupNow || (p.category?.id ?? NO_GROUP) === groupNow)
      && (viewNow === "all" ? true : viewNow === "below" ? isBelow(p) : viewNow === "check" ? !!p.toCheck : !p.isActive));
    const by = sort === "price" ? (a: AdminProduct, b: AdminProduct) => shownPrice(a) - shownPrice(b)
      : sort === "stock" ? (a: AdminProduct, b: AdminProduct) => b.availableQuantity - a.availableQuantity
      : sort === "newest" ? null
      : (a: AdminProduct, b: AdminProduct) => a.name.localeCompare(b.name);
    return by ? [...rows].sort(by) : [...rows].reverse(); // the server lists oldest first
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, madeAt, groupNow, viewNow, sort, herePrices, hereMode]);

  const canLine = canSetUp ? "Tap Edit on a rice to change its name, price, cost or picture. The price here is for all stores."
    : storeMode ? `Tap Manage on a rice to set its price, reorder level and picture at ${homeName}.`
    : hereMode && hereCanPrice ? `Tap Price on a rice to change what it sells for at ${homeName}.`
    : canAdd ? "You can add a new rice and change pictures. Ask the owner to give your login a store to set prices."
    : "Tap See on a rice for its price and stock. To add a new one, use + New item on POS.";
  const rowAction = canSetUp ? { word: "Edit", icon: "bi-pencil" } : storeMode ? { word: "Manage", icon: "bi-pencil-square" }
    : hereMode && hereCanPrice ? { word: "Price", icon: "bi-tag" } : canPhoto ? { word: "Picture", icon: "bi-image" } : { word: "See", icon: "bi-eye" };
  const priceWord = hereMode ? `Price at ${homeName}` : "Price, all stores";
  const stockWord = hereMode ? `Stock at ${homeName}` : "Stock, all stores";
  const qty = (p: AdminProduct, n: number) => (p.soldByWeight ? kg(n) : String(n));
  const sizeOf = (p: AdminProduct) => (p.stockBaseUnit && p.stockBaseQuantity && !p.soldByWeight ? formatStockSize(p.stockBaseQuantity, p.stockBaseUnit) : null);

  // ── The rice window ───────────────────────────────────────────────────────────────────────────────
  /** A store login opening a rice: "At <store>" first, the shared details to read below. */
  const ed = modal.editing;
  const storeEdit = hereMode && !!ed;
  const hp = ed ? herePrices[ed.id] : undefined;
  const hereMaySave = storeEdit && (hereCanPrice || storeMode);
  const closeModal = () => { setModal({ open: false, editing: null }); setError(null); };
  const modalTitle = !ed ? "New rice" : ed.name;

  const storeBody = ed && storeEdit && (
    <>
      <ScopeTag scope="store" storeName={homeName} />
      <section className="here-card" aria-labelledby="here-title">
        <h6 id="here-title" className="here-title">At {homeName}</h6>
        <div className="row g-3">
          <div className="col-sm-6">
            <label className="form-label" htmlFor="herePrice">Price at {homeName} (₱){ed.soldByWeight ? " per kilo" : ""}</label>
            {hereCanPrice ? (
              <PesoInput id="herePrice" value={here.useMain ? ((hp?.mainPriceMinor ?? ed.priceMinor) / 100).toFixed(2) : here.price}
                onChange={(v) => setHere({ ...here, price: v, useMain: false })} placeholder="0.00" aria-describedby="herePrice-help" />
            ) : (
              <div id="herePrice" className="here-read">{peso(priceHere(ed))}</div>
            )}
            <div id="herePrice-help" className="small text-muted mt-1">
              Price for all stores: {peso(hp?.mainPriceMinor ?? ed.priceMinor)}
              {hereCanPrice && typeof hp?.lowestPriceMinor === "number" && <> · Lowest you can sell at: {peso(hp.lowestPriceMinor)}</>}
            </div>
            {hereCanPrice && hp?.locationPriceMinor != null && !here.useMain && (
              <button type="button" className="btn btn-outline-primary mt-2" onClick={() => setHere({ ...here, useMain: true })}>Use the price for all stores</button>
            )}
            {here.useMain && <div className="small mt-2" role="status">On Save, {homeName} goes back to the price for all stores.</div>}
          </div>
          <div className="col-sm-6">
            <div className="here-stock">
              <span>Stock at {homeName}</span>
              <strong>{ed.trackStock === false ? "Not counted" : qty(ed, ed.availableQuantity)}</strong>
            </div>
            <div className="small text-muted mt-1 mb-2">Change stock with Stock in, Count or Inventory.</div>
            {storeMode && (
              <>
                <label className="form-label" htmlFor="hereReorder">Tell me it is low at</label>
                <WholeInput id="hereReorder" placeholder="0" value={here.reorder} onChange={(v) => setHere({ ...here, reorder: v })} aria-describedby="hereReorder-help" />
                <div id="hereReorder-help" className="small text-muted mt-1">Shows Low when {homeName} has this many or fewer. 0 = never.</div>
              </>
            )}
          </div>
        </div>
        {(storeMode || ed.photoKey) && <PhotoPicker photoKey={ed.photoKey} value={photo} onChange={setPhoto} disabled={saving || !storeMode} />}
      </section>
      {storeMode && (
        <section className="prod-sec">
          <div><ScopeTag scope="business" /></div>
          <label htmlFor="hereName" className="form-label d-block">Rice name</label>
          <input id="hereName" className="form-control" required maxLength={120} value={here.name} onChange={(e) => setHere({ ...here, name: e.target.value })} aria-describedby="hereName-help" />
          <div id="hereName-help" className="small text-muted mt-1">The new name shows at every store and on receipts.</div>
        </section>
      )}
      <section className="prod-sec" aria-labelledby="prod-same-title">
        <h6 id="prod-same-title" className="prod-sec-title"><i className="bi bi-lock-fill me-2" aria-hidden="true"></i>Same at every store</h6>
        <dl className="prod-facts">
          <div><dt>Group</dt><dd>{ed.category?.name ?? "No group"}</dd></div>
          {sizeOf(ed) && <div><dt>Size</dt><dd>{sizeOf(ed)}</dd></div>}
          {ed.soldByWeight && <div><dt>Sold</dt><dd>Per kilo</dd></div>}
          {typeof ed.costMinor === "number" && <div><dt>Cost</dt><dd>{peso(ed.costMinor)}</dd></div>}
          <div><dt>Code</dt><dd>{ed.sku}</dd></div>
        </dl>
        <p className="small text-muted mb-0">Only the owner changes these{storeMode ? "" : hereCanPrice ? ", the name and the picture" : " and the price"}.</p>
      </section>
    </>
  );

  const ownerBody = !storeEdit && (
    <>
      {/* A product is the same rice at every store (2026-11-21: say so, so nobody thinks it changes one store only). */}
      <ScopeTag scope="business" />
      {locked && (
        <div className="alert alert-secondary d-flex gap-2 align-items-start py-2 mb-3" role="note">
          <i className="bi bi-lock-fill mt-1" aria-hidden="true"></i>
          <div>{viewOnly
            ? "You can look, not change. Only the owner or a manager changes products."
            : "You can change the picture. Only the owner changes the rest, because it changes every store."}</div>
        </div>
      )}
      <section className="prod-sec" aria-labelledby="prod-s1">
        <h6 id="prod-s1" className="prod-sec-title"><span className="prod-step">1</span>Name and picture</h6>
        <fieldset disabled={locked}>
          <div className="mb-3">
            <label htmlFor="products-name" className="form-label">Rice name *</label>
            <input id="products-name" className="form-control" required maxLength={120} placeholder="e.g. Sinandomeng 25 kg" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="mb-3">
            <label className="form-label" htmlFor="products-group">Group</label>
            {creatingCategory && !ed ? (
              <div className="input-group">
                <input id="products-group" className="form-control" autoFocus required maxLength={80} placeholder="New group name" value={form.categoryName} onChange={(e) => setForm({ ...form, categoryName: e.target.value })} />
                <button type="button" className="btn btn-outline-secondary" onClick={() => { setCreatingCategory(false); setForm({ ...form, categoryName: "" }); }}>Choose one</button>
              </div>
            ) : (
              <>
                <select id="products-group" className="form-select" value={form.categorySlug} onChange={(e) => setForm({ ...form, categorySlug: e.target.value })}>
                  <option value="">No group</option>
                  {categories.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
                </select>
                {!ed && <button type="button" className="btn btn-link px-0" onClick={() => { setCreatingCategory(true); setForm({ ...form, categorySlug: "", categoryName: "" }); }}>+ Make a new group</button>}
              </>
            )}
          </div>
        </fieldset>
        <PhotoPicker photoKey={ed?.photoKey} value={photo} onChange={setPhoto} disabled={saving || viewOnly} />
      </section>

      <section className="prod-sec" aria-labelledby="prod-s2">
        <h6 id="prod-s2" className="prod-sec-title"><span className="prod-step">2</span>Price and cost</h6>
        <div className="row g-3">
          <fieldset className="col-sm-6" disabled={priceLocked}>
            <label className="form-label" htmlFor="productSellingPrice">Selling price (₱) {form.soldByWeight ? "per kilo" : "each"} *</label>
            <PesoInput id="productSellingPrice" required value={form.priceMinor} onChange={(v) => setForm({ ...form, priceMinor: v })} placeholder="0.00" aria-describedby="productSellingPrice-help" />
            <small id="productSellingPrice-help" className="text-muted d-block mt-1">For all stores. A store with its own price on Store prices uses that one.</small>
          </fieldset>
          {hasCost && (
            <fieldset className="col-sm-6" disabled={locked}>
              <label className="form-label" htmlFor="productUnitCost">Cost (₱) {form.soldByWeight ? "per kilo" : "each"}</label>
              <PesoInput id="productUnitCost" value={form.costMinor} onChange={(v) => setForm({ ...form, costMinor: v })} placeholder="0.00" aria-describedby="productUnitCost-help" />
              <small id="productUnitCost-help" className="text-muted d-block mt-1">What you pay for it. Stock in keeps this up to date.</small>
            </fieldset>
          )}
        </div>
        {ed && <div className="mt-2"><PriceHistoryList productId={ed.id} /></div>}
      </section>

      <section className="prod-sec" aria-labelledby="prod-s3">
        <h6 id="prod-s3" className="prod-sec-title"><span className="prod-step">3</span>Size and how it sells</h6>
        <fieldset disabled={locked}>
          <div className="form-check form-switch prod-switch">
            <input className="form-check-input" type="checkbox" role="switch" id="enableStockConversion" checked={form.conversionEnabled}
              onChange={(e) => setForm({ ...form, conversionEnabled: e.target.checked, ...(e.target.checked ? { stockConversionFamily: form.stockConversionFamily || "Bigas" } : { packageSize: "", stockConversionFamily: "" }) })} />
            <label className="form-check-label" htmlFor="enableStockConversion">It is a sack or pack with a weight <span className="text-muted d-block small">Needed for Resack and for selling per kilo.</span></label>
          </div>
          {form.conversionEnabled && (
            <div className="row g-3 mb-3">
              <div className="col-sm-7">
                <label className="form-label" htmlFor="packageSize">Weight of one sack or pack</label>
                <div className="input-group">
                  <input id="packageSize" className="form-control" type="number" inputMode="decimal" min={form.packageUnit === "kg" || form.packageUnit === "L" ? "0.001" : "1"} step={form.packageUnit === "kg" || form.packageUnit === "L" ? "0.001" : "1"} value={form.packageSize} onChange={(e) => setForm({ ...form, packageSize: e.target.value })} placeholder="e.g. 25" />
                  <select className="form-select" style={{ maxWidth: "7rem" }} aria-label="Weight unit" value={form.packageUnit} onChange={(e) => setForm({ ...form, packageUnit: e.target.value, packageSize: "" })}>
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="L">L</option>
                    <option value="ml">ml</option>
                    <option value="each">each</option>
                  </select>
                </div>
              </div>
              <div className="col-sm-5">
                <label className="form-label" htmlFor="stockConversionFamily">Resack family *</label>
                <input id="stockConversionFamily" className="form-control" required maxLength={60} value={form.stockConversionFamily} onChange={(e) => setForm({ ...form, stockConversionFamily: e.target.value })} aria-describedby="stockConversionFamily-help" />
                <small id="stockConversionFamily-help" className="text-muted d-block mt-1">Keep “Bigas” for rice.</small>
              </div>
            </div>
          )}
          <div className="form-check form-switch prod-switch">
            <input className="form-check-input" type="checkbox" role="switch" id="soldByWeight" checked={form.soldByWeight} onChange={(e) => setForm({ ...form, soldByWeight: e.target.checked })} />
            <label className="form-check-label" htmlFor="soldByWeight">Loose rice, sold per kilo <span className="text-muted d-block small">Its price and cost are per kilo.</span></label>
          </div>
          {ed && canSellPerKilo(ed) && <AlsoPerKilo sack={ed} onChanged={() => void load()} />}
          {!ed && !form.soldByWeight && canSetUp && (
            <div className="border rounded p-2 mb-2" style={{ background: "var(--bs-tertiary-bg, #f7f5f2)" }}>
              <div className="form-check form-switch mb-1">
                <input className="form-check-input" type="checkbox" role="switch" id="newAlsoPerKilo" checked={form.alsoPerKilo && newSackCanKilo} disabled={!newSackCanKilo}
                  onChange={(e) => setForm({ ...form, alsoPerKilo: e.target.checked })} />
                <label className="form-check-label fw-semibold" htmlFor="newAlsoPerKilo">Also sell per kilo</label>
              </div>
              <div className="small text-muted">
                {newSackCanKilo
                  ? "On: when you save, a kilo item for this rice is added in the 1 kg group, priced at the sack price ÷ kilos, rounded up, + ₱2."
                  : "For sacks of 10 kg or more. Turn on the weight switch above and type the weight, for example 25 kg."}
              </div>
            </div>
          )}
          {ed?.soldByWeight && <RackSacks kilo={ed} onChanged={() => void load()} />}
          {!ed && form.soldByWeight && <div className="small text-muted mb-2">After saving, open this rice again to choose the sacks that go in its rack.</div>}
        </fieldset>
      </section>

      <section className="prod-sec" aria-labelledby="prod-s4">
        <h6 id="prod-s4" className="prod-sec-title"><span className="prod-step">4</span>Stock</h6>
        <div className="row g-3">
          {ed ? (
            <div className="col-sm-6">
              <div className="here-stock"><span>Stock, all stores</span><strong>{ed.trackStock === false ? "Not counted" : qty(ed, ed.availableQuantity)}</strong></div>
              <div className="small text-muted mt-1">Change stock with Stock in, Move stock, Count or Inventory.</div>
            </div>
          ) : (
            <fieldset className="col-sm-6" disabled={locked}>
              <label className="form-label" htmlFor="openingStock">How many do you have now</label>
              <WholeInput id="openingStock" value={form.stock} onChange={(v) => setForm({ ...form, stock: v })} placeholder="0" />
              {places.length > 1 && !canSetUp && homeId ? (
                <div className="small text-muted mt-2">Goes to your store: {homeName}</div>
              ) : places.length > 1 && (
                <>
                  <label className="form-label mt-2 mb-1" htmlFor="openingStockAt">At which store</label>
                  <select id="openingStockAt" className="form-select" value={stockAt || mainPlace?.id || ""} onChange={(e) => setStockAt(e.target.value)}>
                    {places.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isDefault ? " (main)" : ""}</option>)}
                  </select>
                </>
              )}
            </fieldset>
          )}
          <fieldset className="col-sm-6" disabled={priceLocked}>
            <label className="form-label" htmlFor="reorderAtMain">Tell me it is low at{mainPlace ? ` (${mainPlace.name})` : ""}</label>
            <WholeInput id="reorderAtMain" placeholder="0" value={form.reorderThreshold} onChange={(v) => setForm({ ...form, reorderThreshold: v })} aria-describedby="reorderAtMain-help" />
            <div id="reorderAtMain-help" className="small text-muted mt-1">Shows Low at this many or fewer. Other stores: Inventory.</div>
          </fieldset>
        </div>
        <fieldset disabled={locked} className="mt-3">
          <div className="form-check form-switch prod-switch">
            <input className="form-check-input" type="checkbox" role="switch" id="trackStock" checked={form.trackStock} onChange={(e) => setForm({ ...form, trackStock: e.target.checked })} />
            <label className="form-check-label" htmlFor="trackStock">Count its stock <span className="text-muted d-block small">Off: it sells at any time and its stock is not counted.</span></label>
            {!form.trackStock && form.conversionEnabled && <div className="text-danger">Rice with a sack weight must keep this on. Resack works from the shelf.</div>}
          </div>
        </fieldset>
      </section>

      <details className="shared-details">
        <summary>More details (rarely needed)</summary>
        <fieldset disabled={locked}>
          <div className="mb-3">
            <label htmlFor="products-sku" className="form-label">Code (SKU)</label>
            <input id="products-sku" className="form-control" maxLength={64} value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} aria-describedby="products-sku-help" />
            <small id="products-sku-help" className="text-muted d-block mt-1">{ed ? "Shown on labels." : "Leave empty and the app makes one."}</small>
          </div>
          <div className="row g-3 mb-3">
            <div className="col-6">
              <label htmlFor="products-barcode" className="form-label">Barcode</label>
              <input id="products-barcode" className="form-control" inputMode="numeric" placeholder="e.g. 4801234567890" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
            </div>
            <div className="col-6">
              <label htmlFor="products-unit" className="form-label">Unit word</label>
              <input id="products-unit" className="form-control" placeholder="sako · pack · kilo" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </div>
          </div>
          <div className="mb-3">
            <label htmlFor="products-description" className="form-label">Description</label>
            <textarea id="products-description" className="form-control" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="form-check form-switch prod-switch">
            <input className="form-check-input" type="checkbox" role="switch" id="taxExempt" checked={form.taxExempt} onChange={(e) => setForm({ ...form, taxExempt: e.target.checked })} />
            <label className="form-check-label" htmlFor="taxExempt">No VAT on this product <span className="text-muted d-block small">Reported as non-VAT sales on the BIR slip.</span></label>
          </div>
          <div className="form-check form-switch prod-switch">
            <input className="form-check-input" type="checkbox" role="switch" id="featured" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} />
            <label className="form-check-label" htmlFor="featured">Featured <span className="text-muted d-block small">Shown first in the online shop.</span></label>
          </div>
          <div className="mb-3">
            <label htmlFor="products-tags" className="form-label">Tags</label>
            <input id="products-tags" className="form-control" placeholder="new, best seller" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} aria-describedby="products-tags-help" />
            <small id="products-tags-help" className="text-muted d-block mt-1">Words with a comma between them.</small>
          </div>
          {ed && (
            <div className="mb-2">
              <span className="form-label d-block">Goes well with / A better one</span>
              <div className="d-flex gap-2">
                <select className="form-select" multiple size={4} aria-label="Goes well with" value={form.related} onChange={(e) => setForm({ ...form, related: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {products.filter((x) => x.id !== ed.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <select className="form-select" multiple size={4} aria-label="A better one" value={form.upsell} onChange={(e) => setForm({ ...form, upsell: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {products.filter((x) => x.id !== ed.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
              <small className="text-muted d-block mt-1">For the online shop.</small>
            </div>
          )}
        </fieldset>
        {ed && canSetUp && (
          <button type="button" className="btn btn-outline-primary w-100 mt-2" onClick={() => { setOptionsFor(ed); closeModal(); }}>
            <i className="bi bi-sliders me-2" aria-hidden="true"></i>Sizes and add-ons
          </button>
        )}
      </details>
    </>
  );

  return (
    <div className="prod-screen">
      <div className="prod-top">
        <h1 className="h4 mb-0">Products <span className="prod-count">{sellingCount} on sale</span></h1>
        <div className="prod-top-btns">
          {picking ? (
            <>
              <button type="button" className="btn btn-outline-dark" onClick={() => { setPicking(false); setSelected([]); }}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={selected.length === 0} onClick={() => setLabelOpen(true)}>
                <i className="bi bi-printer me-2" aria-hidden="true"></i>Print {selected.length} {selected.length === 1 ? "label" : "labels"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-outline-primary" onClick={() => setPicking(true)}><i className="bi bi-tags me-2" aria-hidden="true"></i>Print labels</button>
              {canSetUp && <button type="button" className="btn btn-outline-primary" onClick={() => setSeveral(true)}><i className="bi bi-table me-2" aria-hidden="true"></i>Add several</button>}
              {canAdd && <button type="button" className="btn btn-primary" onClick={openCreate}><i className="bi bi-plus-lg me-2" aria-hidden="true"></i>New rice</button>}
            </>
          )}
        </div>
      </div>
      <p className="prod-can" role="note"><i className="bi bi-info-circle-fill" aria-hidden="true"></i><span>{picking ? "Tick the rice you want labels for, then tap Print." : canLine}</span></p>
      {error && !modal.open && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {several && <AddSeveralProducts onClose={() => setSeveral(false)} onDone={load} />}

      {/* What needs a look: each tile is a filter. */}
      <div className="prod-tiles" role="group" aria-label="Show">
        <button type="button" className={`prod-tile prod-tile-all${viewNow === "all" ? " is-on" : ""}`} aria-pressed={viewNow === "all"} onClick={() => setView("all")}>
          <span className="prod-tile-num">{products.length}</span><span className="prod-tile-word">All rice</span>
        </button>
        {hasCost && belowCount > 0 && (
          <button type="button" className={`prod-tile prod-tile-below${viewNow === "below" ? " is-on" : ""}`} aria-pressed={viewNow === "below"} onClick={() => setView("below")}>
            <span className="prod-tile-num">{belowCount}</span><span className="prod-tile-word"><i className="bi bi-exclamation-triangle-fill" aria-hidden="true"></i>Sells below cost</span>
          </button>
        )}
        {checkCount > 0 && (
          <button type="button" className={`prod-tile prod-tile-check${viewNow === "check" ? " is-on" : ""}`} aria-pressed={viewNow === "check"} onClick={() => setView("check")}>
            <span className="prod-tile-num">{checkCount}</span><span className="prod-tile-word"><i className="bi bi-person-check-fill" aria-hidden="true"></i>Added by staff, to check</span>
          </button>
        )}
        {hiddenCount > 0 && (
          <button type="button" className={`prod-tile prod-tile-hidden${viewNow === "hidden" ? " is-on" : ""}`} aria-pressed={viewNow === "hidden"} onClick={() => setView("hidden")}>
            <span className="prod-tile-num">{hiddenCount}</span><span className="prod-tile-word"><i className="bi bi-eye-slash-fill" aria-hidden="true"></i>Hidden from sale</span>
          </button>
        )}
      </div>

      <div className="prod-tools">
        <div className="prod-search">
          <i className="bi bi-search" aria-hidden="true"></i>
          <input className="form-control" type="search" aria-label="Find a rice" placeholder="Find a rice by name or code" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="form-select prod-sort" aria-label="Order" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="name">Name, A to Z</option>
          <option value="price">Price, low first</option>
          <option value="stock">Stock, most first</option>
          <option value="newest">Newest first</option>
        </select>
        <div className="prod-made"><AddedAtFilter id="products-made-at" value={madeAt} onChange={setMadeAt} stores={addedStores(products)} /></div>
      </div>
      {groups.length > 1 && (
        <div className="prod-groups" role="group" aria-label="Group">
          <button type="button" className={`btn ${groupNow === "" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={groupNow === ""} onClick={() => setGroup("")}>All groups</button>
          {groups.map((g) => (
            <button key={g.id} type="button" className={`btn ${groupNow === g.id ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={groupNow === g.id} onClick={() => setGroup(g.id)}>
              {g.name} <span className="prod-group-n">{g.n}</span>
            </button>
          ))}
        </div>
      )}

      {loading && products.length === 0 ? (
        <p className="prod-empty" role="status">Loading the rice…</p>
      ) : products.length === 0 ? (
        <div className="prod-empty">
          <p className="mb-2">{search ? `No rice found for “${search}”.` : "No rice yet."}</p>
          {search ? <button type="button" className="btn btn-outline-dark" onClick={() => setSearch("")}>Clear the search</button>
            : canAdd && <button type="button" className="btn btn-primary" onClick={openCreate}><i className="bi bi-plus-lg me-2" aria-hidden="true"></i>Add your first rice</button>}
        </div>
      ) : shown.length === 0 ? (
        <div className="prod-empty">
          <p className="mb-2">No rice matches these choices.</p>
          <button type="button" className="btn btn-outline-dark" onClick={() => { setView("all"); setGroup(""); setMadeAt(""); }}>Show all rice</button>
        </div>
      ) : (
        <>
          {picking && (
            <label className="prod-pick-all">
              <input type="checkbox" className="form-check-input" checked={shown.every((p) => selected.includes(p.id))}
                onChange={(e) => setSelected(e.target.checked ? shown.map((p) => p.id) : [])} />
              <span>Tick all {shown.length}</span>
            </label>
          )}
          <ul className="prod-list" aria-label="Rice">
            {shown.map((p) => {
              const own = hereMode && herePrices[p.id]?.locationPriceMinor != null;
              const below = isBelow(p);
              return (
                <li key={p.id} className={`prod-row${p.isActive ? "" : " is-hidden"}${below ? " is-below" : ""}${picking ? " is-picking" : ""}`}>
                  {picking && (
                    <input type="checkbox" className="form-check-input prod-tick" aria-label={`Label for ${p.name}`} checked={selected.includes(p.id)}
                      onChange={(e) => setSelected((s) => (e.target.checked ? [...s, p.id] : s.filter((id) => id !== p.id)))} />
                  )}
                  <div className="prod-pic"><ProductPhoto photoKey={p.photoKey} size="thumb" /></div>
                  <div className="prod-main">
                    <span className="prod-name">{p.name}</span>
                    <span className="prod-tags">
                      {sizeOf(p) && <span className="prod-tag">{sizeOf(p)}</span>}
                      {p.category && <span className="prod-tag prod-tag-group">{p.category.name}</span>}
                      {p.soldByWeight && <span className="prod-tag">Per kilo</span>}
                      {p.kiloItem?.isActive && <span className="prod-tag prod-tag-ok" title={`Also sold per kilo: ${p.kiloItem.name}`}>+ per kilo</span>}
                      {p.soldByWeight && (p.rackSackIds?.length ?? 0) + (p.kiloOfId ? 1 : 0) > 1 && <span className="prod-tag prod-tag-ok">Rack · {(p.rackSackIds?.length ?? 0) + (p.kiloOfId ? 1 : 0)} rice</span>}
                      {p.trackStock === false && <span className="prod-tag prod-tag-warn">Stock not counted</span>}
                      {below && <span className="prod-tag prod-tag-bad"><i className="bi bi-exclamation-triangle-fill" aria-hidden="true"></i>Below cost</span>}
                      {isLow(p) && <span className="prod-tag prod-tag-warn"><i className="bi bi-arrow-down-circle-fill" aria-hidden="true"></i>Low</span>}
                      {!p.isActive && <span className="prod-tag prod-tag-off"><i className="bi bi-eye-slash-fill" aria-hidden="true"></i>Hidden</span>}
                      {p.toCheck && <span className="prod-tag prod-tag-warn">To check</span>}
                      {p.taxExempt && <span className="prod-tag">No VAT</span>}
                    </span>
                    <span className="added-row"><AddedLine tag={p} /></span>
                    {p.toCheck && canSetUp && (
                      <button type="button" className="btn btn-outline-dark btn-looks-right mt-1" disabled={checking === p.id} aria-label={`${p.name}: cost and price look right`} onClick={() => void looksRight(p)}>
                        <i className="bi bi-check2 me-1" aria-hidden="true"></i>{checking === p.id ? "Saving…" : "Looks right"}
                      </button>
                    )}
                  </div>
                  <div className="prod-num prod-price">
                    <span className="prod-num-word">{priceWord}</span>
                    <strong>{peso(shownPrice(p))}</strong>
                    {own && <span className="prod-num-note">Your own price</span>}
                    {typeof p.costMinor === "number" && <span className="prod-num-note">Cost {peso(p.costMinor)}</span>}
                  </div>
                  <div className="prod-num prod-stock">
                    <span className="prod-num-word">{stockWord}</span>
                    <strong>{p.trackStock === false ? "—" : qty(p, p.availableQuantity)}</strong>
                    {p.quantityReserved > 0 && <span className="prod-num-note">{qty(p, p.quantityReserved)} held for orders</span>}
                  </div>
                  <div className="prod-act">
                    <button type="button" className="btn btn-outline-primary" aria-label={`${rowAction.word} ${p.name}`} onClick={() => openEdit(p)}>
                      <i className={`bi ${rowAction.icon} me-2`} aria-hidden="true"></i>{rowAction.word}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* New rice / the rice window */}
      {modal.open && (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="prod-modal-title">
            <div className="modal-dialog modal-dialog-scrollable prod-dialog">
              <div className="modal-content">
                <form onSubmit={save} className="prod-form">
                  <div className="modal-header">
                    <h5 className="modal-title" id="prod-modal-title">{modalTitle}</h5>
                    <button type="button" className="btn-close" aria-label="Close" onClick={closeModal}></button>
                  </div>
                  <div className="modal-body">
                    {storeBody}
                    {ownerBody}
                    {error && <div className="alert alert-danger py-2 mt-3 mb-0" role="alert">{error}</div>}
                  </div>
                  <div className="modal-footer">
                    {ed && canSetUp && (
                      <button type="button" className={`btn me-auto ${ed.isActive ? "btn-outline-danger" : "btn-outline-primary"}`} disabled={saving} onClick={() => void toggleActive(ed)}>
                        <i className={`bi ${ed.isActive ? "bi-eye-slash" : "bi-eye"} me-2`} aria-hidden="true"></i>{ed.isActive ? "Hide from sale" : "Put back on sale"}
                      </button>
                    )}
                    <button type="button" className="btn btn-outline-dark" onClick={closeModal}>{(storeEdit ? hereMaySave : !viewOnly) ? "Cancel" : "Close"}</button>
                    {(storeEdit ? hereMaySave : !viewOnly) && (
                      <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : ed ? "Save" : "Add this rice"}</button>
                    )}
                  </div>
                </form>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
      {labelOpen && <LabelSheet productIds={selected} onClose={() => { setLabelOpen(false); setPicking(false); setSelected([]); }} />}
      {optionsFor && (
        <VariantEditor
          product={optionsFor as unknown as Parameters<typeof VariantEditor>[0]["product"]}
          onClose={() => setOptionsFor(null)}
          onChanged={() => { setOptionsFor(null); void load(); }}
        />
      )}
    </div>
  );
}
