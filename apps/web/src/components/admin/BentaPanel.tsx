"use client";

// Rice Ops M5 — Benta: the counter sale on the staff member's own phone.
//   1. Tap the rice. A sack sells by piece; loose rice asks "Kilos or pesos?" and opens the pad.
//      ₱100 at ₱52/kg shows 1.923 kg before it goes in the cart.
//   2. Each tile shows stock at every location; "Take from …" serves a line from another one.
//   3. Payment: Cash (pad → change), GCash (reference) or Credit (customer + their signature).
//   4. From a paper slip: encode a paper slip — its number, the real time, a photo, staff signs.
//   New item: a rice that isn't in the system yet, with what is on hand now.
// One idempotency key per sale, kept until it succeeds: a double-tap is one sale.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminStoreId } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import { newSaleKey } from "../../lib/saleKey";
import { photoToJpeg } from "../../lib/photo";
import NumPad from "./NumPad";
import SignaturePad from "./SignaturePad";
import QuickCount from "./QuickCount";
import StoreBar from "./StoreBar";
import PriceReason, { reasonOk } from "./PriceReason";
import LocationPicker from "../LocationPicker";
import { PesoInput } from "../NumberBoxes";
import { buildText, openTextApp } from "../../lib/text-message";
import { printSlip } from "../../lib/slip-print";
import { getPrinterSettings } from "../../lib/printer-settings";
import { creditStatusWords } from "../../lib/credit-status";
import { peso, kg } from "../../lib/number-format";
import { useMediaQuery, WIDE } from "../../lib/use-media-query";
import { quickCash } from "../../lib/quick-cash";
import Steps from "./Steps";
import ProductFinder from "./ProductFinder";
import { noteUse } from "../../lib/product-find";

interface Loc { id: string; name: string; code: string | null; type: string }
interface Item {
  id: string; name: string; loose: boolean; gramsPerUnit: number | null; priceMinor: number; forReview: boolean;
  stock: Record<string, number>; tracked: boolean;
}
// Shape of GET /admin/customers (flat: name/phone on the row).
interface Customer { id: string; name: string | null; phone: string | null; creditApproved: boolean; creditLimitMinor: number; creditUnlimited?: boolean; creditStatus?: string; creditAvailableMinor?: number | null; creditBalanceMinor: number }
type Mode = "PIECE" | "KILO" | "PESO";
interface CartLine { productId: string; mode: Mode; value: string; sourceLocationId: string | null; /** Manual price (centavos per piece / per kilo), only when it differs from the list price. */ price?: number; reason?: string }
interface Held { id: string; label: string; at: number; locationId: string; cart: CartLine[] }
type Pay = "cash" | "gcash" | "maya" | "bank" | "split" | "utang";
const PAY_LABEL: Record<Pay, string> = { cash: "Cash", gcash: "GCash", maya: "Maya", bank: "Bank transfer", split: "Split", utang: "Credit" };
interface SplitPart { method: "cash" | "gcash" | "maya" | "bank"; amount: string; reference: string }
const needsRef = (m: Pay) => m === "gcash" || m === "maya" || m === "bank";
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const toMinor = (s: string) => Math.round(Number(s || "0") * 100);

/** What a cart line comes to — the same arithmetic the server does (domain/selling.ts). */
function lineOf(item: Item | undefined, l: CartLine): { grams: number | null; units: number; totalMinor: number } {
  if (!item) return { grams: null, units: 0, totalMinor: 0 };
  const unit = l.price ?? item.priceMinor;
  if (l.mode === "PESO") {
    const amt = toMinor(l.value);
    const g = amt > 0 ? Math.floor((amt * 1000) / unit) : 0;
    return { grams: g, units: g, totalMinor: g > 0 ? amt : 0 };
  }
  if (l.mode === "KILO") {
    const g = Math.round(Number(l.value || "0") * 1000);
    const scaled = g * unit;
    return { grams: g, units: g, totalMinor: Math.floor(scaled / 1000) + (scaled % 1000 >= 500 ? 1 : 0) };
  }
  const n = Number(l.value || "0");
  return { grams: item.gramsPerUnit ? item.gramsPerUnit * n : null, units: n, totalMinor: n * unit };
}

/** Held sales ("Hold"): parked on this phone so staff can serve the next customer and come back. */
const holdKey = () => { try { return `rice-benta-holds:${getAdminStoreId() ?? ""}`; } catch { return "rice-benta-holds"; } };
function loadHolds(): Held[] {
  try { const v = JSON.parse(window.localStorage.getItem(holdKey()) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveHolds(h: Held[]) { try { window.localStorage.setItem(holdKey(), JSON.stringify(h)); } catch { /* convenience only */ } }

/** The cart is kept on this phone while staff look at another tab, so nothing is retyped. */
const cartKey = () => {
  try { return `rice-benta-cart:${getAdminStoreId() ?? ""}`; } catch { return "rice-benta-cart"; }
};
function savedCart(): { locationId: string; cart: CartLine[]; key: string | null } | null {
  try {
    const raw = window.sessionStorage.getItem(cartKey());
    const v = raw ? JSON.parse(raw) : null;
    return v && Array.isArray(v.cart) && typeof v.locationId === "string" ? v : null;
  } catch { return null; }
}

export default function BentaPanel() {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [locationId, setLocationId] = useState("");
  const [homeLocationId, setHomeLocationId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [cleared, setCleared] = useState(0); // bumps to empty the search after an item goes in
  const [cart, setCart] = useState<CartLine[]>(() => savedCart()?.cart ?? []);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null); // which cart line is being edited (null = adding a new one)
  const [holds, setHolds] = useState<Held[]>(() => loadHolds());
  const [showHeld, setShowHeld] = useState(false);
  const [step, setStep] = useState<"pick" | "pay" | "done">("pick");
  const [pay, setPay] = useState<Pay | null>(null);
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  const [parts, setParts] = useState<SplitPart[]>([{ method: "cash", amount: "", reference: "" }, { method: "gcash", amount: "", reference: "" }]);
  const [customerId, setCustomerId] = useState("");
  const [customerSig, setCustomerSig] = useState<string | null>(null);
  const [newCust, setNewCust] = useState(false);       // the "New customer" mini form in the credit step
  const [paper, setPaper] = useState(false);
  const [slipNo, setSlipNo] = useState("");
  const [slipTime, setSlipTime] = useState("");
  const [slipPhoto, setSlipPhoto] = useState<string | null>(null);
  const [staffSig, setStaffSig] = useState<string | null>(null);
  const [last, setLast] = useState<{ status: "COMPLETED" | "WAITING_OWNER" | "DECLINED"; smsStatus: string | null; orderNumber: string; totalMinor: number; changeMinor: number; lines: { name: string; soldBy: string | null; quantity: number; grams: number | null; lineTotalMinor: number }[]; releases: { docNumber: string }[]; zeroCheck: { productId: string; name: string }[]; belowCost?: string[] } | null>(null);
  const [checking, setChecking] = useState<{ productId: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const keyRef = useRef<string | null>(savedCart()?.key ?? null);
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null);
  const [shiftRequired, setShiftRequired] = useState(true); // the owner can switch this off in Settings
  const [storeName, setStoreName] = useState("");
  // What the done screen needs to text the customer, kept after the cart is cleared.
  const [textInfo, setTextInfo] = useState<{ customerId: string; name: string | null; phone: string | null; balanceAfterMinor: number } | null>(null);
  const [textPhone, setTextPhone] = useState("");
  const [priceCustomer, setPriceCustomer] = useState(""); // a customer picked at the counter: their special prices apply
  const [specialCount, setSpecialCount] = useState(0);
  // Less used choices stay folded away until asked for, so the screen shows one clear next step.
  const [morePay, setMorePay] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [fromOpen, setFromOpen] = useState(false);

  const loadCatalog = useCallback(async (loc?: string) => {
    const q = loc ? `?locationId=${encodeURIComponent(loc)}` : "";
    const res = await fetch(`${API_URL}/admin/benta/catalog${q}`, { headers: adminHeaders() });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok || !d) { setError(errText(d, "Could not load the products")); return; }
    setLocations((d.locations as Loc[]).filter((l) => (l as { type?: string }).type !== "BUFFER"));
    setItems(d.products as Item[]);
    setLocationId((d.location as Loc).id);
  }, []);

  // Choosing a customer at the start of a sale puts their special prices on the product buttons.
  const pickPriceCustomer = async (id: string) => {
    setPriceCustomer(id); setCustomerId(id); setCustomerSig(null); setSpecialCount(0);
    await loadCatalog(locationId);
    if (!id) return;
    const res = await fetch(`${API_URL}/admin/benta/customer-prices?customerId=${encodeURIComponent(id)}`, { headers: adminHeaders() });
    const d = (await res.json().catch(() => null)) as { prices?: { productId: string; priceMinor: number }[] } | null;
    const m = new Map((d?.prices ?? []).map((x) => [x.productId, x.priceMinor]));
    setItems((prev) => prev.map((i) => (m.has(i.id) ? { ...i, priceMinor: m.get(i.id)! } : i)));
    setSpecialCount(m.size);
  };

  useEffect(() => {
    (async () => {
      const [me, cs] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      setHomeLocationId(me?.homeLocationId ?? null);
      fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => setStoreName(d?.store?.name ?? "")).catch(() => {});
      setCustomers(((cs?.customers ?? []) as Customer[]));
      // A kept cart belongs to the location it was started at.
      const kept = savedCart();
      await loadCatalog(me?.homeLocationId ?? (kept?.cart.length ? kept.locationId : undefined));
    })().catch(() => setError("Could not load"));
  }, [loadCatalog]);

  useEffect(() => {
    try {
      if (cart.length === 0) window.sessionStorage.removeItem(cartKey());
      else if (locationId) window.sessionStorage.setItem(cartKey(), JSON.stringify({ locationId, cart, key: keyRef.current }));
    } catch { /* convenience only */ }
  }, [cart, locationId]);

  const checkDrawer = useCallback(async () => {
    const r = await fetch(`${API_URL}/admin/registers/current`, { headers: adminHeaders() }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    setDrawerOpen(r ? !!r.session : null);
    setShiftRequired(r?.required !== false);
  }, []);
  useEffect(() => { if (pay === "cash") void checkDrawer(); }, [pay, checkDrawer]);

  const receiptSlip = (l: NonNullable<typeof last>) => ({
    storeName: storeName || "SAM STORE", title: "SALES RECEIPT", reference: l.orderNumber, when: new Date().toLocaleString("en-PH"),
    rows: l.lines.map((x) => ({ name: x.name, qty: `${x.soldBy === "PIECE" || !x.grams ? `${x.quantity}` : kg(x.grams)}  ${peso(x.lineTotalMinor)}` })),
    totals: [{ label: "TOTAL", value: peso(l.totalMinor) }, ...(l.changeMinor > 0 ? [{ label: "Change", value: peso(l.changeMinor) }] : [])],
    footer: l.status === "WAITING_OWNER" ? "Waiting for owner approval" : "Salamat po!",
  });
  // "Print the receipt right after each sale" (Printer settings on this phone): once per sale.
  const printedFor = useRef<string | null>(null);
  useEffect(() => {
    if (step !== "done" || !last || last.status === "DECLINED" || printedFor.current === last.orderNumber) return;
    printedFor.current = last.orderNumber;
    if (getPrinterSettings().autoPrint) printSlip(receiptSlip(last));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, last]);

  const wide = useMediaQuery(WIDE);
  const startEdit = (l: CartLine, idx: number | null) => {
    setEditing(l); setEditIdx(idx);
    setPriceOpen(l.price !== undefined); setFromOpen(!!l.sourceLocationId);
  };
  /** How much of a product is already in this sale: pieces, or one per kilo/peso line. */
  const inSale = (productId: string) => cart.filter((l) => l.productId === productId).reduce((n, l) => n + (l.mode === "PIECE" ? Number(l.value) || 0 : 1), 0);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const here = locations.find((l) => l.id === locationId);
  const code = (id: string) => { const l = locations.find((x) => x.id === id); return l?.code ?? l?.name ?? "?"; };
  const computed = cart.map((l) => lineOf(byId.get(l.productId), l));
  const total = computed.reduce((s, c) => s + c.totalMinor, 0);
  const change = pay === "cash" && tendered ? toMinor(tendered) - total : 0;
  const customer = customers.find((c) => c.id === customerId);
  // A customer with a limit who would pass it must pay first (the server refuses it too).
  const overLimit = !!customer && !customer.creditUnlimited && customer.creditLimitMinor > 0 && customer.creditBalanceMinor + total > customer.creditLimitMinor;

  const reset = () => {
    keyRef.current = null;
    try { window.sessionStorage.removeItem(cartKey()); } catch { /* convenience only */ }
    if (priceCustomer) void loadCatalog(locationId);
    setPriceCustomer(""); setSpecialCount(0);
    setCart([]); setStep("pick"); setPay(null); setTendered(""); setReference(""); setParts([{ method: "cash", amount: "", reference: "" }, { method: "gcash", amount: "", reference: "" }]); setCustomerId(""); setCustomerSig(null);
    setPaper(false); setMorePay(false); setSlipNo(""); setSlipTime(""); setSlipPhoto(null); setStaffSig(null); setError(null);
  };

  const allPay = morePay || pay === "maya" || pay === "bank" || pay === "split";
  const canSubmit = total > 0 && !!pay && !busy
    && (pay !== "cash" || (!!tendered && toMinor(tendered) >= total))
    && (!needsRef(pay) || reference.trim().length >= 4)
    && (pay !== "split" || (parts.reduce((s, x) => s + toMinor(x.amount || "0"), 0) === total && parts.every((x) => toMinor(x.amount || "0") > 0 && (x.method === "cash" || x.reference.trim().length >= 4))))
    && (pay !== "utang" || (!!customer && !!customerSig && !overLimit))
    && (!paper || (!!slipNo.trim() && !!slipTime && !!slipPhoto && !!staffSig));

  const submit = async () => {
    if (!canSubmit || !pay) return;
    setBusy(true); setError(null);
    if (!keyRef.current) keyRef.current = newSaleKey();
    // Keep the key with the cart: if the answer is lost and staff come back later, a retry is still one sale.
    try { window.sessionStorage.setItem(cartKey(), JSON.stringify({ locationId, cart, key: keyRef.current })); } catch { /* convenience only */ }
    const signatures: Record<string, unknown>[] = [];
    if (pay === "utang" && customerSig) signatures.push({ signerKind: "CUSTOMER", signerName: customer?.name ?? "Customer", imagePng: customerSig });
    if (paper && staffSig && slipPhoto) signatures.push({ signerKind: "STAFF", imagePng: staffSig }, { signerKind: "SLIP_PHOTO", imagePng: slipPhoto });
    const body = {
      idempotencyKey: keyRef.current, locationId,
      lines: cart.map((l) => ({
        productId: l.productId, sourceLocationId: l.sourceLocationId ?? undefined,
        ...(l.mode === "PIECE" ? { quantity: Number(l.value) } : l.mode === "KILO" ? { kilos: l.value } : { amountMinor: toMinor(l.value) }),
        ...(l.price !== undefined && l.price !== byId.get(l.productId)?.priceMinor ? { unitPriceMinorOverride: l.price, priceOverrideReason: l.reason?.trim() } : {}),
      })),
      payment: {
        method: pay, tenderedMinor: pay === "cash" && tendered ? toMinor(tendered) : undefined, reference: needsRef(pay) ? reference.trim() : undefined,
        ...(pay === "split" ? { tenders: parts.map((x) => ({ method: x.method, amountMinor: toMinor(x.amount || "0"), reference: x.method === "cash" ? undefined : x.reference.trim() })) } : {}),
      },
      customerId: pay === "utang" ? customerId : priceCustomer || undefined,
      paperSlip: paper ? { slipNo: slipNo.trim(), occurredAt: new Date(slipTime).toISOString() } : undefined,
      signatures,
    };
    try {
      // Rice Ops M10: with no signal the sale waits on the phone and is sent later — once (same key).
      const sent = await sendStep("/admin/benta", body, `Sale ${peso(total)}`);
      if (sent.status === "queued") {
        toast("No signal — the sale is saved on this phone and will be sent when the signal is back");
        reset();
        return;
      }
      const d = sent.data as ApiBody | null;
      if (!sent.ok || !d) {
        if (/cash drawer/i.test(String(d?.message ?? ""))) setDrawerOpen(false);
        setError(errText(d, "The sale did not go through"));
        return;
      }
      setLast(d as unknown as NonNullable<typeof last>);
      setTextInfo(pay === "utang" && customer ? { customerId: customer.id, name: customer.name, phone: customer.phone, balanceAfterMinor: customer.creditBalanceMinor + total } : null);
      setTextPhone(customer?.phone ?? "");
      toast(d.status === "WAITING_OWNER" ? `Waiting for the owner: ${String(d.orderNumber)}` : `Sold: ${String(d.orderNumber)}`);
      keyRef.current = null;
      try { window.sessionStorage.removeItem(cartKey()); } catch { /* convenience only */ }
      setStep("done");
      await loadCatalog(locationId);
    } catch {
      setError("No signal — try again. The sale will not be counted twice.");
    } finally {
      setBusy(false);
    }
  };

  // ───────────── screens ─────────────

  if (step === "done" && last) {
    return (
      <div className="mx-auto" style={{ fontSize: 18, maxWidth: 520 }}>
        <Steps items={["Pick items", "Pay", "Done"]} current={2} />
        {last.status === "WAITING_OWNER" ? (
          <div className="alert alert-warning">
            <div className="h4 mb-1">Waiting for the owner</div>
            <div>{last.orderNumber} — over the credit limit. The rice is set aside; it will be handed over when the owner approves.</div>
          </div>
        ) : (
          <div className="alert alert-success">
            <div className="h4 mb-1">Sold</div>
            <div>{last.orderNumber}</div>
            {last.smsStatus === "QUEUED" && <div className="small">Sending a text to the customer.</div>}
            {last.smsStatus === "SKIPPED" && <div className="small">No text — the customer has no mobile number.</div>}
          </div>
        )}
        <ul className="list-group mb-3" style={{ fontVariantNumeric: "tabular-nums" }}>
          {last.lines.map((l, i) => (
            <li key={i} className="list-group-item d-flex justify-content-between">
              <span>{l.soldBy === "PIECE" || !l.grams ? `${l.quantity} × ` : `${kg(l.grams)} `}{l.name}</span>
              <span>{peso(l.lineTotalMinor)}</span>
            </li>
          ))}
          <li className="list-group-item d-flex justify-content-between fw-bold" style={{ fontSize: 28 }}><span>Total</span><span>{peso(last.totalMinor)}</span></li>
          {last.changeMinor > 0 && <li className="list-group-item d-flex justify-content-between fw-bold" style={{ fontSize: 24 }}><span>Change</span><span>{peso(last.changeMinor)}</span></li>}
        </ul>
        <div className="d-flex flex-wrap gap-2 mb-3">
          <button type="button" className="btn btn-outline-dark btn-lg flex-fill" onClick={() => printSlip(receiptSlip(last))}><i className="bi bi-printer me-1"></i>Print receipt</button>
        </div>
        {textInfo && last.status !== "DECLINED" && (
          <div className="card mb-3"><div className="card-body">
            <div className="fw-semibold mb-1">Text {textInfo.name ?? "the customer"} about this utang</div>
            <div className="small text-muted mb-2">Opens your phone's text app with the message ready. Press Send there.</div>
            {!textInfo.phone && (
              <input className="form-control form-control-lg mb-2" inputMode="tel" placeholder="Mobile number (09…)" value={textPhone} onChange={(e) => setTextPhone(e.target.value)} />
            )}
            <button type="button" className="btn btn-primary btn-lg w-100" onClick={() => {
              const text = buildText("credit_sale", {
                storeName: storeName || "SAM STORE", customerName: textInfo.name, reference: last.orderNumber, totalMinor: last.totalMinor, balanceMinor: textInfo.balanceAfterMinor,
                items: last.lines.map((l) => ({ name: l.name, qty: l.soldBy === "PIECE" || !l.grams ? `${l.quantity}×` : kg(l.grams) })),
              });
              const phone = textInfo.phone || textPhone;
              if (!openTextApp({ phone, text, template: "credit_sale", storeCustomerId: textInfo.customerId, documentType: "SALE" })) { toast("That is not a mobile number", "danger"); return; }
              if (!textInfo.phone) void fetch(`${API_URL}/admin/customers/${textInfo.customerId}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ phone }) }).catch(() => {});
            }}><i className="bi bi-chat-dots me-1"></i>Text customer</button>
          </div></div>
        )}
        {(last.belowCost?.length ?? 0) > 0 && (
          <div className="alert alert-warning">Sold below Store 1&apos;s cost: {last.belowCost!.join(", ")}. This store still owes the full cost — check the price.</div>
        )}
        {checking ? (
          <QuickCount productId={checking.productId} name={checking.name} loose={!!byId.get(checking.productId)?.loose} locationId={locationId}
            onCancel={() => { setLast({ ...last, zeroCheck: last.zeroCheck.filter((z) => z.productId !== checking.productId) }); setChecking(null); }}
            onDone={async () => { setLast({ ...last, zeroCheck: last.zeroCheck.filter((z) => z.productId !== checking.productId) }); setChecking(null); await loadCatalog(locationId); }} />
        ) : last.zeroCheck.length > 0 && (
          <div className="alert alert-warning">
            <div className="fw-semibold mb-2">Shows as out of stock here: {last.zeroCheck.map((z) => z.name).join(", ")}. Is there any left?</div>
            <div className="d-flex flex-wrap gap-2">
              {last.zeroCheck.map((z) => <button key={z.productId} type="button" className="btn btn-dark" onClick={() => setChecking(z)}>Count {z.name}</button>)}
              <button type="button" className="btn btn-outline-dark" onClick={() => setLast({ ...last, zeroCheck: [] })}>None left</button>
            </div>
          </div>
        )}
        <button className="btn btn-success btn-lg w-100 py-3" onClick={reset}><i className="bi bi-plus-lg me-1"></i>New sale</button>
      </div>
    );
  }

  // Tablet held sideways (or a PC): products on the left, the sale on the right, both always in view.
  const pickList = (
    <>
      {customers.length > 0 && (
        <div className="mb-2">
          <select className="form-select" aria-label="Customer with special prices" disabled={cart.length > 0} value={priceCustomer} onChange={(e) => void pickPriceCustomer(e.target.value)}>
            <option value="">Customer: walk-in (store prices)</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.phone ?? "—"}</option>)}
          </select>
          {priceCustomer && <div className="small text-muted mt-1">{specialCount > 0 ? `${specialCount} special ${specialCount === 1 ? "price" : "prices"} for this customer.` : "No special prices for this customer — store prices apply."}</div>}
        </div>
      )}
      <ProductFinder list="pos" items={items} clearSignal={cleared} colClass={wide ? "col-6 col-xl-3 col-lg-4" : "col-6 col-md-4"}
        renderTile={(i) => (
          <button type="button" className={`btn ${inSale(i.id) > 0 ? "btn-dark" : "btn-outline-dark"} w-100 h-100 text-center p-2 position-relative`} style={{ minHeight: 104 }}
            aria-label={`${i.name}${inSale(i.id) > 0 ? `, ${inSale(i.id)} in this sale` : ""}`}
            onClick={() => { noteUse("pos", i.id); startEdit({ productId: i.id, mode: i.loose ? "KILO" : "PIECE", value: "", sourceLocationId: null }, null); }}>
            {inSale(i.id) > 0 && <span className="position-absolute top-0 end-0 badge rounded-pill text-bg-success m-1 fs-6">{inSale(i.id)}</span>}
            <div className="fw-semibold">{i.name}{i.forReview && <span className="badge text-bg-warning ms-1">To review</span>}</div>
            <div style={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }}>{peso(i.priceMinor)}<span className="fs-6 opacity-75">{i.loose ? "/kg" : ""}</span></div>
            {/* Only this store's count: other stores show when a line is taken from them. */}
            {(() => {
              const n = i.stock[locationId] ?? 0;
              // A white badge stays readable whether the tile is light, dark (in the sale) or pressed.
              return n <= 0
                ? <div><span className="badge bg-white text-danger border border-danger fw-semibold">None left here</span></div>
                : <div className="small" style={{ fontVariantNumeric: "tabular-nums" }}>{i.loose ? kg(n) : n} left</div>;
            })()}
          </button>
        )} />
      <div className="text-center mb-3">
        <button type="button" className="btn btn-outline-secondary" onClick={() => setNewItem(true)}>+ New item (not on the list yet)</button>
      </div>
    </>
  );
  const holdSale = () => {
    const first = byId.get(cart[0]!.productId)?.name ?? "Sale";
    const h: Held = { id: `${Date.now()}`, label: `${first}${cart.length > 1 ? ` +${cart.length - 1}` : ""} · ${peso(total)}`, at: Date.now(), locationId, cart };
    const all = [...holds, h]; setHolds(all); saveHolds(all);
    keyRef.current = null; setCart([]); setError(null); toast("Sale put on hold");
  };
  const cartCard = cart.length > 0 && (
    <div className={`card border-success${wide ? "" : " position-sticky bottom-0 sticky-above-bar shadow"}`}>
      <div className="card-body">
        <ul className="list-unstyled mb-2" style={{ fontVariantNumeric: "tabular-nums", maxHeight: wide ? undefined : "32vh", overflowY: "auto" }}>
          {cart.map((l, idx) => {
            const it = byId.get(l.productId);
            const c = computed[idx]!;
            return (
              <li key={idx} className="d-flex align-items-stretch gap-2 py-1 border-bottom">
                {/* The whole line is the button: tap it to change the amount or price. */}
                <button type="button" className="btn btn-light flex-grow-1 text-start d-flex justify-content-between align-items-center gap-2" aria-label={`Change ${it?.name ?? "line"}`} onClick={() => startEdit(l, idx)}>
                  <span>
                    {l.mode === "PIECE" ? `${l.value} × ` : `${kg(c.grams ?? 0)} `}{it?.name}
                    {l.mode === "PESO" && <span className="text-muted"> (₱{l.value})</span>}
                    {l.sourceLocationId && <span className="badge text-bg-info ms-1">from {code(l.sourceLocationId)}</span>}
                    {l.price !== undefined && <span className="badge text-bg-warning ms-1">new price</span>}
                  </span>
                  <span className="fw-semibold text-nowrap">{peso(c.totalMinor)}</span>
                </button>
                <button type="button" className="btn btn-outline-danger" style={{ minWidth: 48 }} aria-label={`Remove ${it?.name ?? "line"}`} onClick={() => setCart(cart.filter((_, j) => j !== idx))}>
                  <i className="bi bi-trash" aria-hidden="true"></i>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="text-center text-muted small mb-2">Tap a line to change it.</div>
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-outline-dark btn-lg" onClick={holdSale}>Hold</button>
          <button type="button" className="btn btn-success btn-lg flex-fill py-3 fw-bold" style={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }} onClick={() => { if (!pay) setPay("cash"); setStep("pay"); }}>
            Pay {peso(total)}
          </button>
        </div>
      </div>
    </div>
  );
  const quickCount = checking && (
    <QuickCount productId={checking.productId} name={checking.name} loose={!!byId.get(checking.productId)?.loose} locationId={locationId}
      onCancel={() => setChecking(null)} onDone={async () => { setChecking(null); await loadCatalog(locationId); }} />
  );
  const editCard = editing && (() => {
    const it = byId.get(editing.productId);
    if (!it) return null;
    const c = lineOf(it, editing);
    const from = editing.sourceLocationId ?? locationId;
    const avail = it.stock[from] ?? 0;
    const over = it.tracked && c.units > avail;
    const short = over && from !== locationId; // the counter itself may sell below zero
    const belowZero = over && from === locationId;
    const changed = editing.price !== undefined && editing.price !== it.priceMinor;
    const reasonGiven = !changed || reasonOk(editing.reason);
    return (
      <div className="card border-success mx-auto" style={{ maxWidth: 520 }}>
        <div className="card-body">
          <h2 className="h5 text-center mb-1">{it.name} · {peso(it.priceMinor)}{it.loose ? "/kg" : ""}</h2>
          <div className="text-center text-muted mb-2">{it.loose ? "Sell by kilos or by pesos?" : "How many?"}</div>
          {it.loose && (
            <div className="btn-group w-100 mb-3" role="group" aria-label="Kilos or pesos?">
              <button type="button" className={`btn btn-lg ${editing.mode === "KILO" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setEditing({ ...editing, mode: "KILO", value: "" })}>Kilos</button>
              <button type="button" className={`btn btn-lg ${editing.mode === "PESO" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setEditing({ ...editing, mode: "PESO", value: "" })}>Pesos</button>
            </div>
          )}
          <NumPad value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} decimals={editing.mode === "KILO" ? 3 : editing.mode === "PESO" ? 2 : 0}
            label={editing.mode === "PESO" ? "Amount in pesos" : editing.mode === "KILO" ? "How many kilos" : "How many"} unit={editing.mode === "PESO" ? "₱" : editing.mode === "KILO" ? "kg" : it.gramsPerUnit ? "sacks" : "pieces"} />
          <div className="mt-2" style={{ fontVariantNumeric: "tabular-nums" }}>
            {editing.mode === "PESO" && c.grams ? <div className="fs-5">= <strong>{kg(c.grams)}</strong> · pay <strong>{peso(c.totalMinor)}</strong></div> : null}
            {editing.mode === "KILO" && c.totalMinor > 0 ? <div className="fs-5">= <strong>{peso(c.totalMinor)}</strong></div> : null}
            {editing.mode === "PIECE" && c.totalMinor > 0 ? <div className="fs-5">= <strong>{peso(c.totalMinor)}</strong></div> : null}
          </div>
          {!priceOpen && !fromOpen && (
            <div className="d-flex flex-wrap justify-content-center gap-2 mt-3">
              <button type="button" className="btn btn-outline-secondary" onClick={() => setPriceOpen(true)}>Change price</button>
              {it.tracked && locations.length > 1 && <button type="button" className="btn btn-outline-secondary" onClick={() => setFromOpen(true)}>Take from another store</button>}
            </div>
          )}
          {priceOpen && (
          <div className="mt-3">
            <label className="form-label mb-1" htmlFor="bt-price">New price {it.loose ? "per kilo" : "each"} <span className="text-muted small">(usual price {peso(it.priceMinor)})</span></label>
            <PesoInput id="bt-price" className="form-control form-control-lg" value={editing.price !== undefined ? String(editing.price / 100) : ""} placeholder={(it.priceMinor / 100).toFixed(2)}
              onChange={(v) => { const m = v === "" ? undefined : toMinor(v); setEditing({ ...editing, price: m === undefined || m === it.priceMinor ? undefined : m, reason: m === undefined || m === it.priceMinor ? undefined : editing.reason }); }} />
            {changed && (
              <PriceReason className="form-select mt-2" value={editing.reason ?? ""} onChange={(v) => setEditing({ ...editing, reason: v })} />
            )}
          </div>
          )}
          {it.tracked && (fromOpen || short) && (
            <div className="mt-3">
              <LocationPicker id="bt-from" label="Taken from (where the item comes from)" locations={locations} value={from}
                labelFor={(l) => `${l.name}${l.id === locationId ? " (here)" : ""} — ${it.loose ? kg(it.stock[l.id] ?? 0) : `${it.stock[l.id] ?? 0}`}`}
                onAdded={(loc) => setLocations([...locations, { id: loc.id, name: loc.name, code: null, type: "STORE" }])}
                onChange={(id) => setEditing({ ...editing, sourceLocationId: id === locationId ? null : id })} />
            </div>
          )}
          {belowZero && (
            <div className="alert alert-warning mt-2 mb-0">
              <strong>Count is {it.loose ? kg(avail) : avail}</strong> — you can still sell. The count goes below zero until the next count.
              <button type="button" className="btn btn-dark btn-sm ms-2" onClick={() => setChecking({ productId: it.id, name: it.name })}>Any left? Count</button>
            </div>
          )}
          {short && (
            <div className="alert alert-danger mt-2 mb-0">
              <strong>Short</strong> — only {it.loose ? kg(avail) : avail} at {code(from)}. Lower the amount, or take from another location.
              {from === locationId && <button type="button" className="btn btn-dark btn-sm ms-2" onClick={() => setChecking({ productId: it.id, name: it.name })}>Any left? Count</button>}
            </div>
          )}
          <div className="d-flex justify-content-between mt-3 pos-actions">
            <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => { setEditing(null); setEditIdx(null); }}>Back</button>
            <button type="button" className="btn btn-success btn-lg px-5" disabled={c.totalMinor <= 0 || short || !reasonGiven || (editing.mode === "PIECE" && !Number.isInteger(c.units))}
              onClick={() => { setCart(editIdx === null ? [...cart, editing] : cart.map((x, j) => (j === editIdx ? editing : x))); setEditing(null); setEditIdx(null); setCleared((n) => n + 1); }}>{editIdx === null ? "Add to sale" : "Save"}</button>
          </div>
        </div>
      </div>
    );
  })();

  const sideBySide = wide && step === "pick" && !newItem;
  return (
    <div style={{ fontSize: 18 }} className={sideBySide ? "row g-3 align-items-start" : undefined}>
      <div className={sideBySide ? "col-lg-7 col-xl-8" : undefined}>
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
          <h1 className="h4 mb-0">POS</h1>
          {/* Held sales: the button only shows when there is one to come back to. */}
          {holds.some((h) => h.locationId === locationId) && (
            <button type="button" className="btn btn-warning" onClick={() => setShowHeld(!showHeld)}>
              <i className="bi bi-pause-circle me-1"></i>Held sales ({holds.filter((h) => h.locationId === locationId).length})
            </button>
          )}
        </div>
        <Steps items={["Pick items", "Pay", "Done"]} current={step === "pay" ? 1 : 0} />
        <StoreBar label="Selling at" locations={locations} value={locationId} homeLocationId={homeLocationId} locked={cart.length > 0}
          lockedNote="To switch store, hold or clear this sale first." onPick={(id) => { reset(); void loadCatalog(id); }} />
        {showHeld && (
          <div className="card mb-3"><div className="card-body">
            <h2 className="h6">Held sales at {here?.name}</h2>
            {holds.filter((h) => h.locationId === locationId).length === 0 && <div className="text-muted">Nothing on hold.</div>}
            <ul className="list-unstyled mb-0">
              {holds.filter((h) => h.locationId === locationId).map((h) => (
                <li key={h.id} className="d-flex justify-content-between align-items-center py-1 border-bottom">
                  <span>{h.label}<span className="small text-muted"> · {new Date(h.at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span></span>
                  <span className="text-nowrap">
                    <button type="button" className="btn btn-success btn-sm me-1" onClick={() => {
                      setCart([...cart, ...h.cart]);
                      const rest = holds.filter((x) => x.id !== h.id); setHolds(rest); saveHolds(rest); setShowHeld(false);
                    }}>Resume</button>
                    <button type="button" className="btn btn-outline-danger btn-sm" onClick={() => { const rest = holds.filter((x) => x.id !== h.id); setHolds(rest); saveHolds(rest); }}>Delete</button>
                  </span>
                </li>
              ))}
            </ul>
          </div></div>
        )}
        {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

        {sideBySide && pickList}
        {step === "pick" && !newItem && !sideBySide && (
          <>
            {!editing && <>{pickList}{cartCard}</>}
            {quickCount}
            {!checking && editCard}
          </>
        )}

        {step === "pick" && newItem && <NewItemForm locationId={locationId} onCancel={() => setNewItem(false)} onDone={async () => { setNewItem(false); await loadCatalog(locationId); }} />}

        {step === "pay" && (
          <div className="card border-success mx-auto" style={{ maxWidth: 520 }}>
            <div className="card-body">
              <div className="text-center mb-3">
                <div className="text-muted">Customer pays</div>
                <div className="fw-bold" style={{ fontSize: 40, fontVariantNumeric: "tabular-nums" }}>{peso(total)}</div>
              </div>
              <div className="text-center fw-semibold mb-2">How are they paying?</div>
              <div className={`d-grid gap-2 ${allPay ? "mb-3" : "mb-2"}`} style={{ gridTemplateColumns: "repeat(3, 1fr)" }} role="group" aria-label="How are they paying?">
                {(["cash", "gcash", "utang", ...(allPay ? ["maya", "bank", "split"] : [])] as Pay[]).map((p) => (
                  <button key={p} type="button" className={`btn btn-lg ${pay === p ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={pay === p} onClick={() => setPay(p)}>
                    {p === "cash" && <i className="bi bi-cash me-1" aria-hidden="true"></i>}{PAY_LABEL[p]}
                  </button>
                ))}
              </div>
              {!allPay && (
                <div className="text-center mb-3"><button type="button" className="btn btn-link" onClick={() => setMorePay(true)}>Other ways to pay</button></div>
              )}

              {pay === "cash" && drawerOpen === false && shiftRequired && (
                <OpenDrawer onOpened={() => { setDrawerOpen(true); setError(null); }} />
              )}
              {pay === "cash" && (
                <>
                  <div className="d-flex flex-wrap justify-content-center gap-2 mb-2" role="group" aria-label="Quick cash amounts">
                    {quickCash(total).map((m) => (
                      <button key={m} type="button" className={`btn btn-lg ${tendered && toMinor(tendered) === m ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setTendered(String(m / 100))}>
                        {m === total ? "Exact" : peso(m)}
                      </button>
                    ))}
                  </div>
                  <NumPad value={tendered} onChange={setTendered} decimals={2} label="Cash received" unit="₱" />
                  {tendered && <div className={`mt-2 text-center fw-bold ${change < 0 ? "text-danger" : "text-success"}`} style={{ fontSize: 30, fontVariantNumeric: "tabular-nums" }} aria-live="polite">{change < 0 ? `Short ${peso(-change)}` : `Change ${peso(change)}`}</div>}
                </>
              )}
              {pay === "split" && (
                <>
                  <div className="small text-muted mb-2">Part of the sale in each way. The parts must add up to {peso(total)}.</div>
                  {parts.map((x, i) => (
                    <div key={i} className="row g-2 mb-2 align-items-end">
                      <div className="col-5">
                        <select className="form-select form-select-lg" aria-label="Way to pay" value={x.method} onChange={(e) => setParts(parts.map((y, j) => (j === i ? { ...y, method: e.target.value as SplitPart["method"] } : y)))}>
                          <option value="cash">Cash</option><option value="gcash">GCash</option><option value="maya">Maya</option><option value="bank">Bank transfer</option>
                        </select>
                      </div>
                      <div className="col-7">
                        <input className="form-control form-control-lg" inputMode="decimal" placeholder="₱ amount" aria-label="Amount" value={x.amount} onChange={(e) => setParts(parts.map((y, j) => (j === i ? { ...y, amount: e.target.value.replace(/[^\d.]/g, "").slice(0, 10) } : y)))} />
                      </div>
                      {x.method !== "cash" && (
                        <div className="col-12">
                          <input className="form-control" inputMode="numeric" placeholder={`${x.method === "gcash" ? "GCash" : x.method === "maya" ? "Maya" : "Bank"} reference no.`} aria-label="Reference number" value={x.reference} onChange={(e) => setParts(parts.map((y, j) => (j === i ? { ...y, reference: e.target.value.replace(/\s/g, "").slice(0, 40) } : y)))} />
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="d-flex gap-2 align-items-center">
                    {parts.length < 4 && <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setParts([...parts, { method: "cash", amount: "", reference: "" }])}>+ Add a part</button>}
                    {parts.length > 2 && <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setParts(parts.slice(0, -1))}>Remove last</button>}
                    {(() => { const left = total - parts.reduce((s, x) => s + toMinor(x.amount || "0"), 0); return <span className={`ms-auto fw-semibold ${left === 0 ? "text-success" : "text-danger"}`}>{left === 0 ? "Fully paid" : left > 0 ? `${peso(left)} left` : `${peso(-left)} too much`}</span>; })()}
                  </div>
                </>
              )}
              {needsRef(pay as Pay) && (
                <>
                  <label className="form-label" htmlFor="bt-ref">{pay === "maya" ? "Maya" : pay === "bank" ? "Bank transfer" : "GCash"} reference no.</label>
                  <input id="bt-ref" className="form-control form-control-lg" inputMode="numeric" value={reference} onChange={(e) => setReference(e.target.value.replace(/\s/g, "").slice(0, 40))} />
                </>
              )}
              {pay === "utang" && (
                <>
                  <label className="form-label" htmlFor="bt-cust">Customer</label>
                  <select id="bt-cust" className="form-select form-select-lg mb-2" disabled={!!priceCustomer} value={customerId} onChange={(e) => { setCustomerId(e.target.value); setCustomerSig(null); }}>
                    <option value="">Choose…</option>
                    {customers.filter((c) => c.creditApproved).map((c) => <option key={c.id} value={c.id}>{c.name ?? c.phone ?? "—"} — owes {peso(c.creditBalanceMinor)} · {creditStatusWords(c.creditStatus).label}</option>)}
                  </select>
                  {!newCust && <button type="button" className="btn btn-outline-success mb-2" onClick={() => setNewCust(true)}>+ New customer</button>}
                  {newCust && <QuickCustomer onCancel={() => setNewCust(false)} onAdded={async (id) => {
                    const res = await fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() });
                    if (res.ok) setCustomers(((await res.json()).customers ?? []) as Customer[]);
                    setCustomerId(id); setCustomerSig(null); setNewCust(false);
                  }} />}
                  {customer && (
                    <>
                      <p className="mb-2">This sale on credit: <strong>{peso(total)}</strong>. Total owed after: <strong>{peso(customer.creditBalanceMinor + total)}</strong>.</p>
                      {customer.creditUnlimited && <p className="small text-muted mb-2">No credit limit.</p>}
                      {overLimit && (
                        <div className="alert alert-danger py-2">Over the credit limit ({peso(customer.creditLimitMinor)}). The customer must pay some of the balance first — use the Credit screen — then can buy on credit again.</div>
                      )}
                      <div className="fw-semibold">Signature of {customer.name ?? "the customer"}</div>
                      <SignaturePad key={customerId} onSignature={setCustomerSig} />
                    </>
                  )}
                </>
              )}

              {(allPay || paper) && <div className="form-check form-switch mt-3">
                <input className="form-check-input" type="checkbox" id="bt-paper" checked={paper} onChange={(e) => setPaper(e.target.checked)} />
                <label className="form-check-label" htmlFor="bt-paper">From a paper slip (type in the slip)</label>
              </div>}
              {paper && (
                <div className="border rounded p-2 mt-2">
                  <div className="row g-2">
                    <div className="col-5">
                      <label className="form-label" htmlFor="bt-slip">Slip number</label>
                      <input id="bt-slip" className="form-control form-control-lg" value={slipNo} onChange={(e) => setSlipNo(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20))} />
                    </div>
                    <div className="col-7">
                      <label className="form-label" htmlFor="bt-time">Date and time on the slip</label>
                      <input id="bt-time" type="datetime-local" className="form-control form-control-lg" value={slipTime} onChange={(e) => setSlipTime(e.target.value)} />
                    </div>
                  </div>
                  <label className="form-label mt-2" htmlFor="bt-photo">Photo of the slip</label>
                  <input id="bt-photo" type="file" accept="image/*" capture="environment" className="form-control"
                    onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setSlipPhoto(await photoToJpeg(f)); } catch (err) { setError(err instanceof Error ? err.message : "Could not read the photo"); } }} />
                  {slipPhoto && <img src={slipPhoto} alt="Photo of the slip" className="img-fluid mt-2 border" style={{ maxHeight: 160 }} />}
                  <div className="fw-semibold mt-2">Your signature (staff)</div>
                  <SignaturePad onSignature={setStaffSig} />
                </div>
              )}

              <div className="d-flex gap-2 mt-3">
                <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={() => setStep("pick")}>Back</button>
                <button type="button" className="btn btn-success btn-lg flex-fill py-3 fw-bold" style={{ fontSize: 22 }} disabled={!canSubmit} onClick={() => void submit()}>{busy ? "Please wait…" : "Finish sale"}</button>
              </div>
              {pay === "cash" && !tendered && <div className="text-center text-muted mt-2">Tap Exact or enter the cash received first.</div>}
            </div>
          </div>
        )}
      </div>
      {sideBySide && (
        <div className="col-lg-5 col-xl-4 pos-side">
          {quickCount || editCard || cartCard || (
            <div className="card"><div className="card-body text-center text-muted py-5"><i className="bi bi-hand-index fs-1 d-block mb-2" aria-hidden="true"></i>Tap a product to start a sale.</div></div>
          )}
        </div>
      )}
    </div>
  );
}

/** Cash needs an open cash drawer. Staff open it right here instead of going to POS. */
function OpenDrawer({ onOpened }: { onOpened: () => void }) {
  const [float, setFloat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true); setError(null);
    const res = await fetch(`${API_URL}/admin/registers/open`, {
      method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ openingFloatMinor: toMinor(float) }),
    }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as ApiBody | null;
    setBusy(false);
    // Someone else opened it a moment ago — that is fine, cash can go in now.
    if (res && (res.ok || res.status === 409)) { toast("The cash drawer is open"); onOpened(); return; }
    setError(errText(d, "Could not open the cash drawer — try again"));
  };
  return (
    <div className="alert alert-warning">
      <div className="fw-semibold mb-2">The cash drawer is closed. Open it before taking cash.</div>
      {error && <div className="text-danger mb-2">{error}</div>}
      <NumPad value={float} onChange={setFloat} decimals={2} label="Cash in the drawer now (change fund)" unit="₱" />
      <button type="button" className="btn btn-dark btn-lg w-100 mt-2" disabled={busy} onClick={() => void open()}>{busy ? "Please wait…" : "Open the cash drawer"}</button>
    </div>
  );
}

/** Add a customer from the POS: name + mobile. On credit with no limit until the owner sets one. */
function QuickCustomer({ onCancel, onAdded }: { onCancel: () => void; onAdded: (storeCustomerId: string) => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    const res = await fetch(`${API_URL}/admin/utang/customers`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ name: name.trim(), phone: phone.trim() }) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    setBusy(false);
    if (!res.ok) { setError(errText(d, "Could not add")); return; }
    toast(`Added: ${name.trim()}`);
    await onAdded(String(d?.id));
  };
  return (
    <div className="border rounded p-2 mb-2">
      <div className="fw-semibold mb-1">New customer</div>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      <input className="form-control form-control-lg mb-2" aria-label="Customer name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} />
      <input className="form-control form-control-lg mb-2" aria-label="Mobile number" placeholder="09xx xxx xxxx" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.slice(0, 16))} />
      <div className="d-flex justify-content-between">
        <button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-success" disabled={busy || name.trim().length < 2 || phone.trim().length < 10} onClick={() => void save()}>{busy ? "Please wait…" : "Add customer"}</button>
      </div>
    </div>
  );
}

/** New item: name, sold as, weight, price, cost, what is on hand now — signed by staff. */
export function NewItemForm({ locationId, onCancel, onDone, preorder = false }: { locationId?: string; onCancel: () => void; onDone: (created?: { productId: string; name: string; costMinor: number; priceMinor: number }) => void | Promise<void>; /** Pre-order / stock in: only the cost and the selling price; nothing is on hand yet, and no signature. */ preorder?: boolean }) {
  const [name, setName] = useState("");
  const [soldAs, setSoldAs] = useState<"SACK" | "KILO" | "PIECE">("SACK");
  const [kilosPerSack, setKilosPerSack] = useState("25");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [onHand, setOnHand] = useState("");
  const [noCount, setNoCount] = useState(false); // piece items only: sell any time, stock not counted
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipCount = noCount && soldAs === "PIECE";
  const ready = name.trim().length >= 2 && Number(price) > 0 && (preorder || (skipCount || Number(onHand) > 0) && !!sig) && (soldAs !== "SACK" || Number(kilosPerSack) > 0);

  const save = async () => {
    setBusy(true); setError(null);
    const body = {
      name: name.trim(), soldAs, locationId,
      gramsPerSack: soldAs === "SACK" ? Math.round(Number(kilosPerSack) * 1000) : undefined,
      priceMinor: toMinor(price), costMinor: toMinor(cost),
      ...(preorder ? { noOpeningStock: true } : {}),
      openingQty: preorder || skipCount ? 0 : soldAs === "KILO" ? Math.round(Number(onHand) * 1000) : Math.floor(Number(onHand)),
      trackStock: skipCount ? false : undefined,
      signatures: preorder ? [] : [{ signerKind: "STAFF", imagePng: sig }],
    };
    const res = await fetch(`${API_URL}/admin/benta/manual-item`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    setBusy(false);
    if (!res.ok) { setError(errText(d, "Could not add")); return; }
    toast(`Added: ${name.trim()}`);
    await onDone({ productId: String(d?.productId ?? ""), name: name.trim(), costMinor: toMinor(cost), priceMinor: toMinor(price) });
  };

  const num = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 10);
  return (
    <div className="card border-success" style={{ maxWidth: 520 }}>
      <div className="card-body">
        <h2 className="h5">New item</h2>
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <label className="form-label" htmlFor="ni-name">Name</label>
        <input id="ni-name" className="form-control form-control-lg mb-2" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} />
        <div className="btn-group w-100 mb-2" role="group" aria-label="Sold as">
          {(["SACK", "KILO", "PIECE"] as const).map((s) => (
            <button key={s} type="button" className={`btn btn-lg ${soldAs === s ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setSoldAs(s)}>{s === "SACK" ? "Sack" : s === "KILO" ? "Kilo" : "Piece"}</button>
          ))}
        </div>
        {soldAs === "SACK" && (
          <><label className="form-label" htmlFor="ni-kg">How many kilos in one sack</label>
            <input id="ni-kg" className="form-control form-control-lg mb-2" inputMode="decimal" value={kilosPerSack} onChange={(e) => setKilosPerSack(num(e.target.value))} /></>
        )}
        <div className="row g-2">
          <div className="col-6"><label className="form-label" htmlFor="ni-price">{preorder ? "Selling price" : "Price"}{soldAs === "KILO" ? " /kg" : ""} (₱)</label>
            <PesoInput id="ni-price" className="form-control form-control-lg" value={price} onChange={setPrice} placeholder="0.00" /></div>
          <div className="col-6"><label className="form-label" htmlFor="ni-cost">{preorder ? "Unit cost (what you pay)" : "Cost"}{soldAs === "KILO" ? " /kg" : ""} (₱)</label>
            <PesoInput id="ni-cost" className="form-control form-control-lg" value={cost} onChange={setCost} placeholder="0.00" /></div>
        </div>
        {soldAs === "PIECE" && !preorder && (
          <div className="form-check form-switch mt-2">
            <input className="form-check-input" type="checkbox" id="ni-nocount" checked={noCount} onChange={(e) => setNoCount(e.target.checked)} />
            <label className="form-check-label" htmlFor="ni-nocount">Don't count stock — sell it any time</label>
          </div>
        )}
        {!skipCount && !preorder && (<>
        <label className="form-label mt-2" htmlFor="ni-onhand">On hand now ({soldAs === "KILO" ? "kilos" : soldAs === "SACK" ? "sacks" : "pieces"})</label>
        <input id="ni-onhand" className="form-control form-control-lg mb-2" inputMode="decimal" value={onHand} onChange={(e) => setOnHand(num(e.target.value))} />
        </>)}
        {!preorder && (<><div className="fw-semibold">Your signature (staff)</div>
        <SignaturePad onSignature={setSig} /></>)}
        {preorder && <p className="small text-muted mt-2 mb-0">Nothing is on hand yet. The new item goes straight into Products.</p>}
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>Back</button>
          <button type="button" className="btn btn-success btn-lg" disabled={!ready || busy} onClick={() => void save()}>{busy ? "Please wait…" : "Add"}</button>
        </div>
      </div>
    </div>
  );
}
