"use client";

// Pre Order panel — dedicated sidebar tab (Sell group). Two lists and one flow:
// 'Waiting' (ON_HOLD drafts: edit qty, delete/void, complete with cash or credit),
// 'Done' (completed pre-orders by date, with receipts) and the New pre-order flow
// (tap products → customer and items on one page → save).
// Backend contract (not live yet): GET /admin/pos/preorders?from=&to=,
// POST /admin/pos/preorder, POST /admin/pos/preorders/:id/finalize,
// POST /admin/pos/holds/:id/void, GET /admin/orders/:id + PATCH /admin/orders/:id/items.

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import ReceiptModal from "./ReceiptModal";
import { PesoInput } from "../NumberBoxes";
import { NewItemForm } from "./BentaPanel";
import PriceReason, { reasonOk } from "./PriceReason";
import { buildText, openTextApp } from "../../lib/text-message";

interface Preorder {
  id: string; orderNumber: string; customerName: string; storeCustomerId: string | null;
  status: string; totalMinor: number; createdAt: string; dueAt: string | null;
  items: { productId: string; productName: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number; variantId?: string | null; variantName?: string | null; priceOverridden?: boolean }[];
}
interface EditLine { productId: string; productName: string; quantity: number; unitPriceMinor: number; variantId?: string | null; variantName?: string | null }
interface PosProduct {
  id: string; name: string; sku: string; priceMinor: number;
  availableQuantity: number; category: { name: string } | null;
}
interface PosCustomer { id: string; name: string | null; email: string | null; phone: string | null; }
interface CartLine { product: PosProduct; quantity: number; /** Manual price (centavos each) when it differs from the list price. */ price?: number; reason?: string }
const unitOf = (l: CartLine) => l.price ?? l.product.priceMinor;
const priceMissingReason = (l: CartLine) => l.price !== undefined && l.price !== l.product.priceMinor && !reasonOk(l.reason);

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDate = (iso: string) => iso.slice(0, 10);

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

export default function PreOrdersPanel({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [subTab, setSubTab] = useState<"list" | "finalize" | "build">("list");
  const [preFrom, setPreFrom] = useState(localToday());
  const [preTo, setPreTo] = useState(localToday());
  const [preorders, setPreorders] = useState<Preorder[]>([]);
  const [preLoading, setPreLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receiptOrder, setReceiptOrder] = useState<string | null>(null);
  const [lastFinalizedOrderId, setLastFinalizedOrderId] = useState<string | null>(null);

  // Edit modal
  const [editPre, setEditPre] = useState<{ id: string; orderNumber: string; lines: EditLine[] } | null>(null);
  const [editAddId, setEditAddId] = useState("");
  // Counter price override: the line price the modal holds, and one reason for every
  // line that deviates from the catalog (mirrors the server rule).
  const [editPrices, setEditPrices] = useState<Record<string, number>>({});
  const [editReason, setEditReason] = useState("");
  // Delete/void modal
  const [confirmVoid, setConfirmVoid] = useState<{ id: string; orderNumber: string } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  // Finalize modal
  const [finalizeTarget, setFinalizeTarget] = useState<{ id: string; orderNumber: string; customerName: string; storeCustomerId: string | null; totalMinor: number; createdAt: string; dueAt: string | null } | null>(null);
  const [finalizePay, setFinalizePay] = useState<"cash" | "credit">("credit");
  const [finalizeTendered, setFinalizeTendered] = useState("");
  // After a credit finalize: what the "Text customer" button needs.
  const [finalizedInfo, setFinalizedInfo] = useState<{ orderNumber: string; totalMinor: number; customerName: string; storeCustomerId: string | null; phone: string | null; balanceMinor: number | null } | null>(null);
  const [finalizedPhone, setFinalizedPhone] = useState("");
  const [storeName, setStoreName] = useState("");
  const [finalizeStart, setFinalizeStart] = useState("");
  const [finalizeDue, setFinalizeDue] = useState("");
  const [finalizeSig, setFinalizeSig] = useState<string | null>(null);
  const [finalizeSigError, setFinalizeSigError] = useState(false);
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  // Build sub-tab state (embedded POS product-selection flow)
  const [buildProducts, setBuildProducts] = useState<PosProduct[]>([]);
  const [buildCustomers, setBuildCustomers] = useState<PosCustomer[]>([]);
  const [buildCart, setBuildCart] = useState<CartLine[]>([]);
  const [buildStep, setBuildStep] = useState<"products" | "review">("products");
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [buildCustomerId, setBuildCustomerId] = useState("");
  const [buildNewName, setBuildNewName] = useState("");
  const [buildNewPhone, setBuildNewPhone] = useState("");
  const [buildSearch, setBuildSearch] = useState("");
  const [buildCategory, setBuildCategory] = useState("");
  const [buildBusy, setBuildBusy] = useState(false);
  const [hidePrice, setHidePrice] = useState(false); // StoreSettings.hidePricePreOrder

  /** ₱— when store hides per-product prices (subtotal/total still shown). */
  const maybePrice = (minor: number) => (hidePrice ? "—" : toPesos(minor));

  const loadPreorders = useCallback(async () => {
    setPreLoading(true);
    try {
      // All pre-orders: every waiting one shows whatever its date; Done filters by date below.
      const res = await fetch(`${API_URL}/admin/pos/preorders`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load pre-orders");
      const d = await res.json();
      setPreorders(d.preorders ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load pre-orders failed");
    } finally { setPreLoading(false); }
  }, []);

  useEffect(() => { void loadPreorders(); }, [loadPreorders]);

  const loadBuilder = useCallback(async () => {
    try {
      const [p, c, s] = await Promise.all([
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setHidePrice(Boolean(s?.settings?.hidePricePreOrder));
      setStoreName(s?.store?.name ?? "");
      setBuildProducts(p.products ?? []);
      setBuildCustomers(c.customers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => { void loadBuilder(); }, [loadBuilder]);

  const inRange = (p: Preorder) => (!preFrom || p.createdAt.slice(0, 10) >= preFrom) && (!preTo || p.createdAt.slice(0, 10) <= preTo);
  const drafts = preorders.filter((p) => p.status === "ON_HOLD");
  const completed = preorders.filter((p) => p.status === "COMPLETED" && inRange(p));
  const todayStr = localToday();

  const newPreorder = () => { setSubTab("build"); setBuildStep("products"); };

  const openPreEdit = (p: Preorder) => {
    setEditPre(null);
    setEditAddId("");
    setEditPrices({});
    setEditReason("");
    fetch(`${API_URL}/admin/orders/${p.id}`, { headers: adminHeaders() })
      .then((r) => r.json())
      .then((d) => setEditPre({
        id: p.id,
        orderNumber: p.orderNumber,
        lines: (d?.items ?? []).map((i: any) => ({
          productId: i.productId ?? "",
          productName: i.productName,
          quantity: i.quantity,
          unitPriceMinor: i.unitPriceMinor,
          variantId: i.variantId ?? null,
          variantName: i.variantName ?? null,
        })),
      }))
      .catch(() => setError("Could not load pre-order items"));
  };

  /** The catalog (or variant) price a line is compared against. */
  const catalogPriceFor = (productId: string, variantId?: string | null) => {
    const product = buildProducts.find((x) => x.id === productId);
    if (!product) return 0;
    if (!variantId) return product.priceMinor;
    const variant = (product as unknown as { variants?: { id: string; priceMinor: number }[] }).variants?.find((v) => v.id === variantId);
    return variant?.priceMinor ?? product.priceMinor;
  };

  const editLinePrice = (l: EditLine) => editPrices[`${l.productId}|${l.variantId ?? ""}`] ?? l.unitPriceMinor;
  const editIsOverridden = (l: EditLine) => editLinePrice(l) !== catalogPriceFor(l.productId, l.variantId);
  const editOverriddenCount = editPre ? editPre.lines.filter(editIsOverridden).length : 0;
  const editReasonMissing = editOverriddenCount > 0 && !reasonOk(editReason);

  const setEditLinePrice = (l: EditLine, pesosText: string) => {
    const key = `${l.productId}|${l.variantId ?? ""}`;
    if (pesosText.trim() === "") { setEditPrices((prev) => { const next = { ...prev }; delete next[key]; return next; }); return; }
    const minor = Math.round(parseFloat(pesosText) * 100);
    if (!Number.isFinite(minor)) return;
    setEditPrices((prev) => ({ ...prev, [key]: minor < 0 ? 0 : minor }));
  };

  const setPreLineQty = (productId: string, qty: number) => {
    if (!editPre) return;
    setEditPre({ ...editPre, lines: qty <= 0 ? editPre.lines.filter((l) => l.productId !== productId) : editPre.lines.map((l) => (l.productId === productId ? { ...l, quantity: qty } : l)) });
  };

  /** Append a product picked from the dropdown to the draft's lines (stock delta applied server-side on save). */
  const addEditLine = () => {
    if (!editPre || !editAddId) return;
    const prod = buildProducts.find((x) => x.id === editAddId);
    if (!prod || editPre.lines.some((l) => l.productId === prod.id)) { setEditAddId(""); return; }
    setEditPre({ ...editPre, lines: [...editPre.lines, { productId: prod.id, productName: prod.name, quantity: 1, unitPriceMinor: prod.priceMinor }] });
    setEditAddId("");
  };

  const savePreEdit = async () => {
    if (!editPre) return;
    if (editReasonMissing) { setError("A short reason is required when a price differs from the catalog price."); return; }
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/pos/preorders/${editPre.id}/items`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          items: editPre.lines.map((l) => ({
            productId: l.productId,
            variantId: l.variantId ?? undefined,
            quantity: l.quantity,
            unitPriceMinorOverride: editIsOverridden(l) ? editLinePrice(l) : undefined,
            priceOverrideReason: editIsOverridden(l) ? editReason.trim() || undefined : undefined,
          })),
        }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Edit failed"); return; }
      setEditPre(null);
      toast("Updated");
      await loadPreorders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Edit failed");
    }
  };

  const doVoidPre = async () => {
    if (!confirmVoid) return;
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/pos/holds/${confirmVoid.id}/void`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ reason: voidReason.trim() || undefined }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.message ?? "Void failed"); return; }
      setConfirmVoid(null);
      setVoidReason("");
      toast("Pre-order deleted — stock released");
      await loadPreorders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Void failed");
    }
  };

  const openFinalize = (p: Preorder) => {
    setFinalizePay("credit"); setFinalizeTendered("");
    setFinalizeTarget({ id: p.id, orderNumber: p.orderNumber, customerName: p.customerName, storeCustomerId: p.storeCustomerId, totalMinor: p.totalMinor, createdAt: p.createdAt, dueAt: p.dueAt });
    setFinalizeStart(p.createdAt.slice(0, 10));
    setFinalizeDue(p.dueAt ? p.dueAt.slice(0, 10) : "");
    setFinalizeSig(null);
    setFinalizeSigError(false);
    setFinalizeError(null);
  };

  const doFinalize = async () => {
    if (!finalizeTarget) return;
    if (finalizePay === "credit" && !finalizeSig) { setFinalizeSigError(true); return; }
    setFinalizeBusy(true); setFinalizeError(null);
    try {
      const res = await fetch(`${API_URL}/admin/pos/preorders/${finalizeTarget.id}/finalize`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          paymentMethod: finalizePay,
          tenderedMinor: finalizePay === "cash" && finalizeTendered ? Math.round(Number(finalizeTendered) * 100) : undefined,
          signatureData: finalizeSig ?? undefined,
          startAt: finalizeStart ? new Date(finalizeStart).toISOString() : undefined,
          dueAt: finalizeDue ? new Date(finalizeDue).toISOString() : undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setFinalizeError(d?.errors?.join(", ") ?? d?.message ?? "Finalize failed"); return; }
      const target = finalizeTarget;
      toast(finalizePay === "cash"
        ? `Finalized — paid in cash${d.changeMinor > 0 ? ` · change ${toPesos(d.changeMinor)}` : ""} · ${d.orderNumber ?? target.orderNumber}`
        : `Finalized — charged to credit · ${d.orderNumber ?? target.orderNumber}`);
      if (finalizePay === "credit") {
        // The customer's new balance and number, so staff can text them the transaction.
        const cs = await fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const c = ((cs?.customers ?? []) as { id: string; phone: string | null; creditBalanceMinor: number }[]).find((x) => x.id === target.storeCustomerId);
        setFinalizedInfo({ orderNumber: d.orderNumber ?? target.orderNumber, totalMinor: target.totalMinor, customerName: target.customerName, storeCustomerId: target.storeCustomerId, phone: c?.phone ?? null, balanceMinor: c ? c.creditBalanceMinor : null });
        setFinalizedPhone(c?.phone ?? "");
      }
      setFinalizeTarget(null);
      setLastFinalizedOrderId(d.orderId ?? finalizeTarget.id);
      await loadPreorders();
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Finalize failed");
    } finally { setFinalizeBusy(false); }
  };

  // ── Build sub-tab: embedded POS product-selection flow ──
  const buildSubtotal = buildCart.reduce((s, l) => s + unitOf(l) * l.quantity, 0);

  const addProduct = (product: PosProduct) => {
    setError(null);
    setBuildCart((c) => {
      const found = c.find((l) => l.product.id === product.id);
      if (found) {
        return c.map((l) => (l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...c, { product, quantity: 1 }];
    });
  };

  const setQty = (productId: string, qty: number) => {
    setBuildCart((c) => (qty <= 0 ? c.filter((l) => l.product.id !== productId) : c.map((l) => (l.product.id === productId ? { ...l, quantity: qty } : l))));
  };

  // Customer: select existing, or quick-create (autosave) by name/phone.
  const ensureCustomer = async (): Promise<string | null> => {
    if (buildCustomerId) return buildCustomerId;
    if (!buildNewName.trim()) return null;
    const res = await fetch(`${API_URL}/admin/pos/quick-customer`, {
      method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ name: buildNewName.trim(), phone: buildNewPhone.trim() || undefined }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    setBuildCustomerId(d.id);
    await loadBuilder();
    return d.id;
  };

  // Save the built cart as an ON_HOLD pre-order draft, then jump to the list.
  const savePreorder = async () => {
    if (buildCart.length === 0) { setError("Cart is empty"); return; }
    if (buildCart.some(priceMissingReason)) { setError("Write a short reason for every price you changed."); return; }
    setBuildBusy(true); setError(null);
    try {
      const customer = await ensureCustomer();
      if (!customer) { setError("Select or add a customer for pre-orders"); setBuildBusy(false); return; }
      const res = await fetch(`${API_URL}/admin/pos/preorder`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          items: buildCart.map((l) => ({ productId: l.product.id, quantity: l.quantity, ...(l.price !== undefined && l.price !== l.product.priceMinor ? { unitPriceMinorOverride: l.price, priceOverrideReason: l.reason } : {}) })),
          customerId: customer,
          startAt: undefined,
          dueAt: undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.errors?.join(", ") ?? data?.message ?? "Pre-order failed"); return; }
      toast(`Pre-order saved — ${data.orderNumber}`);
      setBuildCart([]); setBuildCustomerId(""); setBuildNewName(""); setBuildNewPhone("");
      setBuildSearch(""); setBuildCategory(""); setBuildStep("products");
      await loadPreorders();
      setSubTab("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pre-order failed");
    } finally { setBuildBusy(false); }
  };

  const buildCategories = [...new Set(buildProducts.map((p) => p.category?.name).filter(Boolean))] as string[];
  const buildFiltered = buildProducts.filter((p) => {
    const q = buildSearch.trim().toLowerCase();
    const inSearch = !q || (p.name + p.sku).toLowerCase().includes(q);
    const inCat = !buildCategory || p.category?.name === buildCategory;
    return inSearch && inCat;
  });

  const itemCount = (p: Preorder) => p.items.reduce((s, i) => s + i.quantity, 0);

  /**
   * Items WITH their quantity ("3 × Iced Kape") instead of a bare count, so staff can
   * see what a pre-order actually holds without opening it. Long lists stay readable:
   * the first `max` lines are shown and the rest collapse behind "+N more" (full list
   * in the tooltip).
   */
  const itemLines = (p: Preorder, max = 3) => (
    <>
      {p.items.slice(0, max).map((it) => (
        <div key={`${it.productId}|${it.variantId ?? ""}`} className="small text-nowrap">
          <span className="fw-semibold">{it.quantity} ×</span> {it.productName}
          {it.variantName ? <span className="text-muted"> · {it.variantName}</span> : null}
        </div>
      ))}
      {p.items.length > max && (
        <div className="small text-muted" title={p.items.map((i) => `${i.quantity} × ${i.productName}`).join("\n")}>
          +{p.items.length - max} more
        </div>
      )}
      {p.items.length === 0 && <span className="small text-muted">no items</span>}
    </>
  );

  /** Aggregate pre-order items: how many units of each product are on hold (draft) vs sold (finalized) in the current range. */
  const holdSoldRows = () => {
    const map: Record<string, { productName: string; holdQty: number; soldQty: number }> = {};
    for (const p of preorders.filter(inRange)) {
      const kind = p.status === "ON_HOLD" ? "hold" : p.status === "COMPLETED" ? "sold" : null;
      if (!kind) continue;
      for (const it of p.items) {
        const e = map[it.productId] ?? (map[it.productId] = { productName: it.productName, holdQty: 0, soldQty: 0 });
        if (kind === "hold") e.holdQty += it.quantity; else e.soldQty += it.quantity;
      }
    }
    return Object.values(map).sort((a, b) => (b.holdQty + b.soldQty) - (a.holdQty + a.soldQty));
  };

  /** One pre-order as a card: who, what, how much, then the actions (Complete sale first). */
  const preCard = (p: Preorder, finalizeOnly: boolean, pastDue: boolean) => (
    <div className="col" key={p.id}>
      <div className={`card h-100 ${pastDue ? "border-danger" : ""}`}>
        <div className="card-body d-flex flex-column">
          <div className="d-flex justify-content-between align-items-start gap-2 mb-1">
            <div>
              <div className="fw-bold">{p.customerName || "—"}</div>
              <div className="small text-muted">{p.orderNumber} · {fmtDate(p.createdAt)}</div>
            </div>
            <div className="fw-bold fs-5 text-end" style={{ fontVariantNumeric: "tabular-nums" }}>{maybePrice(p.totalMinor)}</div>
          </div>
          {p.dueAt && <div className={`small mb-1 ${pastDue ? "text-danger fw-semibold" : "text-muted"}`}>Due {fmtDate(p.dueAt)}{pastDue ? " (late)" : ""}</div>}
          <div className="mb-2 flex-grow-1">{itemLines(p, 4)}</div>
          {p.status === "ON_HOLD" && (
            <>
              <button className="btn btn-success w-100 mb-2" onClick={() => openFinalize(p)}><i className="bi bi-check2-circle me-1"></i>Complete sale</button>
              {!finalizeOnly && (
                <div className="d-flex gap-2">
                  <button className="btn btn-outline-dark flex-fill" onClick={() => openPreEdit(p)}><i className="bi bi-pencil me-1"></i>Edit</button>
                  <button className="btn btn-outline-danger flex-fill" onClick={() => { setConfirmVoid({ id: p.id, orderNumber: p.orderNumber }); setVoidReason(""); }}><i className="bi bi-x-circle me-1"></i>Delete</button>
                </div>
              )}
            </>
          )}
          {p.status === "COMPLETED" && (
            <button className="btn btn-outline-dark w-100" onClick={() => setReceiptOrder(p.id)}><i className="bi bi-receipt me-1"></i>Receipt</button>
          )}
        </div>
      </div>
    </div>
  );

  const renderDrafts = (finalizeOnly: boolean) => {
    if (preLoading) return <p className="text-muted">Loading pre-orders…</p>;
    const rows = finalizeOnly ? completed : drafts;
    const summary = finalizeOnly ? holdSoldRows() : [];
    if (rows.length === 0 && summary.length === 0) {
      return (
        <div className="text-muted text-center py-5">
          <i className={`${finalizeOnly ? "bi bi-check2-circle" : "bi bi-bag-check"} fs-1 d-block mb-2`}></i>
          {finalizeOnly ? "No completed pre-orders on these dates." : "No pre-orders waiting."}
          {!finalizeOnly && (
            <div className="mt-3">
              <button className="btn btn-success btn-lg" onClick={newPreorder}><i className="bi bi-plus-lg me-1"></i>New pre-order</button>
            </div>
          )}
        </div>
      );
    }
    return (
      <>
        {finalizeOnly && summary.length > 0 && (
          <div className="card mb-2">
            <div className="card-body py-2">
              <h6 className="small fw-bold mb-1"><i className="bi bi-box-seam me-1"></i>Products — on hold vs sold</h6>
              <div className="small text-muted mb-1">
                {preFrom && preTo ? `${preFrom} to ${preTo}` : "All dates"} · counts follow the dates above.
              </div>
              <table className="table table-sm align-middle mb-1">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="text-center">On hold</th>
                    <th className="text-center">Sold</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((r) => (
                    <tr key={r.productName}>
                      <td className="small">{r.productName}</td>
                      <td className={`text-center fw-semibold ${r.holdQty > 0 ? "text-warning" : "text-muted"}`}>{r.holdQty}</td>
                      <td className={`text-center fw-semibold ${r.soldQty > 0 ? "text-success" : "text-muted"}`}>{r.soldQty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small text-muted">On hold = reserved in open drafts · Sold = finalized pre-orders.</div>
            </div>
          </div>
        )}
        {rows.length === 0 ? (
          <p className="text-muted text-center py-4">
            <i className="bi bi-journal-text fs-3 d-block mb-2"></i>
            {finalizeOnly ? "No completed pre-orders on these dates." : "No pre-orders waiting."}
          </p>
        ) : (
          <>
            <div className="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3">
              {rows.map((p) => preCard(p, finalizeOnly, p.status === "ON_HOLD" && !!p.dueAt && p.dueAt.slice(0, 10) < todayStr))}
            </div>
          </>
        )}
      </>
    );
  };

  const inOrder = (productId: string) => buildCart.find((l) => l.product.id === productId)?.quantity ?? 0;
  const itemsInOrder = buildCart.reduce((s, l) => s + l.quantity, 0);
  const setLinePrice = (l: CartLine, v: string) => {
    const m = v === "" ? undefined : Math.round(Number(v) * 100);
    const same = m === undefined || m === l.product.priceMinor;
    setBuildCart((c) => c.map((x) => (x.product.id === l.product.id ? { ...x, price: same ? undefined : m, reason: same ? undefined : x.reason } : x)));
  };

  const renderBuild = () => (
    <>
      {buildStep === "products" && newItemOpen && (
        <NewItemForm preorder onCancel={() => setNewItemOpen(false)} onDone={async () => { setNewItemOpen(false); await loadBuilder(); }} />
      )}
      {buildStep === "products" && !newItemOpen && (
        <>
          <div className="text-center text-muted mb-2">Step 1 of 2 · Tap what the customer wants</div>
          <input className="form-control form-control-lg mb-2" placeholder="Search (name or first letters)" aria-label="Search" value={buildSearch} onChange={(e) => setBuildSearch(e.target.value)} />
          {buildCategories.length > 1 && (
            <div className="d-flex flex-wrap justify-content-center gap-2 mb-2">
              <button className={`btn ${buildCategory === "" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setBuildCategory("")}>All</button>
              {buildCategories.map((c) => (
                <button key={c} className={`btn ${buildCategory === c ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setBuildCategory(buildCategory === c ? "" : c)}>{c}</button>
              ))}
            </div>
          )}

          {buildProducts.length === 0 && <p className="text-muted text-center py-4">Loading products…</p>}
          {buildFiltered.length === 0 && buildProducts.length > 0 && <p className="text-muted text-center py-4">No products match.</p>}

          <div className="row g-2 mb-3">
            {buildFiltered.map((p) => {
              const n = inOrder(p.id);
              return (
                <div className="col-6 col-md-4 col-lg-3" key={p.id}>
                  <button type="button" className={`btn ${n > 0 ? "btn-dark" : "btn-outline-dark"} w-100 h-100 p-2 text-center position-relative`} style={{ minHeight: 120 }}
                    aria-label={`${p.name}${n > 0 ? `, ${n} in this order` : ""}`} onClick={() => addProduct(p)}>
                    {n > 0 && <span className="position-absolute top-0 end-0 badge rounded-pill text-bg-success m-1">{n}</span>}
                    <div className="fw-semibold">{p.name}</div>
                    <div style={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }}>{maybePrice(p.priceMinor)}</div>
                    <div className="small">{p.availableQuantity <= 0 ? "None in stock yet" : `${p.availableQuantity} in stock`}</div>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="text-center mb-3">
            <button type="button" className="btn btn-outline-secondary" onClick={() => setNewItemOpen(true)}>+ New item (not on the list yet)</button>
          </div>

          <div className="position-sticky bottom-0 sticky-above-bar bg-white border border-success rounded shadow-sm d-flex align-items-center justify-content-between gap-2 px-3 py-2" style={{ zIndex: 5 }}>
            <div style={{ fontVariantNumeric: "tabular-nums" }}>
              <div className="fw-bold fs-5">{maybePrice(buildSubtotal)}</div>
              <div className="text-muted small">{itemsInOrder} item{itemsInOrder === 1 ? "" : "s"}</div>
            </div>
            <button className="btn btn-success btn-lg" disabled={buildCart.length === 0} onClick={() => { setError(null); setBuildStep("review"); }}>
              Next <i className="bi bi-arrow-right ms-1"></i>
            </button>
          </div>
        </>
      )}

      {buildStep === "review" && (
        <div className="mx-auto" style={{ maxWidth: 640 }}>
          <div className="text-center text-muted mb-2">Step 2 of 2 · Who is it for?</div>
          <div className="card mb-3">
            <div className="card-body">
              <label className="form-label fw-semibold" htmlFor="po-cust">Customer</label>
              <select id="po-cust" className="form-select form-select-lg" value={buildCustomerId} onChange={(e) => { setBuildCustomerId(e.target.value); if (e.target.value) { setBuildNewName(""); setBuildNewPhone(""); } }}>
                <option value="">Choose a customer…</option>
                {buildCustomers.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.phone ?? "Customer"}</option>)}
              </select>
              {!buildCustomerId && (
                <>
                  <div className="text-center text-muted my-2">or a new customer</div>
                  <div className="row g-2">
                    <div className="col-sm-7"><input className="form-control form-control-lg" aria-label="New customer's name" placeholder="Name" value={buildNewName} onChange={(e) => setBuildNewName(e.target.value)} /></div>
                    <div className="col-sm-5"><input className="form-control form-control-lg" inputMode="tel" aria-label="New customer's mobile number" placeholder="Mobile (optional)" value={buildNewPhone} onChange={(e) => setBuildNewPhone(e.target.value)} /></div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="card mb-3">
            <div className="card-body">
              {buildCart.length === 0 && <p className="text-muted text-center py-3 mb-0">No items. Go back and tap products.</p>}
              {buildCart.map((l) => (
                <div key={l.product.id} className="border-bottom py-2">
                  <div className="d-flex justify-content-between align-items-baseline gap-2">
                    <div className="fw-semibold">{l.product.name}</div>
                    <div className="fw-semibold text-end text-nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>{maybePrice(unitOf(l) * l.quantity)}</div>
                  </div>
                  <div className="d-flex justify-content-between align-items-center gap-2 mt-1">
                    <div className="small text-muted">{maybePrice(unitOf(l))} each{l.price !== undefined && l.price !== l.product.priceMinor ? ` (list ${maybePrice(l.product.priceMinor)})` : ""}</div>
                    <div className="d-flex align-items-center gap-1">
                      <button type="button" className="btn btn-outline-dark" style={{ width: 48 }} aria-label={`One less ${l.product.name}`} onClick={() => setQty(l.product.id, l.quantity - 1)}>−</button>
                      <span className="fw-bold text-center" style={{ minWidth: 40, fontVariantNumeric: "tabular-nums" }} aria-live="polite">{l.quantity}</span>
                      <button type="button" className="btn btn-outline-dark" style={{ width: 48 }} aria-label={`One more ${l.product.name}`} onClick={() => setQty(l.product.id, l.quantity + 1)}>+</button>
                    </div>
                  </div>
                  <details className="mt-1">
                    <summary className="small text-primary" style={{ cursor: "pointer" }}>Change price</summary>
                    <div className="d-flex flex-wrap gap-2 mt-1">
                      <PesoInput className="form-control" style={{ maxWidth: 160 }} aria-label={`Price of ${l.product.name}`}
                        value={l.price !== undefined ? String(l.price / 100) : ""} placeholder={(l.product.priceMinor / 100).toFixed(2)} onChange={(v) => setLinePrice(l, v)} />
                      {l.price !== undefined && l.price !== l.product.priceMinor && (
                        <PriceReason className="form-select flex-grow-1" invalid={priceMissingReason(l)} value={l.reason ?? ""} onChange={(v) => setBuildCart((c) => c.map((x) => (x.product.id === l.product.id ? { ...x, reason: v } : x)))} />
                      )}
                    </div>
                  </details>
                </div>
              ))}
              <div className="d-flex justify-content-between align-items-baseline mt-3" style={{ fontVariantNumeric: "tabular-nums" }}>
                <span className="fs-5">Total</span><span className="fw-bold" style={{ fontSize: 28 }}>{maybePrice(buildSubtotal)}</span>
              </div>
            </div>
          </div>

          <div className="position-sticky bottom-0 sticky-above-bar bg-white border border-success rounded shadow-sm d-flex gap-2 p-2 mb-2" style={{ zIndex: 5 }}>
            <button className="btn btn-outline-secondary btn-lg" onClick={() => setBuildStep("products")}>Back</button>
            <button className="btn btn-success btn-lg flex-fill" disabled={buildCart.length === 0 || buildBusy || (!buildCustomerId && !buildNewName.trim())} onClick={savePreorder}>
              <i className="bi bi-bag-check me-1"></i>{buildBusy ? "Saving…" : "Save pre-order"}
            </button>
          </div>
          {!buildCustomerId && !buildNewName.trim() && <div className="text-center text-muted small">Choose a customer or type a new name to save.</div>}
        </div>
      )}
    </>
  );

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">{subTab === "build" ? "New pre-order" : "Pre-order"}</h1>
        {subTab === "build" ? (
          <button className="btn btn-outline-dark" onClick={() => { setSubTab("list"); setBuildStep("products"); setNewItemOpen(false); }}>
            <i className="bi bi-arrow-left me-1"></i>Back to list
          </button>
        ) : (
          <button className="btn btn-success btn-lg" onClick={newPreorder}><i className="bi bi-plus-lg me-1"></i>New pre-order</button>
        )}
      </div>

      {lastFinalizedOrderId && (
        <div className="d-flex align-items-center justify-content-center gap-2 mb-2">
          <span className="text-muted">Sale completed.</span>
          <button className="btn btn-outline-dark" onClick={() => { setReceiptOrder(lastFinalizedOrderId); setLastFinalizedOrderId(null); }}>
            <i className="bi bi-printer me-1"></i>Print receipt
          </button>
        </div>
      )}

      {error && <div className="alert alert-danger py-2">{error}</div>}
      {receiptOrder && <ReceiptModal orderId={receiptOrder} onClose={() => setReceiptOrder(null)} />}

      {subTab !== "build" && (
        <div className="btn-group w-100 mb-3" role="group" aria-label="Pre-order list">
          <button type="button" className={`btn btn-lg ${subTab === "list" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={subTab === "list"} onClick={() => setSubTab("list")}>Waiting ({drafts.length})</button>
          <button type="button" className={`btn btn-lg ${subTab === "finalize" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={subTab === "finalize"} onClick={() => setSubTab("finalize")}>Done</button>
        </div>
      )}

      {/* dates: only the Done list (every waiting pre-order always shows) */}
      {subTab === "finalize" && (
        <div className="d-flex flex-wrap gap-2 align-items-center justify-content-center mb-3">
          <label className="form-label mb-0" htmlFor="po-from">From</label>
          <input id="po-from" className="form-control" style={{ width: 170 }} type="date" value={preFrom} onChange={(e) => setPreFrom(e.target.value)} />
          <label className="form-label mb-0" htmlFor="po-to">To</label>
          <input id="po-to" className="form-control" style={{ width: 170 }} type="date" value={preTo} onChange={(e) => setPreTo(e.target.value)} />
        </div>
      )}

      {subTab === "list" ? renderDrafts(false) : subTab === "finalize" ? renderDrafts(true) : renderBuild()}

      {/* Edit pre-order modal */}
      {editPre && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Edit {editPre.orderNumber}</h5>
                  <button type="button" className="btn-close" onClick={() => setEditPre(null)}></button>
                </div>
                <div className="modal-body">
                  {editPre.lines.length === 0 ? (
                    <p className="text-muted small">No lines yet.</p>
                  ) : (
                    editPre.lines.map((l) => (
                      <div key={`${l.productId}|${l.variantId ?? ""}`} className="d-flex align-items-center gap-2 mb-1 flex-wrap">
                        <span className="flex-grow-1 small">
                          {l.productName}
                          {l.variantName ? <span className="text-muted"> · {l.variantName}</span> : null}
                        </span>
                        {/* Price is editable even when the store hides prices (hiding is a display rule). */}
                        <div className="input-group input-group-sm" style={{ width: 118 }}>
                          <span className="input-group-text">₱</span>
                          <input
                            className={`form-control ${editIsOverridden(l) ? "border-warning bg-warning-subtle" : ""}`}
                            type="number" inputMode="decimal" min="0" step="0.01"
                            aria-label={`Price for ${l.productName}`}
                            value={(editLinePrice(l) / 100).toString()}
                            onChange={(e) => setEditLinePrice(l, e.target.value)}
                          />
                        </div>
                        <div className="input-group input-group-sm" style={{ width: 96 }}>
                          <button className="btn btn-outline-secondary" onClick={() => setPreLineQty(l.productId, l.quantity - 1)}>-</button>
                          <input className="form-control text-center" type="number" min={1} aria-label={`Quantity for ${l.productName}`} value={l.quantity} onChange={(e) => { const v = parseInt(e.target.value, 10); if (v >= 1) setPreLineQty(l.productId, v); }} />
                          <button className="btn btn-outline-secondary" onClick={() => setPreLineQty(l.productId, l.quantity + 1)}>+</button>
                        </div>
                        {editIsOverridden(l) && <span className="badge text-bg-warning">edited</span>}
                        <button className="btn btn-sm btn-outline-danger py-0" title="Remove line" onClick={() => setPreLineQty(l.productId, 0)}><i className="bi bi-x"></i></button>
                      </div>
                    ))
                  )}
                  {editOverriddenCount > 0 && (
                    <div className="mt-2">
                      <label className="form-label small mb-1" htmlFor="preEditPriceReason">
                        Reason for the price change{editReasonMissing ? " *" : ""}
                      </label>
                      <PriceReason id="preEditPriceReason" className="form-select form-select-sm" invalid={editReasonMissing} value={editReason} onChange={setEditReason} />
                      <div className="invalid-feedback">A short reason is required when a price differs from the catalog.</div>
                    </div>
                  )}
                  <div className="d-flex gap-2 mt-2">
                    <select className="form-select form-select-sm flex-grow-1" value={editAddId} onChange={(e) => setEditAddId(e.target.value)}>
                      <option value="">＋ Add another item…</option>
                      {buildProducts.filter((x) => !editPre.lines.some((l) => l.productId === x.id)).map((x) => (
                        <option key={x.id} value={x.id}>{x.name} — {maybePrice(x.priceMinor)}{x.availableQuantity <= 0 ? " (out of stock)" : ""}</option>
                      ))}
                    </select>
                    <button className="btn btn-outline-secondary btn-sm" disabled={!editAddId} onClick={addEditLine}>
                      <i className="bi bi-plus-lg me-1"></i>Add
                    </button>
                  </div>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setEditPre(null)}>Cancel</button>
                  <button className="btn btn-primary" disabled={editReasonMissing} onClick={savePreEdit}>Save changes</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Delete pre-order confirm */}
      {confirmVoid && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Delete {confirmVoid.orderNumber}</h5>
                  <button type="button" className="btn-close" onClick={() => setConfirmVoid(null)}></button>
                </div>
                <div className="modal-body">
                  <p className="small">This cancels the draft pre-order and restores stock.</p>
                  <textarea className="form-control form-control-sm" rows={2} placeholder="Reason (optional)" value={voidReason} onChange={(e) => setVoidReason(e.target.value)}></textarea>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setConfirmVoid(null)}>Cancel</button>
                  <button className="btn btn-danger" onClick={doVoidPre}>Delete</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Finalize pre-order modal */}
      {finalizedInfo && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Charged to credit</h5>
                  <button type="button" className="btn-close" onClick={() => setFinalizedInfo(null)}></button>
                </div>
                <div className="modal-body">
                  <div className="alert alert-success py-2">{finalizedInfo.orderNumber} — {toPesos(finalizedInfo.totalMinor)} on {finalizedInfo.customerName || "the customer"}'s credit.</div>
                  {!finalizedInfo.phone && (
                    <input className="form-control mb-2" inputMode="tel" placeholder="Mobile number (09…)" value={finalizedPhone} onChange={(e) => setFinalizedPhone(e.target.value)} />
                  )}
                  <button type="button" className="btn btn-primary w-100" onClick={() => {
                    const text = buildText("preorder_credit", { storeName: storeName || "SAM STORE", customerName: finalizedInfo.customerName, reference: finalizedInfo.orderNumber, totalMinor: finalizedInfo.totalMinor, balanceMinor: finalizedInfo.balanceMinor ?? finalizedInfo.totalMinor });
                    const phone = finalizedInfo.phone || finalizedPhone;
                    if (!openTextApp({ phone, text, template: "preorder_credit", storeCustomerId: finalizedInfo.storeCustomerId, documentType: "PRE_ORDER" })) { toast("That is not a mobile number", "danger"); return; }
                    if (!finalizedInfo.phone && finalizedInfo.storeCustomerId) void fetch(`${API_URL}/admin/customers/${finalizedInfo.storeCustomerId}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ phone }) }).catch(() => {});
                  }}><i className="bi bi-chat-dots me-1"></i>Text the customer this transaction</button>
                </div>
                <div className="modal-footer"><button className="btn btn-outline-secondary" onClick={() => setFinalizedInfo(null)}>Close</button></div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
      {finalizeTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Finalize {finalizeTarget.orderNumber}</h5>
                  <button type="button" className="btn-close" onClick={() => setFinalizeTarget(null)}></button>
                </div>
                <div className="modal-body">
                  {finalizeError && <div className="alert alert-danger py-2 small">{finalizeError}</div>}
                  <div className="small mb-2">
                    <div>Customer: <strong>{finalizeTarget.customerName || "—"}</strong></div>
                    <div>Total: <strong>{toPesos(finalizeTarget.totalMinor)}</strong></div>
                  </div>
                  <div className="row g-2 mb-2">
                    <div className="col-6">
                      <label className="form-label small">Start date</label>
                      <input className="form-control form-control-sm" type="date" value={finalizeStart} onChange={(e) => setFinalizeStart(e.target.value)} />
                    </div>
                    <div className="col-6">
                      <label className="form-label small">Due date</label>
                      <input className="form-control form-control-sm" type="date" value={finalizeDue} onChange={(e) => setFinalizeDue(e.target.value)} />
                    </div>
                  </div>
                  <div className="small text-muted mb-1">How is the customer paying?</div>
                  <div className="btn-group w-100 mb-2" role="group" aria-label="Payment method">
                    <button type="button" className={`btn ${finalizePay === "cash" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setFinalizePay("cash")}><i className="bi bi-cash me-1"></i>Cash</button>
                    <button type="button" className={`btn ${finalizePay === "credit" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setFinalizePay("credit")}><i className="bi bi-journal-text me-1"></i>Credit (utang)</button>
                  </div>
                  {finalizePay === "cash" ? (
                    <div className="mb-2">
                      <label className="form-label small">Cash received (₱) <span className="text-muted">— optional, to work out the change</span></label>
                      <PesoInput value={finalizeTendered} onChange={setFinalizeTendered} placeholder="0.00" />
                      {finalizeTendered && Number(finalizeTendered) * 100 < finalizeTarget.totalMinor && <div className="text-danger small">Less than the total ({toPesos(finalizeTarget.totalMinor)}).</div>}
                      {finalizeTendered && Number(finalizeTendered) * 100 >= finalizeTarget.totalMinor && <div className="small">Change: <strong>{toPesos(Math.round(Number(finalizeTendered) * 100) - finalizeTarget.totalMinor)}</strong></div>}
                    </div>
                  ) : (
                    <>
                      <div className="small text-muted mb-1">Customer signature</div>
                      <SignaturePad onSignature={(d) => { setFinalizeSig(d); if (d) setFinalizeSigError(false); }} />
                      {finalizeSigError && <div className="text-danger small">Signature required — please sign above.</div>}
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setFinalizeTarget(null)}>Close</button>
                  <button className="btn btn-success" disabled={(finalizePay === "credit" && !finalizeSig) || (finalizePay === "cash" && !!finalizeTendered && Number(finalizeTendered) * 100 < finalizeTarget.totalMinor) || finalizeBusy} onClick={doFinalize}>
                    {finalizeBusy ? "Finalizing…" : "Complete"}
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