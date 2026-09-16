"use client";

// Pre Order panel — dedicated sidebar tab (Sell group). Three sub-tabs:
// 'Pre-Orders' (ON_HOLD drafts: edit qty, delete/void, finalize), 'Finalize'
// (charge drafts to utang with a finger-drawn signature) and 'Build'
// (embedded POS product-selection flow → review → save as pre-order).
// Backend contract (not live yet): GET /admin/pos/preorders?from=&to=,
// POST /admin/pos/preorder, POST /admin/pos/preorders/:id/finalize,
// POST /admin/pos/holds/:id/void, GET /admin/orders/:id + PATCH /admin/orders/:id/items.

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import ReceiptModal from "./ReceiptModal";

interface Preorder {
  id: string; orderNumber: string; customerName: string; storeCustomerId: string | null;
  status: string; totalMinor: number; createdAt: string; dueAt: string | null;
  items: { productId: string; productName: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number }[];
}
interface EditLine { productId: string; productName: string; quantity: number; unitPriceMinor: number }
interface PosProduct {
  id: string; name: string; sku: string; priceMinor: number;
  availableQuantity: number; category: { name: string } | null;
}
interface PosCustomer { id: string; name: string | null; email: string | null; phone: string | null; }
interface CartLine { product: PosProduct; quantity: number; }

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const PRE_STATUS_BADGE: Record<string, string> = {
  ON_HOLD: "text-bg-warning",
  COMPLETED: "text-bg-success",
  CANCELLED: "text-bg-danger",
};
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
  // Delete/void modal
  const [confirmVoid, setConfirmVoid] = useState<{ id: string; orderNumber: string } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  // Finalize modal
  const [finalizeTarget, setFinalizeTarget] = useState<{ id: string; orderNumber: string; customerName: string; totalMinor: number; createdAt: string; dueAt: string | null } | null>(null);
  const [finalizeStart, setFinalizeStart] = useState("");
  const [finalizeDue, setFinalizeDue] = useState("");
  const [finalizeSig, setFinalizeSig] = useState<string | null>(null);
  const [finalizeSigError, setFinalizeSigError] = useState(false);
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  // Build sub-tab state (embedded POS product-selection flow, copied from PosPanel)
  const [buildProducts, setBuildProducts] = useState<PosProduct[]>([]);
  const [buildCustomers, setBuildCustomers] = useState<PosCustomer[]>([]);
  const [buildCart, setBuildCart] = useState<CartLine[]>([]);
  const [buildStep, setBuildStep] = useState<"products" | "review">("products");
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
      let url = `${API_URL}/admin/pos/preorders`;
      if (preFrom || preTo) {
        const q = new URLSearchParams();
        if (preFrom) q.set("from", new Date(`${preFrom}T00:00:00`).toISOString());
        if (preTo) q.set("to", new Date(`${preTo}T23:59:59`).toISOString());
        url += `?${q.toString()}`;
      }
      const res = await fetch(url, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load pre-orders");
      const d = await res.json();
      setPreorders(d.preorders ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load pre-orders failed");
    } finally { setPreLoading(false); }
  }, [preFrom, preTo]);

  useEffect(() => { void loadPreorders(); }, [loadPreorders]);

  const loadBuilder = useCallback(async () => {
    try {
      const [p, c, s] = await Promise.all([
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setHidePrice(Boolean(s?.settings?.hidePricePreOrder));
      setBuildProducts(p.products ?? []);
      setBuildCustomers(c.customers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => { void loadBuilder(); }, [loadBuilder]);

  const drafts = preorders.filter((p) => p.status === "ON_HOLD");
  const completed = preorders.filter((p) => p.status === "COMPLETED");
  const todayStr = localToday();

  const newPreorder = () => {
    setSubTab("build");
    toast("Select products, then Save as pre-order");
  };

  const openPreEdit = (p: Preorder) => {
    setEditPre(null);
    setEditAddId("");
    fetch(`${API_URL}/admin/orders/${p.id}`, { headers: adminHeaders() })
      .then((r) => r.json())
      .then((d) => setEditPre({
        id: p.id,
        orderNumber: p.orderNumber,
        lines: (d?.items ?? []).map((i: any) => ({ productId: i.productId ?? "", productName: i.productName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor })),
      }))
      .catch(() => setError("Could not load pre-order items"));
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
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/orders/${editPre.id}/items`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ items: editPre.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.message ?? "Edit failed"); return; }
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
    setFinalizeTarget({ id: p.id, orderNumber: p.orderNumber, customerName: p.customerName, totalMinor: p.totalMinor, createdAt: p.createdAt, dueAt: p.dueAt });
    setFinalizeStart(p.createdAt.slice(0, 10));
    setFinalizeDue(p.dueAt ? p.dueAt.slice(0, 10) : "");
    setFinalizeSig(null);
    setFinalizeSigError(false);
    setFinalizeError(null);
  };

  const doFinalize = async () => {
    if (!finalizeTarget) return;
    if (!finalizeSig) { setFinalizeSigError(true); return; }
    setFinalizeBusy(true); setFinalizeError(null);
    try {
      const res = await fetch(`${API_URL}/admin/pos/preorders/${finalizeTarget.id}/finalize`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          signatureData: finalizeSig,
          startAt: finalizeStart ? new Date(finalizeStart).toISOString() : undefined,
          dueAt: finalizeDue ? new Date(finalizeDue).toISOString() : undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setFinalizeError(d?.errors?.join(", ") ?? d?.message ?? "Finalize failed"); return; }
      toast(`Finalized — charged to utang · ${d.orderNumber ?? finalizeTarget.orderNumber}`);
      setFinalizeTarget(null);
      setLastFinalizedOrderId(d.orderId ?? finalizeTarget.id);
      await loadPreorders();
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Finalize failed");
    } finally { setFinalizeBusy(false); }
  };

  // ── Build sub-tab: embedded POS product-selection flow (copied from PosPanel) ──
  const buildSubtotal = buildCart.reduce((s, l) => s + l.product.priceMinor * l.quantity, 0);

  const addProduct = (product: PosProduct) => {
    setError(null);
    setBuildCart((c) => {
      const found = c.find((l) => l.product.id === product.id);
      if (found) {
        if (found.quantity + 1 > product.availableQuantity) { setError(`Only ${product.availableQuantity} left for ${product.name}`); return c; }
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
    setBuildBusy(true); setError(null);
    try {
      const customer = await ensureCustomer();
      if (!customer) { setError("Select or add a customer for pre-orders"); setBuildBusy(false); return; }
      const res = await fetch(`${API_URL}/admin/pos/preorder`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          items: buildCart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
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

  /** Aggregate pre-order items: how many units of each product are on hold (draft) vs sold (finalized) in the current range. */
  const holdSoldRows = () => {
    const map: Record<string, { productName: string; holdQty: number; soldQty: number }> = {};
    for (const p of preorders) {
      const kind = p.status === "ON_HOLD" ? "hold" : p.status === "COMPLETED" ? "sold" : null;
      if (!kind) continue;
      for (const it of p.items) {
        const e = map[it.productId] ?? (map[it.productId] = { productName: it.productName, holdQty: 0, soldQty: 0 });
        if (kind === "hold") e.holdQty += it.quantity; else e.soldQty += it.quantity;
      }
    }
    return Object.values(map).sort((a, b) => (b.holdQty + b.soldQty) - (a.holdQty + a.soldQty));
  };

  const rowActions = (p: Preorder, finalizeOnly: boolean) => (
    <>
      {p.status === "ON_HOLD" && (
        <>
          {!finalizeOnly && (
            <>
              <button className="btn btn-sm btn-outline-warning" onClick={() => openPreEdit(p)}><i className="bi bi-pencil me-1"></i>Edit</button>
              <button className="btn btn-sm btn-outline-danger" onClick={() => { setConfirmVoid({ id: p.id, orderNumber: p.orderNumber }); setVoidReason(""); }}><i className="bi bi-x-circle me-1"></i>Delete</button>
            </>
          )}
          <button className="btn btn-sm btn-success" onClick={() => openFinalize(p)}><i className="bi bi-check2-circle me-1"></i>Finalize</button>
        </>
      )}
      {p.status === "COMPLETED" && (
        <button className="btn btn-sm btn-outline-secondary" title="Print receipt" onClick={() => setReceiptOrder(p.id)}>
          <i className="bi bi-receipt me-1"></i>Receipt
        </button>
      )}
    </>
  );

  const preCard = (p: Preorder, finalizeOnly: boolean, pastDue: boolean) => (
    <div className="card" key={p.id}>
      <div className="card-body py-2">
        <div className="d-flex justify-content-between align-items-center">
          <div>
            <span className={`fw-semibold ${pastDue ? "text-danger" : ""}`}>{p.orderNumber}</span>
            <div className="small text-muted">{p.customerName} · {maybePrice(p.totalMinor)}</div>
          </div>
          <span className={`badge ${PRE_STATUS_BADGE[p.status] ?? "text-bg-secondary"}`}>{p.status}</span>
        </div>
        <div className="small text-muted mb-1">
          {itemCount(p)} item(s) · due {p.dueAt ? fmtDate(p.dueAt) : "—"}
        </div>
        <div className="d-flex flex-wrap gap-1 align-items-center">
          {rowActions(p, finalizeOnly)}
        </div>
      </div>
    </div>
  );

  const preTable = (list: Preorder[], finalizeOnly: boolean) => (
    <table className="table table-sm align-middle mb-1 d-none d-md-table">
      <thead>
        <tr>
          <th>Order</th><th>Customer</th><th className="text-end">Items</th><th className="text-end">Total</th><th>Due</th><th>Status</th><th className="text-end">Actions</th>
        </tr>
      </thead>
      <tbody>
        {list.map((p) => {
          const pastDue = !!p.dueAt && p.dueAt.slice(0, 10) < todayStr;
          return (
            <tr key={p.id} className={pastDue ? "table-danger" : ""}>
              <td className={pastDue ? "text-danger fw-semibold" : "fw-semibold"}>{p.orderNumber}</td>
              <td className="small">{p.customerName || "—"}</td>
              <td className="text-end">{itemCount(p)}</td>
              <td className="text-end">{maybePrice(p.totalMinor)}</td>
              <td className="small">{p.dueAt ? fmtDate(p.dueAt) : "—"}</td>
              <td><span className={`badge ${PRE_STATUS_BADGE[p.status] ?? "text-bg-secondary"}`}>{p.status}</span></td>
              <td className="text-end">
                <div className="d-flex flex-wrap gap-1 justify-content-end">
                  {rowActions(p, finalizeOnly)}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const renderDrafts = (finalizeOnly: boolean) => {
    if (preLoading) return <p className="text-muted">Loading pre-orders…</p>;
    const rows = finalizeOnly ? completed : drafts;
    const summary = !finalizeOnly ? holdSoldRows() : [];
    if (rows.length === 0 && summary.length === 0) {
      return (
        <p className="text-muted text-center py-4">
          <i className={`${finalizeOnly ? "bi bi-check2-circle" : "bi bi-journal-text"} fs-3 d-block mb-2`}></i>
          {finalizeOnly ? "No finalized pre-orders in this range. Finalize drafts from the Pre-Orders tab." : "No pre-orders in this range."}
        </p>
      );
    }
    return (
      <>
        {!finalizeOnly && summary.length > 0 && (
          <div className="card mb-2">
            <div className="card-body py-2">
              <h6 className="small fw-bold mb-1"><i className="bi bi-box-seam me-1"></i>Products — on hold vs sold</h6>
              <div className="small text-muted mb-1">
                {preFrom && preTo ? `Filtered by date: ${fmtDate(new Date(`${preFrom}T00:00:00`).toISOString())} → ${fmtDate(new Date(`${preTo}T23:59:59`).toISOString())}` : "All dates"} · counts follow the From/To filter above.
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
            {finalizeOnly ? "No finalized pre-orders in this range." : "No pre-orders in this range."}
          </p>
        ) : (
          <>
            <div className="d-grid gap-2 d-md-none">
              {rows.map((p) => preCard(p, finalizeOnly, !!p.dueAt && p.dueAt.slice(0, 10) < todayStr))}
            </div>
            {preTable(rows, finalizeOnly)}
          </>
        )}
      </>
    );
  };

  const renderBuild = () => (
    <>
      {buildStep === "products" && (
        <>
          <p className="small text-muted mb-2"><i className="bi bi-bag-check me-1"></i>Tap products to add them, then Review order and Save as pre-order (customer required).</p>
          <div className="d-flex gap-2 mb-2 flex-wrap">
            <input className="form-control form-control-sm" style={{ maxWidth: 200 }} placeholder="Search…" value={buildSearch} onChange={(e) => setBuildSearch(e.target.value)} />
            <button className={`btn btn-sm ${buildCategory === "" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setBuildCategory("")}>All</button>
            {buildCategories.map((c) => (
              <button key={c} className={`btn btn-sm ${buildCategory === c ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setBuildCategory(buildCategory === c ? "" : c)}>{c}</button>
            ))}
          </div>

          {buildProducts.length === 0 && <p className="text-muted small text-center py-4">Loading products…</p>}
          {buildFiltered.length === 0 && buildProducts.length > 0 && <p className="text-muted small text-center py-4">No products match.</p>}

          <div className="row g-2">
            {buildFiltered.map((p) => (
              <div className="col-6 col-md-4 col-lg-3" key={p.id}>
                <button
                  type="button"
                  className="btn btn-outline-primary w-100 py-3 d-flex flex-column"
                  disabled={p.availableQuantity <= 0}
                  onClick={() => addProduct(p)}
                >
                  <span className="fw-semibold small text-truncate w-100 text-center">{p.name}</span>
                  <span className="small">{maybePrice(p.priceMinor)}</span>
                  <span className={`small ${p.availableQuantity <= 0 ? "text-danger" : "text-muted"}`}>
                    {p.availableQuantity <= 0 ? "Out" : `${p.availableQuantity} left`}
                  </span>
                </button>
              </div>
            ))}
          </div>

          {/* sticky bottom bar (sticky inside the panel, unlike POS's fixed bar) */}
          <div className="position-sticky bottom-0 bg-white border-top shadow-sm d-flex align-items-center justify-content-between px-3 py-2" style={{ zIndex: 5 }}>
            <div>
              <div className="fw-bold">{buildCart.reduce((s, l) => s + l.quantity, 0)} item(s)</div>
              <div className="text-muted small">{maybePrice(buildSubtotal)}</div>
            </div>
            <button className="btn btn-primary btn-lg" disabled={buildCart.length === 0} onClick={() => setBuildStep("review")}>
              Review order <i className="bi bi-arrow-right ms-1"></i>
            </button>
          </div>
        </>
      )}

      {buildStep === "review" && (
        <>
          <div className="card mb-2">
            <div className="card-body">
              {buildCart.length === 0 ? (
                <p className="text-muted small text-center py-4">No items — go back and add products.</p>
              ) : (
                <>
                  {buildCart.map((l) => (
                    <div key={l.product.id} className="d-flex align-items-center gap-2 mb-1">
                      <div className="flex-grow-1 small">
                        <div className="fw-semibold">{l.product.name}</div>
                        <div className="text-muted">{maybePrice(l.product.priceMinor)}</div>
                      </div>
                      <div className="input-group input-group-sm" style={{ width: 104 }}>
                        <button className="btn btn-outline-secondary" onClick={() => setQty(l.product.id, l.quantity - 1)}>-</button>
                        <input className="form-control text-center" type="number" min={1} value={l.quantity} onChange={(e) => { const v = parseInt(e.target.value, 10); if (v >= 1) setQty(l.product.id, v); }} />
                        <button className="btn btn-outline-secondary" onClick={() => setQty(l.product.id, l.quantity + 1)}>+</button>
                      </div>
                      <div className="fw-semibold small" style={{ width: 66, textAlign: "right" }}>{maybePrice(l.product.priceMinor * l.quantity)}</div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="card mb-2">
            <div className="card-body">
              <h6 className="small fw-bold mb-2">Customer <span className="text-danger">*</span></h6>
              <select className="form-select form-select-sm mb-1" value={buildCustomerId} onChange={(e) => { setBuildCustomerId(e.target.value); if (e.target.value) { setBuildNewName(""); setBuildNewPhone(""); } }}>
                <option value="">Select customer…</option>
                {buildCustomers.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.phone ?? "Customer"}</option>)}
              </select>
              {!buildCustomerId && (
                <div className="row g-1 mb-1">
                  <div className="col-7"><input className="form-control form-control-sm" placeholder="New customer name (autosaves)" value={buildNewName} onChange={(e) => setBuildNewName(e.target.value)} /></div>
                  <div className="col-5"><input className="form-control form-control-sm" placeholder="Phone" value={buildNewPhone} onChange={(e) => setBuildNewPhone(e.target.value)} /></div>
                </div>
              )}
              {buildNewName.trim() && !buildCustomerId && <small className="text-muted">Customer is saved automatically when you save the pre-order.</small>}

              <div className="d-flex justify-content-between fw-bold fs-5 mt-2 mb-2">
                <span>Total</span><span>{maybePrice(buildSubtotal)}</span>
              </div>
              <div className="d-flex flex-wrap gap-2">
                <button className="btn btn-outline-secondary flex-fill" onClick={() => setBuildStep("products")}>Back</button>
                <button className="btn btn-primary flex-fill" disabled={buildCart.length === 0 || buildBusy} onClick={savePreorder}>
                  <i className="bi bi-bag-check me-1"></i>{buildBusy ? "Saving…" : "Save as pre-order"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <h1 className="h4 mb-0">
          <i className="bi bi-bag-check me-2"></i>Pre Order
          <span className="badge text-bg-warning ms-1">{drafts.length} open</span>
        </h1>
        {subTab !== "build" && (
          <button className="btn btn-primary btn-sm ms-auto" onClick={newPreorder}>
            <i className="bi bi-plus-lg me-1"></i>New pre-order
          </button>
        )}
      </div>

      {lastFinalizedOrderId && (
        <div className="d-flex align-items-center gap-2 mb-2 small">
          <span className="text-muted">Last finalized order:</span>
          <button className="btn btn-sm btn-outline-secondary" onClick={() => { setReceiptOrder(lastFinalizedOrderId); setLastFinalizedOrderId(null); }}>
            <i className="bi bi-printer me-1"></i>Print receipt
          </button>
        </div>
      )}

      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {receiptOrder && <ReceiptModal orderId={receiptOrder} onClose={() => setReceiptOrder(null)} />}

      {/* sub-tabs */}
      <div className="btn-group w-100 mb-3" role="group" aria-label="Pre-order view">
        <button type="button" className={`btn ${subTab === "list" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setSubTab("list")}>Pre-Orders</button>
        <button type="button" className={`btn ${subTab === "finalize" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setSubTab("finalize")}>Finalize</button>
        <button type="button" className={`btn ${subTab === "build" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setSubTab("build")}>Build</button>
      </div>

      {/* date filters (hidden on the Build tab) */}
      {subTab !== "build" && (
      <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
        <label className="form-label small mb-0 me-1">From</label>
        <input className="form-control form-control-sm" style={{ width: 140 }} type="date" value={preFrom} onChange={(e) => setPreFrom(e.target.value)} />
        <label className="form-label small mb-0 me-1">To</label>
        <input className="form-control form-control-sm" style={{ width: 140 }} type="date" value={preTo} onChange={(e) => setPreTo(e.target.value)} />
        {!preFrom && !preTo && <span className="small text-muted">All dates</span>}
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
                      <div key={l.productId} className="d-flex align-items-center gap-2 mb-1">
                        <span className="flex-grow-1 small">{l.productName}</span>
                        <div className="input-group input-group-sm" style={{ width: 96 }}>
                          <button className="btn btn-outline-secondary" onClick={() => setPreLineQty(l.productId, l.quantity - 1)}>-</button>
                          <input className="form-control text-center" type="number" min={1} value={l.quantity} onChange={(e) => { const v = parseInt(e.target.value, 10); if (v >= 1) setPreLineQty(l.productId, v); }} />
                          <button className="btn btn-outline-secondary" onClick={() => setPreLineQty(l.productId, l.quantity + 1)}>+</button>
                        </div>
                        <button className="btn btn-sm btn-outline-danger py-0" onClick={() => setPreLineQty(l.productId, 0)}><i className="bi bi-x"></i></button>
                      </div>
                    ))
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
                  <button className="btn btn-primary" onClick={savePreEdit}>Save changes</button>
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
                  <div className="small text-muted mb-1">Customer signature</div>
                  <SignaturePad onSignature={(d) => { setFinalizeSig(d); if (d) setFinalizeSigError(false); }} />
                  {finalizeSigError && <div className="text-danger small">Signature required — please sign above.</div>}
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setFinalizeTarget(null)}>Close</button>
                  <button className="btn btn-success" disabled={!finalizeSig || finalizeBusy} onClick={doFinalize}>
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