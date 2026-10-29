"use client";

// Pre Order panel — dedicated sidebar tab (Sell group). Two lists and one screen:
// 'Waiting' (ON_HOLD pre-orders: change, delete, complete with cash or credit) and
// 'Done' (completed ones by date, with receipts), both under the on hold / sold totals.
// New and Change use one screen: 1 who, 2 tap items, 3 check amounts and prices → save.
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
import { useMediaQuery, WIDE } from "../../lib/use-media-query";
import { quickCash } from "../../lib/quick-cash";
import { peso } from "../../lib/number-format";
import ProductFinder from "./ProductFinder";
import { noteUse } from "../../lib/product-find";
import { printSlip, type Slip } from "../../lib/slip-print";
import { cachedGet, offlineRef, useOffline } from "../../lib/offlineCache";
import { QUEUE_EVENT, queuedSteps, sendStep } from "../../lib/offlineQueue";
import { newSaleKey } from "../../lib/saleKey";

const PREORDER_PATH = "/admin/pos/preorder";
/** Pre-orders saved on this tablet with no internet, not on the server yet (shown with Print only). */
const waitingHere = (): Preorder[] => queuedSteps().filter((s) => s.path === PREORDER_PATH && s.view).map((s) => s.view as Preorder);
const FINALIZE_PATH = /^\/admin\/pos\/preorders\/[^/]+\/finalize$/;
/** Pre-orders completed on this tablet with no internet: shown under Done until they upload. */
const doneHere = (): Preorder[] => queuedSteps().filter((s) => FINALIZE_PATH.test(s.path) && s.view).map((s) => s.view as Preorder);

interface Preorder {
  id: string; orderNumber: string; customerName: string; storeCustomerId: string | null;
  status: string; totalMinor: number; createdAt: string; dueAt: string | null;
  items: { productId: string; productName: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number; variantId?: string | null; variantName?: string | null; priceOverridden?: boolean }[];
  /** Completed on this tablet, not uploaded yet: how it was paid. */
  paidBy?: "cash" | "credit"; changeMinor?: number; completedAt?: string;
}
interface PosProduct {
  id: string; name: string; sku: string; priceMinor: number;
  availableQuantity: number; category: { name: string } | null;
}
interface PosCustomer { id: string; name: string | null; email: string | null; phone: string | null; }
interface CartLine { product: PosProduct; quantity: number; variantId?: string | null; /** What is typed in the price box, kept while typing. */ priceText?: string; /** Manual price (centavos each) when it differs from the list price. */ price?: number; reason?: string }
const unitOf = (l: CartLine) => l.price ?? l.product.priceMinor;
const priceMissingReason = (l: CartLine) => l.price !== undefined && l.price !== l.product.priceMinor && !reasonOk(l.reason);

const toPesos = peso;
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDate = (iso: string) => iso.slice(0, 10);
// The sleeping beta server (or a slow one) makes the web's /backend proxy answer a plain
// "Internal Server Error" page after 30 s. Reading that as JSON showed "Unexpected token".
const readJson = (res: Response) => res.json().catch(() => null);
const SLOW_SERVER = "The server took too long to answer (it may have been asleep). Check the Waiting list before you save again: the pre-order may already be there.";

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


/** A numbered circle that starts each part of the pre-order screen (1 who, 2 items, 3 check). */
const Num = ({ n }: { n: number }) => (
  <span aria-hidden="true" className="rounded-circle bg-dark text-white d-inline-flex align-items-center justify-content-center me-2" style={{ width: 32, height: 32, fontSize: 18 }}>{n}</span>
);

export default function PreOrdersPanel({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [subTab, setSubTab] = useState<"list" | "finalize" | "build">("list");
  const [preFrom, setPreFrom] = useState(localToday());
  const [preTo, setPreTo] = useState(localToday());
  const [preorders, setPreorders] = useState<Preorder[]>([]);
  const [here, setHere] = useState<Preorder[]>([]); // saved on this tablet, waiting for the internet
  const [doneLocal, setDoneLocal] = useState<Preorder[]>([]); // completed on this tablet, waiting for the internet
  const [localReceipt, setLocalReceipt] = useState<Slip | null>(null);
  const offline = useOffline(); // change / delete need the internet (complete works offline)
  const [preLoading, setPreLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receiptOrder, setReceiptOrder] = useState<string | null>(null);
  const [lastFinalizedOrderId, setLastFinalizedOrderId] = useState<string | null>(null);
  // Changing a waiting pre-order opens the same screen as a new one, with its lines loaded.
  const [editingPre, setEditingPre] = useState<{ id: string; orderNumber: string; customerName: string } | null>(null);
  // Delete/void modal
  const [confirmVoid, setConfirmVoid] = useState<{ id: string; orderNumber: string } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  // Finalize modal
  const [finalizeTarget, setFinalizeTarget] = useState<{ id: string; orderNumber: string; customerName: string; storeCustomerId: string | null; totalMinor: number; createdAt: string; dueAt: string | null } | null>(null);
  const [finalizePay, setFinalizePay] = useState<"cash" | "credit">("cash");
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

  // New / change pre-order screen
  const [buildProducts, setBuildProducts] = useState<PosProduct[]>([]);
  const [buildCustomers, setBuildCustomers] = useState<PosCustomer[]>([]);
  const [buildCart, setBuildCart] = useState<CartLine[]>([]);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [buildCustomerId, setBuildCustomerId] = useState("");
  const [buildNewName, setBuildNewName] = useState("");
  const [buildNewPhone, setBuildNewPhone] = useState("");
  const [buildBusy, setBuildBusy] = useState(false);
  const [hidePrice, setHidePrice] = useState(false); // StoreSettings.hidePricePreOrder
  const wide = useMediaQuery(WIDE);

  /** ₱— when store hides per-product prices (subtotal/total still shown). */
  const maybePrice = (minor: number) => (hidePrice ? "—" : toPesos(minor));

  const loadPreorders = useCallback(async () => {
    setPreLoading(true);
    try {
      // All pre-orders: every waiting one shows whatever its date; Done filters by date below.
      // Offline in the store: the list last saved on this tablet.
      const d = await cachedGet<{ preorders?: Preorder[] }>("/admin/pos/preorders");
      if (!d) throw new Error("Failed to load pre-orders");
      setPreorders(d.preorders ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load pre-orders failed");
    } finally { setPreLoading(false); }
  }, []);

  useEffect(() => { void loadPreorders(); }, [loadPreorders]);
  // When a pre-order saved offline reaches the server, show the list from the server again.
  useEffect(() => {
    let count = waitingHere().length + doneHere().length;
    const refresh = () => {
      const now = waitingHere();
      const fin = doneHere();
      setHere(now);
      setDoneLocal(fin);
      if (now.length + fin.length < count) void loadPreorders();
      count = now.length + fin.length;
    };
    refresh();
    window.addEventListener(QUEUE_EVENT, refresh);
    return () => window.removeEventListener(QUEUE_EVENT, refresh);
  }, [loadPreorders]);

  const loadBuilder = useCallback(async () => {
    try {
      const [p, c, s] = await Promise.all([
        cachedGet<{ products?: PosProduct[] }>("/admin/products"),
        cachedGet<{ customers?: PosCustomer[] }>("/admin/customers"),
        cachedGet<{ settings?: { hidePricePreOrder?: boolean }; name?: string }>("/admin/settings"),
      ]);
      setHidePrice(Boolean(s?.settings?.hidePricePreOrder));
      setStoreName(s?.name ?? "");
      setBuildProducts(p?.products ?? []);
      setBuildCustomers(c?.customers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => { void loadBuilder(); }, [loadBuilder]);

  const inRange = (p: Preorder) => (!preFrom || p.createdAt.slice(0, 10) >= preFrom) && (!preTo || p.createdAt.slice(0, 10) <= preTo);
  const drafts = preorders.filter((p) => p.status === "ON_HOLD" && !doneLocal.some((d) => d.id === p.id));
  const completed = preorders.filter((p) => p.status === "COMPLETED" && inRange(p));
  const todayStr = localToday();

  const clearBuild = () => {
    setBuildCart([]); setBuildCustomerId(""); setBuildNewName(""); setBuildNewPhone("");
    setNewItemOpen(false); setEditingPre(null);
  };
  const newPreorder = () => { if (editingPre) clearBuild(); setError(null); setSubTab("build"); };
  const backToList = () => { if (editingPre) clearBuild(); setNewItemOpen(false); setError(null); setSubTab("list"); };

  /** The catalog (or variant) price a line is compared against. */
  const catalogPriceFor = (productId: string, variantId?: string | null) => {
    const product = buildProducts.find((x) => x.id === productId);
    if (!product) return 0;
    if (!variantId) return product.priceMinor;
    const variant = (product as unknown as { variants?: { id: string; priceMinor: number }[] }).variants?.find((v) => v.id === variantId);
    return variant?.priceMinor ?? product.priceMinor;
  };

  const openPreEdit = async (p: Preorder) => {
    setError(null);
    const d = await fetch(`${API_URL}/admin/orders/${p.id}`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!d?.items) { setError("Could not load pre-order items"); return; }
    const lines: CartLine[] = (d.items as { productId: string | null; productName: string; quantity: number; unitPriceMinor: number; variantId?: string | null; variantName?: string | null; priceOverrideReason?: string | null }[]).map((i) => {
      const known = buildProducts.find((x) => x.id === i.productId);
      const list = known ? catalogPriceFor(known.id, i.variantId) : i.unitPriceMinor;
      const product: PosProduct = {
        ...(known ?? { id: i.productId ?? "", sku: "", availableQuantity: 0, category: null }),
        name: i.variantName ? `${i.productName} · ${i.variantName}` : i.productName,
        priceMinor: list,
      } as PosProduct;
      const changed = i.unitPriceMinor !== list;
      return { product, quantity: i.quantity, variantId: i.variantId ?? null, price: changed ? i.unitPriceMinor : undefined, reason: changed ? i.priceOverrideReason ?? undefined : undefined };
    });
    clearBuild();
    setBuildCart(lines);
    setEditingPre({ id: p.id, orderNumber: p.orderNumber, customerName: p.customerName });
    setSubTab("build");
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
    setFinalizePay("cash"); setFinalizeTendered("");
    setFinalizeTarget({ id: p.id, orderNumber: p.orderNumber, customerName: p.customerName, storeCustomerId: p.storeCustomerId, totalMinor: p.totalMinor, createdAt: p.createdAt, dueAt: p.dueAt });
    setFinalizeStart(p.createdAt.slice(0, 10));
    setFinalizeDue(p.dueAt ? p.dueAt.slice(0, 10) : "");
    setFinalizeSig(null);
    setFinalizeSigError(false);
    setFinalizeError(null);
  };

  const finalizeCash = finalizeTendered ? Math.round(Number(finalizeTendered) * 100) : 0;
  const canFinalize = !!finalizeTarget && !finalizeBusy
    && (finalizePay === "credit" ? !!finalizeSig : finalizeCash >= finalizeTarget.totalMinor);

  const doFinalize = async () => {
    if (!finalizeTarget) return;
    if (finalizePay === "credit" && !finalizeSig) { setFinalizeSigError(true); return; }
    setFinalizeBusy(true); setFinalizeError(null);
    try {
      const target = finalizeTarget;
      const change = finalizePay === "cash" ? Math.max(0, finalizeCash - target.totalMinor) : 0;
      const base = preorders.find((p) => p.id === target.id);
      // Shown under Done while it waits on this tablet (never sent).
      const view: Preorder | undefined = base && { ...base, status: "COMPLETED", paidBy: finalizePay, changeMinor: change, completedAt: new Date().toISOString() };
      const sent = await sendStep(`/admin/pos/preorders/${target.id}/finalize`, {
        paymentMethod: finalizePay,
        tenderedMinor: finalizePay === "cash" && finalizeTendered ? finalizeCash : undefined,
        signatureData: finalizeSig ?? undefined,
        startAt: finalizeStart ? new Date(finalizeStart).toISOString() : undefined,
        dueAt: finalizeDue ? new Date(finalizeDue).toISOString() : undefined,
        idempotencyKey: newSaleKey(),
      }, `Complete pre-order ${target.customerName}`, view);
      if (sent.status === "queued") {
        // No internet: completed on this tablet, it moves to Done and uploads later (see the upload bar).
        setFinalizeTarget(null);
        setLastFinalizedOrderId(null);
        setLocalReceipt(view ? soldSlip(view) : null);
        setSubTab("finalize");
        return;
      }
      const d = (sent.data ?? {}) as { orderId?: string; orderNumber?: string; changeMinor?: number; message?: string; errors?: string[] };
      if (!sent.ok) { setFinalizeError(d.errors?.join(", ") ?? d.message ?? "Finalize failed"); return; }
      toast(finalizePay === "cash"
        ? `Sold — paid in cash${(d.changeMinor ?? 0) > 0 ? ` · change ${toPesos(d.changeMinor ?? 0)}` : ""} · ${d.orderNumber ?? target.orderNumber}`
        : `Sold — on credit · ${d.orderNumber ?? target.orderNumber}`);
      if (finalizePay === "credit") {
        // The customer's new balance and number, so staff can text them the transaction.
        const cs = await fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const c = ((cs?.customers ?? []) as { id: string; phone: string | null; creditBalanceMinor: number }[]).find((x) => x.id === target.storeCustomerId);
        setFinalizedInfo({ orderNumber: d.orderNumber ?? target.orderNumber, totalMinor: target.totalMinor, customerName: target.customerName, storeCustomerId: target.storeCustomerId, phone: c?.phone ?? null, balanceMinor: c ? c.creditBalanceMinor : null });
        setFinalizedPhone(c?.phone ?? "");
      }
      setFinalizeTarget(null);
      setLocalReceipt(null);
      setLastFinalizedOrderId(d.orderId ?? target.id);
      await loadPreorders();
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Finalize failed");
    } finally { setFinalizeBusy(false); }
  };

  // ── New / change pre-order ──
  const buildSubtotal = buildCart.reduce((s, l) => s + unitOf(l) * l.quantity, 0);
  const lineKey = (l: CartLine) => `${l.product.id}|${l.variantId ?? ""}`;

  const addProduct = (product: PosProduct) => {
    setError(null);
    setBuildCart((c) => {
      const found = c.find((l) => l.product.id === product.id && !l.variantId);
      if (found) return c.map((l) => (l === found ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { product, quantity: 1 }];
    });
  };
  const changeLine = (key: string, patch: (l: CartLine) => CartLine | null) =>
    setBuildCart((c) => c.flatMap((l) => (lineKey(l) === key ? (patch(l) ? [patch(l)!] : []) : [l])));
  const setQty = (l: CartLine, qty: number) => changeLine(lineKey(l), (x) => (qty <= 0 ? null : { ...x, quantity: qty }));
  const setLinePrice = (l: CartLine, v: string) => {
    const m = v === "" ? undefined : Math.round(Number(v) * 100);
    const same = m === undefined || m === l.product.priceMinor;
    changeLine(lineKey(l), (x) => ({ ...x, priceText: v, price: same || !Number.isFinite(m) ? undefined : m, reason: same ? undefined : x.reason }));
  };

  const overridePart = (l: CartLine) => (l.price !== undefined && l.price !== l.product.priceMinor ? { unitPriceMinorOverride: l.price, priceOverrideReason: l.reason?.trim() } : {});

  // Save a new ON_HOLD pre-order, or the changed lines of the one being edited; then back to the list.
  const savePreorder = async () => {
    if (buildCart.length === 0) { setError("Tap at least one item."); return; }
    if (buildCart.some(priceMissingReason)) { setError("Pick a reason for every price you changed."); return; }
    setBuildBusy(true); setError(null);
    try {
      let res: Response;
      if (editingPre) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) { setError("Changing a pre-order needs the internet. Make a new one, or try again when the internet is back."); return; }
        res = await fetch(`${API_URL}/admin/pos/preorders/${editingPre.id}/items`, {
          method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify({ items: buildCart.map((l) => ({ productId: l.product.id, variantId: l.variantId ?? undefined, quantity: l.quantity, ...overridePart(l) })) }),
        });
      } else {
        // A new customer is made by the server with the pre-order, so this works with no internet too.
        const name = buildNewName.trim();
        if (!buildCustomerId && !name) { setError("Choose a customer or type a new name."); return; }
        const key = newSaleKey();
        const who = buildCustomerId ? { customerId: buildCustomerId } : { customerName: name, customerPhone: buildNewPhone.trim() || undefined };
        const body = { items: buildCart.map((l) => ({ productId: l.product.id, quantity: l.quantity, ...overridePart(l) })), ...who, idempotencyKey: key };
        const customerName = buildCustomerId ? (buildCustomers.find((c) => c.id === buildCustomerId)?.name ?? "") : name;
        const view: Preorder = {
          id: key, orderNumber: offlineRef(key), customerName, storeCustomerId: buildCustomerId || null, status: "ON_HOLD",
          totalMinor: buildCart.reduce((t, l) => t + unitOf(l) * l.quantity, 0), createdAt: new Date().toISOString(), dueAt: null,
          items: buildCart.map((l) => ({ productId: l.product.id, productName: l.product.name, unitPriceMinor: unitOf(l), quantity: l.quantity, lineTotalMinor: unitOf(l) * l.quantity })),
        };
        const sent = await sendStep(PREORDER_PATH, body, `Pre-order ${customerName}`, view);
        if (sent.status === "queued") {
          clearBuild();
          setSubTab("list");
          return;
        }
        if (!sent.ok) { setError(sent.data?.errors?.join(", ") ?? sent.data?.message ?? SLOW_SERVER); return; }
        toast(`Pre-order saved — ${String(sent.data?.orderNumber ?? "")}`);
        clearBuild();
        await Promise.all([loadPreorders(), loadBuilder()]);
        setSubTab("list");
        return;
      }
      const data = await readJson(res);
      if (!data) { setError(SLOW_SERVER); await loadPreorders(); return; }
      if (!res.ok) { setError(data?.errors?.join(", ") ?? data?.message ?? "Could not save the pre-order"); return; }
      toast(`Saved — ${editingPre.orderNumber}`);
      clearBuild();
      await loadPreorders();
      setSubTab("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the pre-order");
    } finally { setBuildBusy(false); }
  };


  /**
   * Items WITH their quantity ("3 × Dinorado") instead of a bare count, so staff can
   * see what a pre-order holds without opening it. The first `max` lines show and the
   * rest collapse behind "+N more" (full list in the tooltip).
   */
  const itemLines = (p: Preorder, max = 3) => (
    <>
      {p.items.slice(0, max).map((it) => (
        <div key={`${it.productId}|${it.variantId ?? ""}`}>
          <span className="fw-semibold">{it.quantity} ×</span> {it.productName}
          {it.variantName ? <span className="text-muted"> · {it.variantName}</span> : null}
        </div>
      ))}
      {p.items.length > max && (
        <div className="text-muted" title={p.items.map((i) => `${i.quantity} × ${i.productName}`).join("\n")}>
          +{p.items.length - max} more
        </div>
      )}
      {p.items.length === 0 && <span className="text-muted">no items</span>}
    </>
  );

  /** Every product across pre-orders: on hold = all waiting ones, sold = completed between the dates. */
  const holdSoldRows = () => {
    const map: Record<string, { productName: string; holdQty: number; soldQty: number }> = {};
    const doneIds = new Set(doneLocal.map((d) => d.id));
    for (const p of [...preorders.filter((x) => !doneIds.has(x.id)), ...doneLocal]) {
      const kind = p.status === "ON_HOLD" ? "hold" : p.status === "COMPLETED" && (doneIds.has(p.id) || inRange(p)) ? "sold" : null;
      if (!kind) continue;
      for (const it of p.items) {
        const e = map[it.productId] ?? (map[it.productId] = { productName: it.productName, holdQty: 0, soldQty: 0 });
        if (kind === "hold") e.holdQty += it.quantity; else e.soldQty += it.quantity;
      }
    }
    return Object.values(map).sort((a, b) => (b.holdQty + b.soldQty) - (a.holdQty + a.soldQty));
  };

  const summaryCard = () => {
    const rows = holdSoldRows();
    const hold = rows.reduce((s, r) => s + r.holdQty, 0);
    const sold = rows.reduce((s, r) => s + r.soldQty, 0);
    return (
      <div className="card mb-3">
        <div className="card-body">
          <h2 className="h5 text-center mb-1"><i className="bi bi-box-seam me-2" aria-hidden="true"></i>Items on hold and sold</h2>
          <div className="d-flex flex-wrap gap-2 align-items-center justify-content-center mb-2">
            <span className="text-muted">Sold from</span>
            <input aria-label="Sold from date" className="form-control" style={{ width: 170 }} type="date" value={preFrom} onChange={(e) => setPreFrom(e.target.value)} />
            <span className="text-muted">to</span>
            <input aria-label="Sold to date" className="form-control" style={{ width: 170 }} type="date" value={preTo} onChange={(e) => setPreTo(e.target.value)} />
          </div>
          {rows.length === 0 ? (
            <p className="text-muted text-center mb-0">Nothing on hold, and nothing sold on these dates.</p>
          ) : (
            <table className="table align-middle mb-1" style={{ fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr><th>Item</th><th className="text-center">On hold</th><th className="text-center">Sold</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.productName}>
                    <td>{r.productName}</td>
                    <td className={`text-center fw-semibold ${r.holdQty > 0 ? "text-warning-emphasis" : "text-muted"}`}>{r.holdQty}</td>
                    <td className={`text-center fw-semibold ${r.soldQty > 0 ? "text-success" : "text-muted"}`}>{r.soldQty}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="fw-bold"><td>Total</td><td className="text-center">{hold}</td><td className="text-center">{sold}</td></tr>
              </tfoot>
            </table>
          )}
          <div className="small text-muted text-center">On hold = every waiting pre-order. Sold = completed between the dates above.</div>
        </div>
      </div>
    );
  };

  /** A slip for the customer: what they ordered and what they will pay on pick-up. */
  const preorderSlip = (p: Preorder): Slip => ({
    storeName: storeName || "SAM STORE", title: "PRE-ORDER", reference: p.orderNumber, when: new Date(p.createdAt).toLocaleString("en-PH"),
    lines: [{ label: "Customer", value: p.customerName || "—" }, ...(p.dueAt ? [{ label: "Due", value: fmtDate(p.dueAt) }] : [])],
    rows: p.items.map((it) => {
      const name = it.variantName ? `${it.productName} · ${it.variantName}` : it.productName;
      // Prices hidden for pre-orders: item and quantity only (the total still shows).
      return hidePrice ? { name, qty: String(it.quantity) }
        : { name: `${it.quantity} × ${name}`, note: `@ ${toPesos(it.unitPriceMinor)}`, qty: toPesos(it.lineTotalMinor) };
    }),
    totals: [{ label: "Total", value: toPesos(p.totalMinor) }],
    footer: "Not paid yet. Pay when you pick up.",
  });

  /** The receipt for a pre-order completed on this tablet while offline. */
  const soldSlip = (p: Preorder): Slip => ({
    ...preorderSlip(p), title: "SALES RECEIPT", when: new Date(p.completedAt ?? Date.now()).toLocaleString("en-PH"),
    totals: [{ label: "Total", value: toPesos(p.totalMinor) }, ...(p.paidBy === "cash" && (p.changeMinor ?? 0) > 0 ? [{ label: "Change", value: toPesos(p.changeMinor ?? 0) }] : [])],
    footer: p.paidBy === "cash" ? "Paid in cash. Thank you!" : "On credit (utang). Thank you!",
  });

  /** One pre-order as a card: who, what, how much, then the actions (Complete sale first). */
  const preCard = (p: Preorder, pastDue: boolean, local = false) => (
    <div className="col" key={p.id}>
      <div className={`card h-100 ${pastDue ? "border-danger" : ""}`}>
        <div className="card-body d-flex flex-column">
          <div className="d-flex justify-content-between align-items-start gap-2 mb-1">
            <div>
              <div className="fw-bold fs-5">{p.customerName || "—"}</div>
              <div className="small text-muted">{p.orderNumber} · {fmtDate(p.createdAt)}</div>
            </div>
            <div className="fw-bold fs-5 text-end" style={{ fontVariantNumeric: "tabular-nums" }}>{maybePrice(p.totalMinor)}</div>
          </div>
          {p.dueAt && <div className={`small mb-1 ${pastDue ? "text-danger fw-semibold" : "text-muted"}`}>Due {fmtDate(p.dueAt)}{pastDue ? " (late)" : ""}</div>}
          <div className="mb-3 flex-grow-1">{itemLines(p, 4)}</div>
          {local && p.status === "COMPLETED" && (
            <>
              <div className="small text-warning-emphasis mb-2"><i className="bi bi-wifi-off me-1"></i>Completed on this tablet ({p.paidBy === "cash" ? "paid in cash" : "on credit"}). It uploads when the internet is back.</div>
              <button className="btn btn-outline-dark w-100" onClick={() => printSlip(soldSlip(p))}><i className="bi bi-printer me-1"></i>Print receipt</button>
            </>
          )}
          {local && p.status !== "COMPLETED" && (
            <>
              <div className="small text-warning-emphasis mb-2"><i className="bi bi-wifi-off me-1"></i>Saved on this tablet — it is sent when the internet is back. Complete, change or delete it after that.</div>
              <button className="btn btn-outline-dark w-100" onClick={() => printSlip(preorderSlip(p))}><i className="bi bi-printer me-1"></i>Print</button>
            </>
          )}
          {!local && p.status === "ON_HOLD" && (
            <>
              <button className="btn btn-success btn-lg w-100 mb-2" onClick={() => openFinalize(p)}><i className="bi bi-check2-circle me-1"></i>Complete sale</button>
              <div className="d-flex gap-2">
                <button className="btn btn-outline-dark flex-fill" onClick={() => printSlip(preorderSlip(p))}><i className="bi bi-printer me-1"></i>Print</button>
                <button className="btn btn-outline-dark flex-fill" disabled={offline} onClick={() => void openPreEdit(p)}><i className="bi bi-pencil me-1"></i>Change</button>
                <button className="btn btn-outline-danger flex-fill" disabled={offline} onClick={() => { setConfirmVoid({ id: p.id, orderNumber: p.orderNumber }); setVoidReason(""); }}><i className="bi bi-trash me-1"></i>Delete</button>
              </div>
            </>
          )}
          {!local && p.status === "COMPLETED" && (
            <button className="btn btn-outline-dark w-100" disabled={offline} onClick={() => setReceiptOrder(p.id)}><i className="bi bi-receipt me-1"></i>Receipt</button>
          )}
        </div>
      </div>
    </div>
  );

  const renderList = (done: boolean) => {
    if (preLoading) return <p className="text-muted text-center py-4">Loading pre-orders…</p>;
    const rows = done ? completed : drafts;
    const local = done ? doneLocal : here;
    return (
      <>
        {summaryCard()}
        {local.length > 0 && (
          <div className="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3 mb-3">
            {local.map((p) => preCard(p, false, true))}
          </div>
        )}
        {rows.length === 0 && local.length > 0 ? null : rows.length === 0 ? (
          <div className="text-muted text-center py-4">
            <i className={`${done ? "bi bi-check2-circle" : "bi bi-bag-check"} fs-1 d-block mb-2`} aria-hidden="true"></i>
            {done ? "No completed pre-orders on these dates." : "No pre-orders waiting."}
            {!done && <div className="mt-3"><button className="btn btn-success btn-lg" onClick={newPreorder}><i className="bi bi-plus-lg me-1"></i>New pre-order</button></div>}
          </div>
        ) : (
          <div className="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3">
            {rows.map((p) => preCard(p, p.status === "ON_HOLD" && !!p.dueAt && p.dueAt.slice(0, 10) < todayStr))}
          </div>
        )}
      </>
    );
  };

  const inOrder = (productId: string) => buildCart.filter((l) => l.product.id === productId).reduce((s, l) => s + l.quantity, 0);
  const itemsInOrder = buildCart.reduce((s, l) => s + l.quantity, 0);
  const needsCustomer = !editingPre && !buildCustomerId && !buildNewName.trim();
  const reasonMissing = buildCart.some(priceMissingReason);
  const canSave = buildCart.length > 0 && !needsCustomer && !reasonMissing && !buildBusy;
  const saveHint = buildCart.length === 0 ? "Tap the items the customer wants (part 2)."
    : needsCustomer ? "Choose the customer or type a new name (part 1)."
    : reasonMissing ? "Pick a reason for each changed price (part 3)." : null;
  const saveLabel = buildBusy ? "Saving…" : editingPre ? "Save changes" : "Save pre-order";

  const customerSection = (
    <section className="card mb-3" aria-labelledby="po-who">
      <div className="card-body">
        <h2 id="po-who" className="h5 mb-3 d-flex align-items-center"><Num n={1} />Who is it for?</h2>
        {editingPre ? (
          <div className="fs-5 fw-semibold">{editingPre.customerName || "—"}</div>
        ) : (
          <>
            <select aria-label="Customer" className="form-select form-select-lg" value={buildCustomerId} onChange={(e) => { setBuildCustomerId(e.target.value); if (e.target.value) { setBuildNewName(""); setBuildNewPhone(""); } }}>
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
          </>
        )}
      </div>
    </section>
  );

  const pickSection = (
    <section className="mb-3" aria-labelledby="po-items">
      <h2 id="po-items" className="h5 mb-3 d-flex align-items-center"><Num n={2} />Tap items to add</h2>
      {newItemOpen ? (
        <NewItemForm preorder onCancel={() => setNewItemOpen(false)} onDone={async () => { setNewItemOpen(false); await loadBuilder(); }} />
      ) : (
        <>
          {buildProducts.length === 0 && <p className="text-muted text-center py-4">Loading products…</p>}
          <ProductFinder list="preorder" items={buildProducts} colClass={wide ? "col-6 col-xl-4" : "col-6 col-md-4"}
            renderTile={(p) => {
              const n = inOrder(p.id);
              return (
                <button type="button" className={`btn ${n > 0 ? "btn-dark" : "btn-outline-dark"} w-100 h-100 p-2 text-center position-relative`} style={{ minHeight: 104 }}
                  aria-label={`Add ${p.name}${n > 0 ? `, ${n} in this order` : ""}`} onClick={() => { noteUse("preorder", p.id); addProduct(p); }}>
                  {n > 0 && <span className="position-absolute top-0 end-0 badge rounded-pill text-bg-success m-1 fs-6">{n}</span>}
                  <div className="fw-semibold">{p.name}</div>
                  <div style={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }}>{maybePrice(p.priceMinor)}</div>
                  <div className="small">{p.availableQuantity <= 0 ? "None in stock yet" : `${p.availableQuantity} in stock`}</div>
                </button>
              );
            }} />
          <div className="text-center">
            <button type="button" className="btn btn-outline-secondary" disabled={offline} onClick={() => setNewItemOpen(true)}>+ New item (not on the list yet){offline && " · Needs internet"}</button>
          </div>
        </>
      )}
    </section>
  );

  const orderSection = (
    <section className="card border-success mb-3" aria-labelledby="po-check">
      <div className="card-body">
        <h2 id="po-check" className="h5 mb-2 d-flex align-items-center"><Num n={3} />Check the order</h2>
        {buildCart.length === 0 && <p className="text-muted text-center py-3 mb-0">Nothing yet. Tap items {wide ? "on the left" : "above"} (part 2).</p>}
        {buildCart.map((l) => {
          const changed = l.price !== undefined && l.price !== l.product.priceMinor;
          return (
            <div key={lineKey(l)} className="border-bottom py-2">
              <div className="d-flex justify-content-between align-items-baseline gap-2">
                <div className="fw-semibold">{l.product.name}</div>
                <div className="fw-bold text-end text-nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>{maybePrice(unitOf(l) * l.quantity)}</div>
              </div>
              <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2">
                <div className="d-flex align-items-center gap-1" role="group" aria-label={`How many ${l.product.name}`}>
                  <button type="button" className={`btn ${l.quantity === 1 ? "btn-outline-danger" : "btn-outline-dark"}`} style={{ width: 48, height: 48 }}
                    aria-label={l.quantity === 1 ? `Remove ${l.product.name}` : `One less ${l.product.name}`} onClick={() => setQty(l, l.quantity - 1)}>
                    {l.quantity === 1 ? <i className="bi bi-trash" aria-hidden="true"></i> : "−"}
                  </button>
                  <span className="fw-bold text-center fs-5" style={{ minWidth: 40, fontVariantNumeric: "tabular-nums" }} aria-live="polite">{l.quantity}</span>
                  <button type="button" className="btn btn-outline-dark" style={{ width: 48, height: 48 }} aria-label={`One more ${l.product.name}`} onClick={() => setQty(l, l.quantity + 1)}>+</button>
                </div>
                {/* The price is always open here: change it right on the line. */}
                <label className="d-flex align-items-center gap-2 mb-0">
                  <span className="text-muted">Price each</span>
                  <PesoInput className={`form-control ${changed ? "border-warning bg-warning-subtle" : ""}`} style={{ width: 130 }} aria-label={`Price each of ${l.product.name}`}
                    value={l.priceText ?? (unitOf(l) / 100).toFixed(2)} placeholder={(l.product.priceMinor / 100).toFixed(2)} onChange={(v) => setLinePrice(l, v)} />
                </label>
              </div>
              {changed && (
                <div className="mt-2">
                  <div className="small text-muted mb-1">Usual price {toPesos(l.product.priceMinor)}. Why the new price?</div>
                  <PriceReason className="form-select" invalid={priceMissingReason(l)} value={l.reason ?? ""} onChange={(v) => changeLine(lineKey(l), (x) => ({ ...x, reason: v }))} />
                </div>
              )}
            </div>
          );
        })}
        <div className="d-flex justify-content-between align-items-baseline mt-3" style={{ fontVariantNumeric: "tabular-nums" }}>
          <span className="fs-5">Total · {itemsInOrder} item{itemsInOrder === 1 ? "" : "s"}</span><span className="fw-bold" style={{ fontSize: 28 }}>{maybePrice(buildSubtotal)}</span>
        </div>
        {wide && (
          <div className="pos-actions mt-2">
            <button className="btn btn-success btn-lg w-100 py-3 fw-bold" disabled={!canSave} onClick={savePreorder}>
              <i className="bi bi-bag-check me-1"></i>{saveLabel}
            </button>
            {saveHint && <div className="text-center text-muted small mt-1">{saveHint}</div>}
          </div>
        )}
      </div>
    </section>
  );

  const renderBuild = () => wide ? (
    <div className="row g-3 align-items-start">
      <div className="col-lg-7">{customerSection}{pickSection}</div>
      <div className="col-lg-5 pos-side">{orderSection}</div>
    </div>
  ) : (
    <div className="mx-auto" style={{ maxWidth: 720 }}>
      {customerSection}
      {pickSection}
      {orderSection}
      <div className="position-sticky bottom-0 sticky-above-bar bg-white border border-success rounded shadow p-2 mb-2" style={{ zIndex: 5 }}>
        <div className="d-flex align-items-center gap-2">
          <div className="text-nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>
            <div className="fw-bold fs-5">{maybePrice(buildSubtotal)}</div>
            <div className="text-muted small">{itemsInOrder} item{itemsInOrder === 1 ? "" : "s"}</div>
          </div>
          <button className="btn btn-success btn-lg flex-fill fw-bold" disabled={!canSave} onClick={savePreorder}>
            <i className="bi bi-bag-check me-1"></i>{saveLabel}
          </button>
        </div>
        {saveHint && <div className="text-center text-muted small mt-1">{saveHint}</div>}
      </div>
    </div>
  );

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">{subTab !== "build" ? "Pre-order" : editingPre ? `Change ${editingPre.orderNumber}` : "New pre-order"}</h1>
        {subTab === "build" ? (
          <button className="btn btn-outline-dark btn-lg" onClick={backToList}>
            <i className="bi bi-arrow-left me-1"></i>{editingPre ? "Cancel" : "Back to list"}
          </button>
        ) : (
          <button className="btn btn-success btn-lg" onClick={newPreorder}><i className="bi bi-plus-lg me-1"></i>New pre-order</button>
        )}
      </div>

      {localReceipt && doneLocal.length > 0 && subTab !== "build" && (
        <div className="alert alert-warning d-flex flex-wrap align-items-center justify-content-center gap-2">
          <span><i className="bi bi-wifi-off me-1"></i>Sale completed on this tablet. It uploads when the internet is back.</span>
          <button className="btn btn-outline-dark" onClick={() => printSlip(localReceipt)}><i className="bi bi-printer me-1"></i>Print receipt</button>
          <button className="btn btn-outline-secondary" onClick={() => setLocalReceipt(null)}>Close</button>
        </div>
      )}
      {lastFinalizedOrderId && subTab !== "build" && (
        <div className="alert alert-success d-flex flex-wrap align-items-center justify-content-center gap-2">
          <span>Sale completed.</span>
          <button className="btn btn-outline-dark" onClick={() => { setReceiptOrder(lastFinalizedOrderId); setLastFinalizedOrderId(null); }}>
            <i className="bi bi-printer me-1"></i>Print receipt
          </button>
        </div>
      )}

      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {receiptOrder && <ReceiptModal orderId={receiptOrder} onClose={() => setReceiptOrder(null)} />}

      {subTab !== "build" && (
        <div className="btn-group w-100 mb-3" role="group" aria-label="Pre-order list">
          <button type="button" className={`btn btn-lg ${subTab === "list" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={subTab === "list"} onClick={() => setSubTab("list")}>Waiting ({drafts.length + here.length})</button>
          <button type="button" className={`btn btn-lg ${subTab === "finalize" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={subTab === "finalize"} onClick={() => setSubTab("finalize")}>Done</button>
        </div>
      )}

      {subTab === "list" ? renderList(false) : subTab === "finalize" ? renderList(true) : renderBuild()}

      {/* Delete pre-order confirm */}
      {confirmVoid && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Delete {confirmVoid.orderNumber}?</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setConfirmVoid(null)}></button>
                </div>
                <div className="modal-body">
                  <p>This cancels the pre-order and puts the items back in stock.</p>
                  <textarea className="form-control" rows={2} aria-label="Reason (optional)" placeholder="Reason (optional)" value={voidReason} onChange={(e) => setVoidReason(e.target.value)}></textarea>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary btn-lg" onClick={() => setConfirmVoid(null)}>Keep it</button>
                  <button className="btn btn-danger btn-lg" onClick={doVoidPre}>Delete</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* After a credit sale: text the customer */}
      {finalizedInfo && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Charged to credit</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setFinalizedInfo(null)}></button>
                </div>
                <div className="modal-body">
                  <div className="alert alert-success py-2">{finalizedInfo.orderNumber} — {toPesos(finalizedInfo.totalMinor)} on {finalizedInfo.customerName || "the customer"}'s credit.</div>
                  {!finalizedInfo.phone && (
                    <input className="form-control form-control-lg mb-2" inputMode="tel" aria-label="Mobile number" placeholder="Mobile number (09…)" value={finalizedPhone} onChange={(e) => setFinalizedPhone(e.target.value)} />
                  )}
                  <button type="button" className="btn btn-primary btn-lg w-100" onClick={() => {
                    const text = buildText("preorder_credit", { storeName: storeName || "SAM STORE", customerName: finalizedInfo.customerName, reference: finalizedInfo.orderNumber, totalMinor: finalizedInfo.totalMinor, balanceMinor: finalizedInfo.balanceMinor ?? finalizedInfo.totalMinor });
                    const phone = finalizedInfo.phone || finalizedPhone;
                    if (!openTextApp({ phone, text, template: "preorder_credit", storeCustomerId: finalizedInfo.storeCustomerId, documentType: "PRE_ORDER" })) { toast("That is not a mobile number", "danger"); return; }
                    if (!finalizedInfo.phone && finalizedInfo.storeCustomerId) void fetch(`${API_URL}/admin/customers/${finalizedInfo.storeCustomerId}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ phone }) }).catch(() => {});
                  }}><i className="bi bi-chat-dots me-1"></i>Text the customer this transaction</button>
                </div>
                <div className="modal-footer"><button className="btn btn-outline-secondary btn-lg" onClick={() => setFinalizedInfo(null)}>Close</button></div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Complete sale: cash (with quick amounts) or credit (with signature) */}
      {finalizeTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content" style={{ fontSize: 18 }}>
                <div className="modal-header">
                  <h5 className="modal-title">Complete sale · {finalizeTarget.customerName || finalizeTarget.orderNumber}</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setFinalizeTarget(null)}></button>
                </div>
                <div className="modal-body">
                  {finalizeError && <div className="alert alert-danger py-2">{finalizeError}</div>}
                  <div className="text-center mb-3">
                    <div className="text-muted">Customer pays</div>
                    <div className="fw-bold" style={{ fontSize: 36, fontVariantNumeric: "tabular-nums" }}>{toPesos(finalizeTarget.totalMinor)}</div>
                  </div>
                  <div className="text-center fw-semibold mb-2">How are they paying?</div>
                  <div className="d-grid gap-2 mb-3" style={{ gridTemplateColumns: "1fr 1fr" }} role="group" aria-label="How are they paying?">
                    <button type="button" className={`btn btn-lg ${finalizePay === "cash" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={finalizePay === "cash"} onClick={() => setFinalizePay("cash")}><i className="bi bi-cash me-1"></i>Cash</button>
                    <button type="button" className={`btn btn-lg ${finalizePay === "credit" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={finalizePay === "credit"} onClick={() => setFinalizePay("credit")}><i className="bi bi-journal-text me-1"></i>Credit (utang)</button>
                  </div>
                  {finalizePay === "cash" ? (
                    <>
                      <div className="d-flex flex-wrap justify-content-center gap-2 mb-2" role="group" aria-label="Quick cash amounts">
                        {quickCash(finalizeTarget.totalMinor).map((m) => (
                          <button key={m} type="button" className={`btn btn-lg ${finalizeCash === m ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setFinalizeTendered(String(m / 100))}>
                            {m === finalizeTarget.totalMinor ? "Exact" : toPesos(m)}
                          </button>
                        ))}
                      </div>
                      <label className="form-label w-100 text-center" htmlFor="fin-cash">or type the cash received</label>
                      <PesoInput id="fin-cash" className="form-control form-control-lg text-center" value={finalizeTendered} onChange={setFinalizeTendered} placeholder="0.00" />
                      {finalizeTendered && (
                        <div className={`mt-2 text-center fw-bold ${finalizeCash < finalizeTarget.totalMinor ? "text-danger" : "text-success"}`} style={{ fontSize: 28, fontVariantNumeric: "tabular-nums" }} aria-live="polite">
                          {finalizeCash < finalizeTarget.totalMinor ? `Short ${toPesos(finalizeTarget.totalMinor - finalizeCash)}` : `Change ${toPesos(finalizeCash - finalizeTarget.totalMinor)}`}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="row g-2 mb-2">
                        <div className="col-6">
                          <label className="form-label" htmlFor="fin-start">Start date</label>
                          <input id="fin-start" className="form-control" type="date" value={finalizeStart} onChange={(e) => setFinalizeStart(e.target.value)} />
                        </div>
                        <div className="col-6">
                          <label className="form-label" htmlFor="fin-due">Pay by</label>
                          <input id="fin-due" className="form-control" type="date" value={finalizeDue} onChange={(e) => setFinalizeDue(e.target.value)} />
                        </div>
                      </div>
                      <div className="fw-semibold mb-1">Customer signs here</div>
                      <SignaturePad onSignature={(d) => { setFinalizeSig(d); if (d) setFinalizeSigError(false); }} />
                      {finalizeSigError && <div className="text-danger">Signature needed — please sign above.</div>}
                    </>
                  )}
                </div>
                <div className="modal-footer d-flex gap-2">
                  <button className="btn btn-outline-secondary btn-lg" onClick={() => setFinalizeTarget(null)}>Back</button>
                  <button className="btn btn-success btn-lg flex-fill fw-bold" disabled={!canFinalize} onClick={doFinalize}>
                    {finalizeBusy ? "Please wait…" : "Finish sale"}
                  </button>
                </div>
                {!canFinalize && !finalizeBusy && (
                  <div className="text-center text-muted small pb-2">{finalizePay === "cash" ? "Tap Exact or enter the cash received first." : "The customer signs first."}</div>
                )}
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
