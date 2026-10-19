"use client";

// POS (V1) — staged, mobile-first: Products → Review (customer + autosave) → Payment
// (Cash w/ tendered + change, or Utang w/ start/due dates + signature) → Done (+print receipt).
// Hold: creates an ON_HOLD order (stock earmarked) listed in the held strip; Resume loads it back.
// Review also offers 'Save as pre-order' → POSTs the cart as an ON_HOLD draft, then jumps to
// the Pre Order panel (preorders). Loyalty points redeemable on utang.

import { useCallback, useEffect, useRef, useState } from "react";
import { newSaleKey } from "../../lib/saleKey";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import ReceiptModal from "./ReceiptModal";
import RegisterBar from "./RegisterBar";

interface PosVariant {
  id: string; name: string; sku: string; priceMinor: number; availableQuantity: number; isActive: boolean;
}
interface PosProduct {
  id: string; name: string; sku: string; barcode?: string | null; unit?: string | null;
  priceMinor: number;
  availableQuantity: number; category: { name: string } | null;
  variants?: PosVariant[]; // P2b
}
interface PosCustomer { id: string; name: string | null; email: string | null; phone: string | null; address?: string | null; loyaltyPoints?: number; }
interface CartLine { product: PosProduct; quantity: number; variant: PosVariant | null; priceOverrideMinor: number | null }
interface HeldOrder { id: string; orderNumber: string; totalMinor: number; customerName: string; storeCustomerId: string | null; createdAt: string; items: { productId: string; productName: string; variantId?: string | null; quantity: number; unitPriceMinor: number }[]; }
interface LastSale { orderId: string; orderNumber: string; totalMinor: number; changeMinor: number; paymentMethod: string }

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const QUICK_CASH = [5000, 10000, 20000, 50000, 100000];

/** Finger-drawn signature pad: 300×120 white canvas, black 3px round-cap strokes.
    Pointer events with touch fallback; exports via canvas.toDataURL("image/png"). */
function SignaturePad({ onSignature }: { onSignature: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);
  const preppedRef = useRef(false);
  const supportsPointer = typeof window !== "undefined" && "PointerEvent" in window;

  const coords = (x: number, y: number) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: (x - r.left) * (c.width / r.width), y: (y - r.top) * (c.height / r.height) };
  };

  const setup = () => {
    const c = canvasRef.current;
    if (!c) return null;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    if (!preppedRef.current) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      preppedRef.current = true;
    }
    return ctx;
  };

  const beginStroke = (x: number, y: number) => {
    const ctx = setup();
    if (!ctx) return;
    const p = coords(x, y);
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    drawingRef.current = true;
    hasInkRef.current = true;
  };

  const moveStroke = (x: number, y: number) => {
    if (!drawingRef.current) return;
    const ctx = setup();
    if (!ctx) return;
    const p = coords(x, y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const endStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const c = canvasRef.current;
    if (c && hasInkRef.current) onSignature(c.toDataURL("image/png"));
  };

  const clearPad = () => {
    drawingRef.current = false;
    const c = canvasRef.current;
    const ctx = c && c.getContext("2d");
    if (c && ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
    }
    preppedRef.current = false;
    hasInkRef.current = false;
    onSignature(null);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={300}
        height={120}
        className="border rounded d-block w-100"
        style={{ touchAction: "none", userSelect: "none", backgroundColor: "#fff" }}
        onPointerDown={(e) => { if (supportsPointer) { e.preventDefault(); beginStroke(e.clientX, e.clientY); } }}
        onPointerMove={(e) => { if (supportsPointer) moveStroke(e.clientX, e.clientY); }}
        onPointerUp={() => { if (supportsPointer) endStroke(); }}
        onPointerCancel={() => { if (supportsPointer) endStroke(); }}
        onTouchStart={(e) => { if (supportsPointer) return; const t = e.touches[0]; if (t) beginStroke(t.clientX, t.clientY); }}
        onTouchMove={(e) => { if (supportsPointer) return; if (e.cancelable) e.preventDefault(); const t = e.touches[0]; if (t) moveStroke(t.clientX, t.clientY); }}
        onTouchEnd={() => { if (supportsPointer) return; endStroke(); }}
      />
      <button type="button" className="btn btn-sm btn-outline-secondary mt-1" onClick={clearPad}>
        <i className="bi bi-eraser me-1"></i>Clear
      </button>
    </div>
  );
}

export default function PosPanel({ onNavigate }: { onNavigate?: (tab: string) => void } = {}) {
  const saleKeyRef = useRef<string | null>(null);
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [customers, setCustomers] = useState<PosCustomer[]>([]);
  const [holds, setHolds] = useState<HeldOrder[]>([]);
  const [voidTarget, setVoidTarget] = useState<HeldOrder | null>(null);
  const [step, setStep] = useState<"products" | "review" | "payment" | "done">("products");
  // For delivery: convert the completed sale into a delivery-pipeline order.
  const [deliverTarget, setDeliverTarget] = useState<LastSale | null>(null);
  const [delivCustomerId, setDelivCustomerId] = useState("");
  const [delivAddress, setDelivAddress] = useState("");
  const [delivLandmark, setDelivLandmark] = useState("");
  const [delivBusy, setDelivBusy] = useState(false);
  const [delivDone, setDelivDone] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [payment, setPayment] = useState<"cash" | "credit">("cash");
  const [tendered, setTendered] = useState("");
  // N1: null = unknown, true = drawer open, false = no open shift (cash disabled)
  const [shiftOpen, setShiftOpen] = useState<boolean | null>(null);
  const [shiftRequired, setShiftRequired] = useState(true);
  const onShiftChange = useCallback((open: boolean, required: boolean) => { setShiftOpen(open); setShiftRequired(required); }, []);
  const cashBlocked = shiftOpen === false && shiftRequired; // the owner can switch the shift rule off in Settings
  const [startAt, setStartAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [termDays, setTermDays] = useState(30);
  const [workingHoldId, setWorkingHoldId] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<LastSale | null>(null);
  const [receiptOrder, setReceiptOrder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");

  const [usePoints, setUsePoints] = useState(false);
  const [creditSig, setCreditSig] = useState<string | null>(null);
  const [creditSigError, setCreditSigError] = useState(false);
  // Counter price override: one reason covers every line whose price was changed
  // (mirrors the server rule — a deviating price is refused without a reason).
  const [priceReason, setPriceReason] = useState("");

  const load = useCallback(async () => {
    try {
      const [p, c, h, s] = await Promise.all([
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/pos/holds`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setProducts(p.products ?? []);
      setCustomers(c.customers ?? []);
      setHolds(h.holds ?? []);
      setTermDays(s?.settings?.creditTermDays ?? 30);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── counter price override ───────────────────────────────────────────────────────
  /** The price the catalog says (a variant line uses the variant's own price). */
  const catalogPrice = (l: CartLine) => l.variant?.priceMinor ?? l.product.priceMinor;
  /** The price the line will actually be sold at. */
  const linePrice = (l: CartLine) => l.priceOverrideMinor ?? catalogPrice(l);
  const isOverridden = (l: CartLine) => linePrice(l) !== catalogPrice(l);
  const overriddenCount = cart.filter(isOverridden).length;
  /** The server refuses a deviating price without a reason — mirror that here. */
  const priceReasonMissing = overriddenCount > 0 && priceReason.trim().length < 3;

  const setLinePrice = (productId: string, pesosText: string) => {
    if (pesosText.trim() === "") { setCart((c) => c.map((l) => (l.product.id === productId ? { ...l, priceOverrideMinor: null } : l))); return; }
    const minor = Math.round(parseFloat(pesosText) * 100);
    if (!Number.isFinite(minor)) return;
    setCart((c) => c.map((l) => (l.product.id === productId ? { ...l, priceOverrideMinor: minor < 0 ? 0 : minor } : l)));
  };

  const revertLinePrice = (productId: string) => {
    setCart((c) => c.map((l) => (l.product.id === productId ? { ...l, priceOverrideMinor: null } : l)));
  };

  /** Sell/hold payload. A line only carries an override when it deviates, so an
   *  untouched cart stays exactly as before (catalog price, no reason). */
  const itemsPayload = () => cart.map((l) => ({
    productId: l.product.id,
    variantId: l.variant?.id ?? undefined,
    quantity: l.quantity,
    unitPriceMinorOverride: isOverridden(l) ? linePrice(l) : undefined,
    priceOverrideReason: isOverridden(l) ? priceReason.trim() || undefined : undefined,
  }));

  const subtotal = cart.reduce((s, l) => s + linePrice(l) * l.quantity, 0);
  const tenderedMinor = Math.round(parseFloat(tendered || "0") * 100);
  const changeMinor = payment === "cash" ? tenderedMinor - subtotal : 0;
  const loyaltyCustomer = customers.find((c) => c.id === customerId);
  const loyaltyPoints = loyaltyCustomer?.loyaltyPoints ?? 0;
  const canPay = cart.length > 0 && !priceReasonMissing && (payment === "cash" ? tenderedMinor >= subtotal : (!!customerId && !!creditSig));

  const addProduct = (product: PosProduct) => {
    setError(null);
    setCart((c) => {
      const found = c.find((l) => l.product.id === product.id);
      // P2b: default to the first available variant when the product has variants.
      const variant = product.variants && product.variants.length > 0
        ? product.variants.find((v) => v.isActive && v.availableQuantity > 0) ?? product.variants[0] ?? null
        : null;
      const limit = variant ? variant.availableQuantity : product.availableQuantity;
      if (found) {
        if (found.quantity + 1 > limit) { setError(`Only ${limit} left for ${product.name}${variant ? ` (${variant.name})` : ""}`); return c; }
        return c.map((l) => (l.product.id === product.id ? { ...l, quantity: l.quantity + 1, variant: l.variant ?? variant } : l));
      }
      return [...c, { product, quantity: 1, variant, priceOverrideMinor: null }];
    });
  };

  const setVariant = (productId: string, variantId: string) => {
    // A different variant has a different catalog price, so any override is dropped.
    setCart((c) => c.map((l) => (l.product.id === productId ? { ...l, variant: l.product.variants?.find((v) => v.id === variantId) ?? null, quantity: 1, priceOverrideMinor: null } : l)));
  };

  const setQty = (productId: string, qty: number) => {
    setCart((c) => (qty <= 0 ? c.filter((l) => l.product.id !== productId) : c.map((l) => (l.product.id === productId ? { ...l, quantity: qty } : l))));
  };

  // Customer: select existing, or quick-create (autosave) by name/phone.
  const ensureCustomer = async (): Promise<string | null> => {
    if (customerId) return customerId;
    if (!newName.trim()) return null;
    const res = await fetch(`${API_URL}/admin/pos/quick-customer`, {
      method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ name: newName.trim(), phone: newPhone.trim() || undefined }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    setCustomerId(d.id);
    await load();
    return d.id;
  };

  const quickCash = (minor: number) => setTendered((minor / 100).toString());

  const hold = async () => {
    if (cart.length === 0) { setError("Cart is empty"); return; }
    setBusy(true); setError(null);
    try {
      // If resuming, first void the old hold then create fresh (keeps items authoritative).
      const customer = await ensureCustomer();
      const res = await fetch(`${API_URL}/admin/pos/hold`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ items: itemsPayload(), customerId: customer ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.errors?.join(", ") ?? data?.message ?? "Hold failed"); return; }
      if (workingHoldId) {
        await fetch(`${API_URL}/admin/pos/holds/${workingHoldId}/void`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ reason: "re-held with edits" }) });
      }
      toast(`Held ${data.orderNumber} — stock reserved`);
      resetSale();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hold failed");
    } finally { setBusy(false); }
  };

  const resume = (h: HeldOrder) => {
    setError(null);
    const lineMap = new Map(products.map((p) => [p.id, p]));
    const lines: CartLine[] = [];
    for (const it of h.items) {
      const prod = lineMap.get(it.productId);
      if (prod) {
        // Carry the held price forward so resuming never silently re-prices a line.
        const variant = prod.variants?.find((v) => v.id === it.variantId) ?? null;
        const catalog = variant?.priceMinor ?? prod.priceMinor;
        lines.push({ product: prod, quantity: it.quantity, variant, priceOverrideMinor: it.unitPriceMinor !== catalog ? it.unitPriceMinor : null });
      }
    }
    setCart(lines);
    setCustomerId(h.storeCustomerId ?? "");
    setWorkingHoldId(h.id);
    setPayment("cash");
    setTendered("");
    setStep("review");
  };

  /** Delete (void) a held order from the POS strip — restores stock. */
  const doVoidHold = async () => {
    if (!voidTarget) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/pos/holds/${voidTarget.id}/void`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ reason: "deleted from POS" }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.message ?? "Delete failed"); return; }
      toast(`Held order ${voidTarget.orderNumber} deleted — stock restored`);
      setVoidTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally { setBusy(false); }
  };

  const complete = async () => {
    if (!canPay) { setError(payment === "cash" ? "Tendered amount must cover the total" : "Select a customer and sign for credit"); return; }
    setBusy(true); setError(null);
    try {
      const customer = await ensureCustomer();
      if (payment === "credit" && !customer) { setError("Add or select a customer for credit"); setBusy(false); return; }
      // Rice Ops M5: one key per sale — a double-tap or a retry after a dropped signal
      // returns the same sale instead of making a second one. Cleared when the sale is done.
      if (!saleKeyRef.current) saleKeyRef.current = newSaleKey();
      const payload = {
        idempotencyKey: workingHoldId ? undefined : saleKeyRef.current,
        items: itemsPayload(),
        paymentMethod: payment,
        tenderedMinor: payment === "cash" ? tenderedMinor : undefined,
        customerId: customer ?? undefined,
        startAt: payment === "credit" ? (startAt || new Date().toISOString()) : undefined,
        dueAt: payment === "credit" ? (dueAt || undefined) : undefined,
        loyaltyPoints: payment === "credit" && usePoints ? loyaltyPoints : undefined,
        signatureData: payment === "credit" && creditSig ? creditSig : undefined,
      };
      const url = workingHoldId
        ? `${API_URL}/admin/pos/holds/${workingHoldId}/complete`
        : `${API_URL}/admin/pos/sell`;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) { setError(data?.errors?.join(", ") ?? data?.message ?? "Sale failed"); return; }
      setLastSale({ orderId: data.orderId, orderNumber: data.orderNumber, totalMinor: data.totalMinor, changeMinor: data.changeMinor ?? 0, paymentMethod: data.paymentMethod });
      toast(`${payment === "cash" ? "Sale" : "Credit sale"} ${data.orderNumber} completed`);
      setStep("done");
      resetSale();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sale failed");
    } finally { setBusy(false); }
  };

  const resetSale = () => {
    saleKeyRef.current = null;
    setCart([]); setCustomerId(""); setNewName(""); setNewPhone(""); setPriceReason("");
    setTendered(""); setStartAt(""); setDueAt(""); setWorkingHoldId(null);
    setUsePoints(false); setCreditSig(null); setCreditSigError(false);
    setDelivDone(false);
  };

  /** Customer picked in the for-delivery modal (for details display). */
  const delivCustomer = () => customers.find((c) => c.id === delivCustomerId) ?? null;

  /** Mark the completed sale for delivery (address required; courier portal shows it). */
  const saveDelivery = async () => {
    if (!deliverTarget) return;
    if (delivAddress.trim().length < 3) { setError("Delivery address is required"); return; }
    setDelivBusy(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/pos/sells/${deliverTarget.orderId}/for-delivery`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ addressLine1: delivAddress.trim(), landmark: delivLandmark.trim() || undefined }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.message ?? "Failed to mark for delivery"); return; }
      toast(`${d.orderNumber} marked for delivery`);
      setDeliverTarget(null);
      setDelivDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark for delivery");
    } finally { setDelivBusy(false); }
  };

  const categories = [...new Set(products.map((p) => p.category?.name).filter(Boolean))] as string[];
  const filtered = products.filter((p) => {
    const q = search.trim().toLowerCase();
    const inSearch = !q || (p.name + p.sku + (p.barcode ?? "")).toLowerCase().includes(q);
    const inCat = !category || p.category?.name === category;
    return inSearch && inCat;
  });

  const fmtDate = (iso: string) => iso.slice(0, 10);

  return (
    <div>
      <h1 className="h4 mb-2"><i className="bi bi-cash-register me-2"></i>POS</h1>
      {/* N1: cash drawer / shift bar — cash sales are blocked until a shift is open */}
      <RegisterBar onShiftChange={onShiftChange} />
      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {receiptOrder && <ReceiptModal orderId={receiptOrder} onClose={() => setReceiptOrder(null)} />}

      {/* For delivery address modal */}
      {deliverTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title"><i className="bi bi-truck me-1"></i>Delivery for {deliverTarget.orderNumber}</h5>
                  <button type="button" className="btn-close" onClick={() => setDeliverTarget(null)}></button>
                </div>
                <div className="modal-body">
                  <p className="small text-muted mb-2">
                    Payment: <strong>{deliverTarget.paymentMethod === "cash" ? "Paid (cash)" : "Credit"}</strong> — order joins For Delivery.
                  </p>

                  {/* Customer selector */}
                  <label className="form-label small">Customer <span className="text-muted">(optional — prefill address)</span></label>
                  <select className="form-select mb-2" value={delivCustomerId} onChange={(e) => {
                    const id = e.target.value;
                    setDelivCustomerId(id);
                    const c = customers.find((x) => x.id === id);
                    if (c && c.address) setDelivAddress(c.address);
                  }}>
                    <option value="">— Select customer —</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.phone ?? "Customer"}{c.address ? " · 🏠 address on file" : ""}</option>)}
                  </select>

                  {/* Customer details (shown once selected) */}
                  {delivCustomer() && (
                    <div className="border rounded p-2 bg-light small mb-2">
                      <div className="fw-semibold">{delivCustomer()!.name ?? "Customer"}</div>
                      {delivCustomer()!.phone && <div><i className="bi bi-telephone me-1"></i>{delivCustomer()!.phone}</div>}
                      {delivCustomer()!.email && <div><i className="bi bi-envelope me-1"></i>{delivCustomer()!.email}</div>}
                      {delivCustomer()!.address && <div className="text-muted"><i className="bi bi-geo-alt me-1"></i>Address on file: <em>{delivCustomer()!.address}</em></div>}
                      {!delivCustomer()!.address && <div className="text-warning small">No address on file — add it below.</div>}
                    </div>
                  )}

                  <label className="form-label small">Delivery address <span className="text-danger">*</span></label>
                  <textarea className="form-control mb-2" rows={2} placeholder="Street, barangay, city…" value={delivAddress} onChange={(e) => setDelivAddress(e.target.value)} />
                  <label className="form-label small">Landmark (optional)</label>
                  <input className="form-control" placeholder="e.g. near 7-Eleven, white gate" value={delivLandmark} onChange={(e) => setDelivLandmark(e.target.value)} />
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setDeliverTarget(null)}>Cancel</button>
                  <button className="btn btn-primary" disabled={delivBusy || delivAddress.trim().length < 3} onClick={saveDelivery}>
                    {delivBusy ? "Sending…" : <><i className="bi bi-truck me-1"></i>Mark for delivery</>}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* ── SELL ── */}
          {/* step indicator */}
          <div className="d-flex gap-2 small mb-3">
            {(["products", "review", "payment", "done"] as const).map((s, i) => (
              <span key={s} className={`badge ${step === s ? "text-bg-primary" : "text-bg-secondary"}`}>{i + 1}. {s}</span>
            ))}
          </div>

          {/* ── DONE ── */}
          {step === "done" && lastSale && (
            <div className="card text-center border-success shadow-sm">
              <div className="card-body p-4">
                <i className="bi bi-check-circle-fill text-success fs-1 d-block mb-2"></i>
                <h2 className="h4 mb-1">Order completed</h2>
                <div className="h3 fw-bold text-primary">{lastSale.orderNumber}</div>
                <p className="mb-1">Total <strong>{toPesos(lastSale.totalMinor)}</strong></p>
                {lastSale.paymentMethod === "cash" && (
                  <p className={`h5 mb-2 ${lastSale.changeMinor >= 0 ? "text-success" : ""}`}>Change: <strong>{toPesos(lastSale.changeMinor)}</strong></p>
                )}
                {lastSale.paymentMethod === "credit" && <p className="mb-2 text-warning">Charged to credit</p>}
                <div className="d-grid gap-2">
                  <button className="btn btn-primary btn-lg" onClick={() => { setLastSale(null); resetSale(); setStep("products"); }}>
                    <i className="bi bi-plus-lg me-1"></i>New sale
                  </button>
                  <button className="btn btn-outline-secondary" onClick={() => setReceiptOrder(lastSale.orderId)}>
                    <i className="bi bi-printer me-1"></i>Print receipt
                  </button>
                  <button className="btn btn-outline-primary" disabled={delivDone} onClick={() => { setDeliverTarget(lastSale); setDelivCustomerId(""); setDelivAddress(""); setDelivLandmark(""); setError(null); }}>
                    <i className="bi bi-truck me-1"></i>{delivDone ? "Marked for delivery ✓" : "For delivery"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── PRODUCTS ── */}
          {step === "products" && (
            <>
              <div className="d-flex gap-2 mb-2 flex-wrap">
                <input className="form-control form-control-sm" style={{ maxWidth: 200 }} placeholder="Search / scan barcode…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <button className={`btn btn-sm ${category === "" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setCategory("")}>All</button>
                {categories.map((c) => (
                  <button key={c} className={`btn btn-sm ${category === c ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setCategory(category === c ? "" : c)}>{c}</button>
                ))}
              </div>

              {holds.length > 0 && (
                <div className="alert alert-light border small mb-2 d-flex flex-wrap gap-2 align-items-center">
                  <span className="fw-semibold"><i className="bi bi-pause-circle me-1"></i>On hold ({holds.length})</span>
                  {holds.map((h) => (
                    <span key={h.id} className="d-inline-flex align-items-center gap-1">
                      <button className="btn btn-sm btn-outline-warning" onClick={() => resume(h)}>
                        {h.orderNumber} · {toPesos(h.totalMinor)} · resume
                      </button>
                      <button
                        className="btn btn-sm btn-outline-danger py-0"
                        title="Delete hold order"
                        onClick={() => setVoidTarget(h)}
                      >
                        <i className="bi bi-x"></i>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="row g-2">
                {filtered.map((p) => (
                  <div className="col-6 col-md-4 col-lg-3" key={p.id}>
                    <button
                      type="button"
                      className="btn btn-outline-primary w-100 py-3 d-flex flex-column"
                      disabled={p.availableQuantity <= 0}
                      onClick={() => addProduct(p)}
                    >
                      <span className="fw-semibold small text-truncate w-100 text-center">{p.name}</span>
                      {p.unit && <span className="small text-muted">{p.unit}</span>}
                      <span className="small">{toPesos(p.priceMinor)}</span>
                      <span className={`small ${p.availableQuantity <= 0 ? "text-danger" : "text-muted"}`}>
                        {p.availableQuantity <= 0 ? "Out" : `${p.availableQuantity} left`}
                      </span>
                    </button>
                  </div>
                ))}
              </div>

              {/* sticky bottom bar */}
              <div className="position-fixed bottom-0 start-0 end-0 bg-white border-top shadow-sm d-flex align-items-center justify-content-between px-3 py-2">
                <div>
                  <div className="fw-bold">{cart.reduce((s, l) => s + l.quantity, 0)} item(s)</div>
                  <div className="text-muted small">{toPesos(subtotal)}</div>
                </div>
                <button className="btn btn-primary btn-lg" disabled={cart.length === 0} onClick={() => setStep("review")}>
                  Review order <i className="bi bi-arrow-right ms-1"></i>
                </button>
              </div>
            </>
          )}

          {/* ── REVIEW ── */}
          {step === "review" && (
            <div className="card mb-2">
              <div className="card-body">
                {cart.length === 0 ? (
                  <p className="text-muted small text-center py-4">No items — go back and add products.</p>
                ) : (
                  <>
                    {cart.map((l) => (
                      <div key={l.product.id} className="d-flex align-items-center gap-2 mb-1">
                        <div className="flex-grow-1 small">
                          <div className="fw-semibold">{l.product.name}</div>
                          {(l.product.variants && l.product.variants.length > 0) && (
                            <select
                              className="form-select form-select-sm mt-1"
                              value={l.variant?.id ?? ""}
                              onChange={(e) => setVariant(l.product.id, e.target.value)}
                            >
                              {l.product.variants.map((v) => (
                                <option key={v.id} value={v.id}>{v.name} · {toPesos(v.priceMinor)}</option>
                              ))}
                            </select>
                          )}
                          <div className="d-flex align-items-center gap-1 mt-1">
                            <div className="input-group input-group-sm" style={{ maxWidth: 132 }}>
                              <span className="input-group-text">₱</span>
                              <input
                                className={`form-control ${isOverridden(l) ? "border-warning bg-warning-subtle" : ""}`}
                                type="number" inputMode="decimal" min="0" step="0.01"
                                aria-label={`Price for ${l.product.name}`}
                                value={((l.priceOverrideMinor ?? catalogPrice(l)) / 100).toString()}
                                onChange={(e) => setLinePrice(l.product.id, e.target.value)}
                              />
                            </div>
                            {isOverridden(l) && (
                              <button type="button" className="btn btn-sm btn-outline-secondary" title="Restore the catalog price" onClick={() => revertLinePrice(l.product.id)}>
                                <i className="bi bi-arrow-counterclockwise"></i>
                              </button>
                            )}
                            {isOverridden(l) && <span className="badge text-bg-warning">edited</span>}
                          </div>
                          {isOverridden(l) && <div className="text-muted" style={{ fontSize: "0.72rem" }}>catalog {toPesos(catalogPrice(l))}</div>}
                        </div>
                        <div className="input-group input-group-sm" style={{ width: 104 }}>
                          <button className="btn btn-outline-secondary" onClick={() => setQty(l.product.id, l.quantity - 1)}>-</button>
                          <input className="form-control text-center" value={l.quantity} readOnly />
                          <button className="btn btn-outline-secondary" onClick={() => setQty(l.product.id, l.quantity + 1)}>+</button>
                        </div>
                        <div className="fw-semibold small" style={{ width: 66, textAlign: "right" }}>{toPesos(linePrice(l) * l.quantity)}</div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}

          {/* customer + payment (review/payment share the card) */}
          {step === "review" && (
            <div className="card mb-2">
              <div className="card-body">
                <h6 className="small fw-bold mb-2">Customer</h6>
                <select className="form-select form-select-sm mb-1" value={customerId} onChange={(e) => { setCustomerId(e.target.value); if (e.target.value) { setNewName(""); setNewPhone(""); } setUsePoints(false); }}>
                  <option value="">Walk-in (no customer)…</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.phone ?? "Customer"}</option>)}
                </select>
                {!customerId && (
                  <div className="row g-1 mb-1">
                    <div className="col-7"><input className="form-control form-control-sm" placeholder="New customer name (autosaves)" value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
                    <div className="col-5"><input className="form-control form-control-sm" placeholder="Phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} /></div>
                  </div>
                )}
                {newName.trim() && !customerId && <small className="text-muted">Customer is saved automatically when you complete.</small>}

                {overriddenCount > 0 && (
                  <div className="mt-2">
                    <label className="form-label small mb-1" htmlFor="posPriceReason">
                      Reason for the price change{priceReasonMissing ? " *" : ""}
                    </label>
                    <input
                      id="posPriceReason" className={`form-control form-control-sm ${priceReasonMissing ? "is-invalid" : ""}`}
                      maxLength={140} value={priceReason} onChange={(e) => setPriceReason(e.target.value)}
                      placeholder={`e.g. regular customer price (${overriddenCount} line(s) changed)`}
                    />
                    <div className="invalid-feedback">A short reason is required when a price differs from the catalog.</div>
                    <div className="form-text">Recorded on the order and printed on the receipt.</div>
                  </div>
                )}

                <div className="d-flex justify-content-between fw-bold fs-5 mt-2 mb-2">
                  <span>Total</span><span>{toPesos(subtotal)}</span>
                </div>
                <div className="d-flex flex-wrap gap-2">
                  <button className="btn btn-outline-secondary flex-fill" onClick={() => setStep("products")}>Back</button>
                  <button className="btn btn-warning flex-fill" disabled={cart.length === 0 || busy || priceReasonMissing} onClick={hold}>
                    <i className="bi bi-pause-circle me-1"></i>Hold order
                  </button>
                  <button className="btn btn-primary flex-fill" disabled={cart.length === 0 || priceReasonMissing} onClick={() => { setError(null); setStep("payment"); }}>
                    Pay <i className="bi bi-arrow-right ms-1"></i>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── PAYMENT ── */}
          {step === "payment" && (
            <div className="card">
              <div className="card-body">
                <h6 className="small fw-bold mb-2">Mode of payment</h6>
                <div className="d-flex gap-2 mb-3">
                  <button type="button" className={`btn ${payment === "cash" ? "btn-success" : "btn-outline-success"} flex-fill`} disabled={cashBlocked} onClick={() => setPayment("cash")}>
                    <i className="bi bi-cash me-1"></i>Cash
                  </button>
                  <button type="button" className={`btn ${payment === "credit" ? "btn-warning" : "btn-outline-warning"} flex-fill`} onClick={() => setPayment("credit")}>
                    <i className="bi bi-journal me-1"></i>Credit
                  </button>
                </div>
                {cashBlocked && (
                  <div className="alert alert-warning py-2 small mb-3">
                    <i className="bi bi-exclamation-triangle me-1"></i>Cash is unavailable while the drawer is closed — open a shift above, or sell on credit.
                  </div>
                )}

                {payment === "cash" ? (
                  <>
                    <label className="form-label small">Amount payable: <strong>{toPesos(subtotal)}</strong></label>
                    <input className="form-control form-control-lg text-end mb-2" type="number" inputMode="decimal" min="0" step="0.01" placeholder="Enter amount paid by customer" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                    <div className="d-flex flex-wrap gap-1 mb-2">
                      {QUICK_CASH.map((q) => <button key={q} type="button" className="btn btn-sm btn-outline-secondary" onClick={() => quickCash(q)}>{toPesos(q)}</button>)}
                      <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => quickCash(subtotal)}>Exact</button>
                    </div>
                    <div className="d-flex justify-content-between fs-5 mb-3">
                      <span className="text-muted">Change</span>
                      <span className={changeMinor >= 0 ? "text-success fw-bold" : "text-danger"}>
                        {changeMinor < 0 ? `Short ${toPesos(-changeMinor)}` : toPesos(changeMinor)}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="small text-muted mb-2">Charged to the customer&apos;s credit. Approved customers only.</p>
                    {!customerId && (
                      <>
                        <input className="form-control form-control-sm mb-1" placeholder="Customer name (saves automatically)" value={newName} onChange={(e) => setNewName(e.target.value)} />
                        <input className="form-control form-control-sm mb-2" placeholder="Phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
                      </>
                    )}
                    {customerId && (
                      <div className="d-flex align-items-center justify-content-between mb-1">
                        <span className="small">
                          Balance: <strong>{loyaltyPoints} pts</strong> · redeem ≈ <strong>₱{Math.floor(loyaltyPoints / 100)}</strong>
                        </span>
                        <div className="form-check form-switch flex-shrink-0 mb-0">
                          <input className="form-check-input" type="checkbox" role="switch" id="posRedeem" checked={usePoints} disabled={loyaltyPoints < 100} onChange={(e) => setUsePoints(e.target.checked)} />
                          <label className="form-check-label small" htmlFor="posRedeem">Redeem points</label>
                        </div>
                      </div>
                    )}
                    {loyaltyPoints < 100 && <div className="small text-muted mb-1">{`Loyalty: 100 pts = ₱1. ${loyaltyPoints} pts available.`}</div>}
                    <div className="mb-3">
                      <div className="small text-muted mb-1">Signature required for credit</div>
                      <SignaturePad onSignature={(d) => { setCreditSig(d); if (d) setCreditSigError(false); }} />
                      {creditSigError && <div className="text-danger small">Customer signature required — please sign above.</div>}
                    </div>
                    <div className="row g-2 mb-3">
                      <div className="col-6">
                        <label className="form-label small">Start date</label>
                        <input className="form-control form-control-sm" type="date" value={startAt ? fmtDate(startAt) : ""} onChange={(e) => setStartAt(e.target.value ? new Date(e.target.value).toISOString() : "")} />
                      </div>
                      <div className="col-6">
                        <label className="form-label small">Due date (default +{termDays}d)</label>
                        <input className="form-control form-control-sm" type="date" value={dueAt ? fmtDate(dueAt) : ""} onChange={(e) => setDueAt(e.target.value ? new Date(e.target.value).toISOString() : "")} />
                      </div>
                      {!dueAt && startAt && (
                        <small className="text-muted">Due date will default to start + {termDays} days.</small>
                      )}
                    </div>
                  </>
                )}

                {workingHoldId && <div className="alert alert-light small py-2 mb-2"><i className="bi bi-pause-circle me-1"></i>Completing held order (resumed sale).</div>}

                <div className="d-flex gap-2">
                  <button className="btn btn-outline-secondary flex-fill" onClick={() => setStep("review")}>Back</button>
                  <button className="btn btn-success btn-lg flex-fill" disabled={!canPay || busy} onClick={complete}>
                    {busy ? "Completing…" : `Complete · ${toPesos(subtotal)}`}
                  </button>
                </div>
              </div>
            </div>
          )}

      {/* Delete hold confirm */}
      {voidTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Delete held order — {voidTarget.orderNumber}</h5>
                  <button type="button" className="btn-close" onClick={() => setVoidTarget(null)}></button>
                </div>
                <div className="modal-body">
                  <p className="small">This cancels the held order and restores its items to stock.</p>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setVoidTarget(null)}>Cancel</button>
                  <button className="btn btn-danger" disabled={busy} onClick={doVoidHold}>
                    {busy ? "Deleting…" : "Delete"}
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