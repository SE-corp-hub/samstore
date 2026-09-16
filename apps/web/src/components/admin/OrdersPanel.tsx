"use client";

// Orders (V2) — tabs Today/Pending/On Process/Completed/Void, day-range + customer filter,
// mobile-first cards (table on ≥md). On-Process allows editing held (ON_HOLD) orders,
// paying (cash w/ tendered / utang w/ dates), or voiding — plus the existing transitions
// for delivery-flow statuses. Role-gated via roleCan.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, type AdminOrder, getAdminRole, roleCan } from "../../lib/admin";
import ReceiptModal from "./ReceiptModal";
import SignaturePad from "./SignaturePad";
import { toast } from "../../lib/toast";

const ALLOWED: Record<string, string[]> = {
  RECEIVED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["OUT_FOR_DELIVERY", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED_DELIVERY"],
  DELIVERED: [],
  ON_HOLD: [], // handled by dedicated edit/pay/void buttons
  COMPLETED: [],
  CANCELLED: [],
  FAILED_DELIVERY: ["OUT_FOR_DELIVERY"],
};

const STATUS_BADGE: Record<string, string> = {
  RECEIVED: "text-bg-secondary",
  CONFIRMED: "text-bg-info",
  PREPARING: "text-bg-warning",
  READY: "text-bg-primary",
  OUT_FOR_DELIVERY: "text-bg-dark",
  DELIVERED: "text-bg-success",
  ON_HOLD: "text-bg-warning",
  COMPLETED: "text-bg-success",
  CANCELLED: "text-bg-danger",
  FAILED_DELIVERY: "text-bg-danger",
};

/** Friendly, deduped status labels (used by the pill + dropdown + detail modal). */
const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "Pending", CONFIRMED: "Confirmed", PREPARING: "Preparing", READY: "Ready",
  OUT_FOR_DELIVERY: "Out for delivery", DELIVERED: "Delivered", ON_HOLD: "On hold",
  COMPLETED: "Completed", CANCELLED: "Cancelled", FAILED_DELIVERY: "Failed delivery",
};

const TABS: { id: string; label: string; status?: string[] }[] = [
  { id: "today", label: "Today", status: undefined },
  { id: "pending", label: "Pending", status: ["RECEIVED"] },
  { id: "onprocess", label: "On Process", status: ["CONFIRMED", "PREPARING", "READY", "ON_HOLD"] },
  { id: "fordelivery", label: "For Delivery", status: ["OUT_FOR_DELIVERY"] },
  { id: "delivered", label: "Delivered", status: ["DELIVERED"] },
  { id: "completed", label: "Completed", status: ["COMPLETED"] },
  { id: "void", label: "Void", status: ["CANCELLED", "FAILED_DELIVERY"] },
];

interface EditLine { productId: string; productName: string; quantity: number; unitPriceMinor: number }
interface ProductOption { id: string; name: string; sku: string }

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const dayRange = (d: Date) => ({ from: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).toISOString(), to: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).toISOString() });

/** Pipeline KPI cards — label, count (filled from live counts below), tone, tab to jump to. */
type PipelineKpi = [label: string, n: number, tone: string, go: () => void];
function buildPipelineKpis(counts: Record<string, number>, setTab: (t: string) => void): PipelineKpi[] {
  return [
    ["To receive", counts["RECEIVED"] ?? 0, "text-bg-info", () => setTab("pending")],
    ["In progress", (counts["CONFIRMED"] ?? 0) + (counts["PREPARING"] ?? 0) + (counts["READY"] ?? 0) + (counts["ON_HOLD"] ?? 0), "text-bg-warning", () => setTab("onprocess")],
    ["Out for delivery", counts["OUT_FOR_DELIVERY"] ?? 0, "text-bg-dark", () => setTab("fordelivery")],
    ["Delivered · COD due", counts["DELIVERED"] ?? 0, "text-bg-success", () => setTab("delivered")],
  ];
}

export default function OrdersPanel() {
  const role = getAdminRole();
  const canVoidRefund = roleCan(role, "voidRefund");
  const canWrite = roleCan(role, "write");
  const [tab, setTab] = useState("today");
  const [range, setRange] = useState<"today" | "yesterday" | "tomorrow" | "custom">("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customer, setCustomer] = useState("");
  const [sourceFilter, setSourceFilter] = useState(""); // "" | online | pos | PRE_ORDER
  const [paymentFilter, setPaymentFilter] = useState(""); // "" | cod | credit
  const [fulfillmentFilter, setFulfillmentFilter] = useState(""); // "" | delivery | pickup
  const [selected, setSelected] = useState<Set<string>>(new Set()); // batch mode
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [pendingReason, setPendingReason] = useState<{ orderId: string; to: string } | null>(null);
  const [reason, setReason] = useState("");
  const [receiptOrder, setReceiptOrder] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ orderId: string; kind: "void" | "refund" | "voidHold" } | null>(null);
  const [orderDetail, setOrderDetail] = useState<AdminOrder | null>(null);
  const [detailSignature, setDetailSignature] = useState<string | null>(null);
  const [detailItems, setDetailItems] = useState<{ productName: string; quantity: number; lineTotalMinor: number }[] | null>(null);
  const [detailHistory, setDetailHistory] = useState<{ fromStatus: string | null; toStatus: string; createdAt: string; reason?: string | null; actorType?: string }[] | null>(null);
  const [detailToken, setDetailToken] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  // On-process editing
  const [editHold, setEditHold] = useState<{ id: string; orderNumber: string; status: string; lines: EditLine[] } | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [payHold, setPayHold] = useState<{ id: string; orderNumber: string; totalMinor: number; isDelivery: boolean } | null>(null);
  const [payMethod, setPayMethod] = useState<"cash" | "credit">("cash");
  const [tendered, setTendered] = useState("");
  // M1: optional split-payment tender rows (method · amount · cash tendered · reference).
  const [splitMode, setSplitMode] = useState(false);
  const [tenderRows, setTenderRows] = useState<{ methodCode: string; amount: string; tendered: string; reference: string }[]>([]);
  const [payMethods, setPayMethods] = useState<{ code: string; label: string; kind: string; requiresReference: boolean }[]>([]);
  // M1: the store's tender methods (cash, gcash, utang …) for the split-payment rows.
  useEffect(() => {
    if (!payHold) return;
    fetch(`${API_URL}/admin/payment-methods`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.methods) setPayMethods(d.methods); })
      .catch(() => { /* the modal still works with the legacy cash/utang inputs */ });
  }, [payHold]);
  // M1: live totals for the tender rows (server re-validates everything).
  const splitTotals = (() => {
    const sum = tenderRows.reduce((s, r) => s + Math.round(parseFloat(r.amount || "0") * 100), 0);
    const change = tenderRows.reduce((s, r) => {
      const applied = Math.round(parseFloat(r.amount || "0") * 100);
      const handed = Math.round(parseFloat(r.tendered || "0") * 100);
      return s + (handed > applied ? handed - applied : 0);
    }, 0);
    return { sum, change, remaining: (payHold?.totalMinor ?? 0) - sum };
  })();
  const [startAt, setStartAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [payCustomerId, setPayCustomerId] = useState("");
  const [paySig, setPaySig] = useState<string | null>(null);
    const [paySigError, setPaySigError] = useState(false);
    /** Set when a delivery order is paid: asks whether to also mark it for delivery. */
    const [deliveryConfirm, setDeliveryConfirm] = useState<{ id: string; orderNumber: string; totalMinor: number; method: string } | null>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string | null }[]>([]);

  // M10 a11y: Escape closes the open modal; each modal declares its close callback here.
  const modalClose = () => {
    if (payHold) setPayHold(null);
    else if (deliveryConfirm) setDeliveryConfirm(null);
    else if (pendingReason) setPendingReason(null);
    else if (confirmAction) setConfirmAction(null);
    else if (editHold) setEditHold(null);
    else if (orderDetail) setOrderDetail(null);
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") modalClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      const cur = TABS.find((t) => t.id === tab)!;
      if (cur.status) q.set("status", cur.status.join(","));
      if (tab === "today" || range !== "custom") {
        const base = range === "today" ? new Date() : range === "yesterday" ? new Date(Date.now() - 86_400_000) : new Date(Date.now() + 86_400_000);
        const d = dayRange(base);
        q.set("from", d.from);
        q.set("to", d.to);
      } else {
        if (customFrom) q.set("from", new Date(customFrom).toISOString());
        if (customTo) q.set("to", new Date(new Date(customTo).getTime() + 86_399_000).toISOString());
      }
      if (customer.trim()) q.set("customer", customer.trim());
      if (sourceFilter) q.set("source", sourceFilter);
      if (paymentFilter) q.set("payment", paymentFilter);
      if (fulfillmentFilter) q.set("fulfillment", fulfillmentFilter);
            const res = await fetch(`${API_URL}/admin/orders?${q.toString()}`, { headers: adminHeaders() });
                        if (!res.ok) throw new Error("Failed to load orders");
                        const data = await res.json();
                        let list = data.orders ?? [];
                        // Oldest-first in Pending (FIFO: the longest-waiting order is the most urgent).
                        if (tab === "pending") list = list.sort((a: AdminOrder, b: AdminOrder) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
                        setOrders(list);
            // Per-tab counts (for badges) — same filters as the list, fire-and-forget, never blocks.
                        const cq = new URLSearchParams();
                                                for (const [k, v] of [["from", q.get("from")], ["to", q.get("to")], ["customer", q.get("customer")], ["source", q.get("source")], ["payment", q.get("payment")], ["fulfillment", q.get("fulfillment")]] as const) {
                                                  if (v) cq.set(k, v);
                                                }
                        fetch(`${API_URL}/admin/orders/counts?${cq.toString()}`, { headers: adminHeaders() })
                          .then((r) => r.json())
                          .then((d) => d?.counts && setCounts(d.counts))
                          .catch(() => {});
      if (canWrite) {
        const p = await fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => r.json());
        const c = await fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() }).then((r) => r.json());
        setProducts((p.products ?? []).map((x: any) => ({ id: x.id, name: x.name, sku: x.sku })));
        setCustomers((c.customers ?? []).map((x: any) => ({ id: x.id, name: x.name ?? x.email ?? x.phone ?? "Customer" })));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [tab, range, customFrom, customTo, customer, canWrite, sourceFilter, paymentFilter, fulfillmentFilter]);

    useEffect(() => { load(); }, [load]);

    // Auto-refresh (30s) — persisted per browser, like Overview.
    useEffect(() => {
      try { setAutoRefresh(localStorage.getItem("orders.autoRefresh") === "1"); } catch { /* ignore */ }
    }, []);
    useEffect(() => {
      if (!autoRefresh) return;
      const id = setInterval(() => { void load(); }, 30_000);
      return () => clearInterval(id);
    }, [autoRefresh, load]);

    const toggleSelect = (id: string) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id); else next.add(id);
      setSelected(next);
    };
    const clearSelection = () => setSelected(new Set());

    // ── Batch actions ─────────────────────────────────────────────
    const selOrders = () => orders.filter((o) => selected.has(o.id));
    const selAll = (pred: (o: AdminOrder) => boolean) => {
      const s = selOrders();
      return s.length > 0 && s.every(pred);
    };
    /** Run one async action per selected order (parallel), then reload + clear. */
    const runBatch = async (label: string, fn: (o: AdminOrder) => Promise<void>) => {
      const s = selOrders();
      if (s.length === 0) return;
      setTransitioning("batch");
      setError(null);
      try {
        await Promise.all(s.map(fn));
        toast(`${label} · ${s.length} order${s.length > 1 ? "s" : ""}`);
        setSelected(new Set());
        void load();
      } catch (e) {
        setError(e instanceof Error ? e.message : `${label} failed`);
      } finally { setTransitioning(null); }
    };
    const canBatchReceive = selAll((o) => o.status === "RECEIVED");
    const canBatchCancel = selAll((o) => ["RECEIVED", "CONFIRMED", "PREPARING", "READY", "ON_HOLD"].includes(o.status));
    const canBatchSend = selAll((o) => (o.deliveryType ?? "delivery") === "delivery" && ["CONFIRMED", "PREPARING", "READY"].includes(o.status));
    const canBatchPickup = selAll((o) => (o.deliveryType ?? "delivery") !== "delivery" && o.status === "READY");
    const canBatchDelivered = selAll((o) => o.status === "OUT_FOR_DELIVERY");

  const transition = async (orderId: string, toStatus: string) => {
    if (toStatus === "CANCELLED" || toStatus === "FAILED_DELIVERY") { setPendingReason({ orderId, to: toStatus }); return; }
    await doTransition(orderId, toStatus);
  };

  const doTransition = async (orderId: string, toStatus: string, reasonText?: string) => {
    setTransitioning(orderId);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ toStatus, reason: reasonText }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.message ?? "Transition failed"); return; }
      setPendingReason(null);
      setReason("");
      toast(`Order → ${toStatus}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transition failed");
    } finally { setTransitioning(null); }
  };

  const doVoidRefund = async (orderId: string, kind: "void" | "refund" | "voidHold", reasonText?: string) => {
      setTransitioning(orderId);
      setError(null);
      try {
        const url = kind === "voidHold" ? `${API_URL}/admin/pos/holds/${orderId}/void` : `${API_URL}/admin/orders/${orderId}/${kind}`;
                const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ reason: reasonText }) });
        const data = await res.json();
        if (!res.ok) { setError(data?.message ?? `${kind} failed`); return; }
        setConfirmAction(null);
        setReason("");
        toast(kind === "voidHold" ? "Held order voided — stock restored" : `${kind === "void" ? "Voided" : "Refunded"} → CANCELLED`);
        void load();
      } catch (e) {
        setError(e instanceof Error ? e.message : `${kind} failed`);
      } finally { setTransitioning(null); }
    };

      // ── W1/W2: routing + order edit ──
      const sendForDelivery = async (orderId: string) => {
        setTransitioning(orderId);
        setError(null);
        try {
          const res = await fetch(`${API_URL}/admin/orders/${orderId}/send-for-delivery`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() } });
          const data = await res.json();
          if (!res.ok) { setError(data?.message ?? "Failed"); return; }
          toast(`${data.orderNumber ?? "Order"} → OUT_FOR_DELIVERY`);
          void load();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed");
        } finally { setTransitioning(null); }
      };

      const completeNow = async (orderId: string) => {
        setTransitioning(orderId);
        setError(null);
        try {
          const res = await fetch(`${API_URL}/admin/orders/${orderId}/complete-now`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() } });
          const data = await res.json();
          if (!res.ok) { setError(data?.message ?? "Failed"); return; }
          toast("Order completed — payment collected");
          void load();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed");
        } finally { setTransitioning(null); }
      };

      /** Save order item edits (RECEIVED/CONFIRMED/ON_HOLD) via W1 stock-delta endpoint. */
      const saveOrderEdit = async () => {
        if (!editHold) return;
        setError(null);
        const res = await fetch(`${API_URL}/admin/orders/${editHold.id}/items`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify({ items: editHold.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) }),
        });
        const d = await res.json();
        if (!res.ok) { setError(d?.message ?? "Edit failed"); return; }
        setEditHold(null);
        toast(`Order updated · ${toPesos(d.totalMinor)} (stock adjusted)`);
        void load();
      };

      // ── On-process: edit held items ──
  const saveHoldEdit = async () => {
    if (!editHold) return;
    setError(null);
    const res = await fetch(`${API_URL}/admin/pos/holds/${editHold.id}/items`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ items: editHold.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) }),
    });
    const d = await res.json();
    if (!res.ok) { setError(d?.message ?? "Edit failed"); return; }
    setEditHold(null);
    toast(`Held order updated · ${toPesos(d.totalMinor)}`);
    await load();
    setPayHold({ id: d.id, orderNumber: editHold.orderNumber, totalMinor: d.totalMinor, isDelivery: (editHold.status === "ON_HOLD" ? false : true) });
  };

  const addHoldLine = (productId: string) => {
    if (!editHold) return;
    const prod = products.find((p) => p.id === productId);
    if (!prod) return;
    const existing = editHold.lines.find((l) => l.productId === productId);
    if (existing) setEditHold({ ...editHold, lines: editHold.lines.map((l) => (l.productId === productId ? { ...l, quantity: l.quantity + 1 } : l)) });
    else setEditHold({ ...editHold, lines: [...editHold.lines, { productId, productName: prod.name, quantity: 1, unitPriceMinor: 0 }] });
  };

  const setHoldLineQty = (productId: string, qty: number) => {
    if (!editHold) return;
    setEditHold({ ...editHold, lines: qty <= 0 ? editHold.lines.filter((l) => l.productId !== productId) : editHold.lines.map((l) => (l.productId === productId ? { ...l, quantity: qty } : l)) });
  };

  // ── On-process: pay a held order ──
    /** Validate payment inputs (cash cover / credit customer + signature). Returns true when good. */
    const payValidated = () => {
      if (!payHold) return false;
      // M1: split mode validates the tender rows instead of the single-method inputs.
      if (splitMode) {
        const rows = tenderRows
          .map((r) => ({ ...r, amountMinor: Math.round(parseFloat(r.amount || "0") * 100) }))
          .filter((r) => r.methodCode && r.amountMinor > 0);
        if (rows.length === 0) { setError("Add at least one tender"); return false; }
        const sum = rows.reduce((s, r) => s + r.amountMinor, 0);
        if (sum !== payHold.totalMinor) {
          setError(sum > payHold.totalMinor
            ? `Tenders exceed the total by ${toPesos(sum - payHold.totalMinor)}`
            : `${toPesos(payHold.totalMinor - sum)} still unpaid`);
          return false;
        }
        const hasCreditRow = rows.some((r) => payMethods.find((m) => m.code === r.methodCode)?.kind === "CREDIT");
        if (hasCreditRow && !payCustomerId) { setError("Select a customer for the utang tender"); return false; }
        if (hasCreditRow && !paySig) { setPaySigError(true); setError("Customer signature is required for the utang tender — please sign"); return false; }
        const missingRef = rows.find((r) => {
          const m = payMethods.find((x) => x.code === r.methodCode);
          return m?.requiresReference && !r.reference.trim();
        });
        if (missingRef) { setError(`${payMethods.find((m) => m.code === missingRef.methodCode)?.label} needs a reference number`); return false; }
        return true;
      }
      const tenderedMinor = Math.round(parseFloat(tendered || "0") * 100);
      if (payMethod === "cash" && tenderedMinor < payHold.totalMinor) { setError("Tendered amount must cover the total"); return false; }
      if (payMethod === "credit" && !payCustomerId) { setError("Select a customer for utang"); return false; }
      if (payMethod === "credit" && !paySig) { setPaySigError(true); setError("Customer signature is required for utang — please sign"); return false; }
      return true;
    };

    /** Complete the order after payment. target "OUT_FOR_DELIVERY" → also send it out (delivery-tagged orders). */
    const completeHold = async (target: "COMPLETED" | "OUT_FOR_DELIVERY") => {
      if (!payHold || !payValidated()) return;
      setError(null);
      const tenderedMinor = Math.round(parseFloat(tendered || "0") * 100);
      // M1: in split mode the tender rows ARE the payment (multi-method, one request).
      const splitRows = tenderRows
        .map((r) => ({
          methodCode: r.methodCode,
          amountMinor: Math.round(parseFloat(r.amount || "0") * 100),
          tenderedMinor: r.tendered ? Math.round(parseFloat(r.tendered) * 100) : undefined,
          reference: r.reference.trim() || undefined,
        }))
        .filter((r) => r.methodCode && r.amountMinor > 0);
      const splitHasCredit = tenderRows.some((r) => payMethods.find((m) => m.code === r.methodCode)?.kind === "CREDIT");
      const res = await fetch(`${API_URL}/admin/pos/holds/${payHold.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(
          splitMode
            ? {
                tenders: splitRows,
                paymentMethod: splitHasCredit ? "credit" as const : "cash" as const, // kind summary for the server's signature rule
                customerId: payCustomerId || undefined,
                signatureData: splitHasCredit ? paySig : undefined,
                startAt: splitHasCredit ? (startAt || new Date().toISOString()) : undefined,
                dueAt: splitHasCredit ? (dueAt || undefined) : undefined,
                sendForDelivery: target === "OUT_FOR_DELIVERY",
              }
            : {
                paymentMethod: payMethod,
                tenderedMinor: payMethod === "cash" ? tenderedMinor : undefined,
                customerId: payMethod === "credit" ? payCustomerId : undefined,
                signatureData: payMethod === "credit" ? paySig : undefined,
                startAt: payMethod === "credit" ? (startAt || new Date().toISOString()) : undefined,
                dueAt: payMethod === "credit" ? (dueAt || undefined) : undefined,
                sendForDelivery: target === "OUT_FOR_DELIVERY",
              },
        ),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.message ?? "Complete failed"); return; }
      setPayHold(null);
      setDeliveryConfirm(null);
      setTendered(""); setStartAt(""); setDueAt(""); setPayCustomerId(""); setPaySig(null); setPaySigError(false);
      setSplitMode(false); setTenderRows([]);
      toast(`${d.orderNumber} ${d.status === "OUT_FOR_DELIVERY" ? "paid — sent for delivery" : "completed"}` + (d.changeMinor ? ` · change ${toPesos(d.changeMinor)}` : ""));
      void load();
    };

    /** Complete button: for delivery-tagged orders, first ask "for delivery?" then confirm. */
    const onPayComplete = () => {
      if (!payHold || !payValidated()) return;
      if (payHold.isDelivery) {
        setDeliveryConfirm({ id: payHold.id, orderNumber: payHold.orderNumber, totalMinor: payHold.totalMinor, method: payMethod });
      } else {
        void completeHold("COMPLETED");
      }
    };

  const summaryOf = (o: AdminOrder) => `${o.orderNumber} · ${toPesos(o.totalMinor)} · ${o.customerName}`;

  const rowActions = (o: AdminOrder) => {
      const next = ALLOWED[o.status] ?? [];
      const isDeliv = (o.deliveryType ?? "delivery") === "delivery"; // legacy/online = delivery
      return (
              <div className="d-flex flex-wrap gap-1 align-items-center">
                {/* Pending routing analysis — the pill already shows delivery/pickup hint; no separate chip. */}
                    {o.status === "ON_HOLD" && canWrite && (
            <>
              <button className="btn btn-sm btn-outline-warning" onClick={() => openEdit(o)}><i className="bi bi-pencil me-1"></i>Edit</button>
              <button className="btn btn-sm btn-success" onClick={() => { setPayHold({ id: o.id, orderNumber: o.orderNumber, totalMinor: o.totalMinor, isDelivery: Boolean(o.deliveryAddressLine1?.trim()) }); setPayMethod("cash"); setPaySig(null); setPaySigError(false); setTendered(""); }}><i className="bi bi-cash me-1"></i>Pay</button>
                                                        <button className="btn btn-sm btn-outline-success" onClick={() => { setPayHold({ id: o.id, orderNumber: o.orderNumber, totalMinor: o.totalMinor, isDelivery: Boolean(o.deliveryAddressLine1?.trim()) }); setPayMethod("credit"); setPaySig(null); setPaySigError(false); }}><i className="bi bi-journal me-1"></i>Utang</button>
              {canVoidRefund && <button className="btn btn-sm btn-outline-danger" onClick={() => setConfirmAction({ orderId: o.id, kind: "voidHold" })}><i className="bi bi-pause-btn me-1"></i>Void</button>}
            </>
          )}
          {o.status !== "ON_HOLD" && canWrite && (
                      <>
                        {/* RECEIVED (Pending): Receive or Cancel only (operator spec) */}
                                                {o.status === "RECEIVED" && (
                                                  <>
                                                    <button
                                                      className="btn btn-sm btn-primary"
                                                      disabled={transitioning === o.id}
                                                      onClick={() => transition(o.id, "CONFIRMED")}
                                                      title={isDeliv ? "Confirm → On Process" : "Accept → On Process (mark ready for pickup later)"}
                                                    >
                                                      <i className="bi bi-check-lg me-1"></i>Receive
                                                    </button>
                            <button className="btn btn-sm btn-outline-danger" disabled={transitioning === o.id} onClick={() => transition(o.id, "CANCELLED")}>
                              <i className="bi bi-x-lg me-1"></i>Cancel
                            </button>
                          </>
                        )}
              {/* On Process: one-tap delivery routing */}
                            {isDeliv && ["CONFIRMED", "PREPARING", "READY"].includes(o.status) && (
                              <button className="btn btn-sm btn-primary" disabled={transitioning === o.id} onClick={() => sendForDelivery(o.id)}><i className="bi bi-truck me-1"></i>Send for delivery</button>
                            )}
                            {/* On Process: every live status can be edited, paid (→ COMPLETED), or voided (role-gated). */}
                                                        {["CONFIRMED", "PREPARING", "READY"].includes(o.status) && (
                                                          <>
                                                            <button className="btn btn-sm btn-outline-warning" onClick={() => openEdit(o)} disabled={transitioning === o.id}><i className="bi bi-pencil me-1"></i>Edit</button>
                                                            <button className="btn btn-sm btn-success" disabled={transitioning === o.id} onClick={() => { setPayHold({ id: o.id, orderNumber: o.orderNumber, totalMinor: o.totalMinor, isDelivery: Boolean(o.deliveryAddressLine1?.trim()) }); setPayMethod("cash"); setPaySig(null); setPaySigError(false); setTendered(""); }}><i className="bi bi-cash me-1"></i>Pay</button>
                                                            {canVoidRefund && <button className="btn btn-sm btn-outline-danger" disabled={transitioning === o.id} onClick={() => setConfirmAction({ orderId: o.id, kind: "void" })}><i className="bi bi-x-circle me-1"></i>Void</button>}
                                                          </>
                                                        )}
                                                        {/* Ready-for-pickup step (pickup orders only): mark ready → customer notified; then complete at the counter. */}
                                                        {!isDeliv && ["CONFIRMED", "PREPARING"].includes(o.status) && (
                                                          <button className="btn btn-sm btn-outline-info" disabled={transitioning === o.id} onClick={() => transition(o.id, "READY")} title="Customer is notified the order is ready">
                                                            <i className="bi bi-bell me-1"></i>Ready for pickup
                                                          </button>
                                                        )}
                                                        {!isDeliv && o.status === "READY" && (
                                                          <button className="btn btn-sm btn-success" disabled={transitioning === o.id} onClick={() => completeNow(o.id)} title="Hand over at counter → Completed">
                                                            <i className="bi bi-bag-check me-1"></i>Complete pickup
                                                          </button>
                                                        )}
              {/* Status dropdown — shown only where dedicated buttons don't cover all transitions (i.e. NOT on RECEIVED/CONFIRMED which have Receive/Cancel & routing buttons). */}
                            {next.length > 0 && !["RECEIVED", "CONFIRMED"].includes(o.status) && (
                                                          <select className="form-select form-select-sm" style={{ width: 150 }} value="" disabled={transitioning === o.id} onChange={(e) => e.target.value && transition(o.id, e.target.value)}>
                                                            <option value="" disabled>{o.status === "FAILED_DELIVERY" ? "— Retry delivery —" : `— ${STATUS_LABEL[o.status] ?? o.status} —`}</option>
                                                            {next.filter((s) => !(isDeliv && s === "COMPLETED")).map((s) => <option key={s} value={s}>{s === "OUT_FOR_DELIVERY" && o.status === "FAILED_DELIVERY" ? "Retry delivery" : (STATUS_LABEL[s] ?? s)}</option>)}
                                                          </select>
                                                        )}
              <button className="btn btn-sm btn-outline-secondary" title="Receipt" onClick={() => setReceiptOrder(o.id)}><i className="bi bi-receipt"></i></button>
              {canVoidRefund && o.status === "COMPLETED" && (
                <button className="btn btn-sm btn-outline-danger" title="Void/Refund" onClick={() => setConfirmAction({ orderId: o.id, kind: o.paymentStatus === "COLLECTED" ? "refund" : "void" })}><i className="bi bi-x-circle"></i></button>
              )}
            </>
          )}
          <button className="btn btn-sm btn-outline-secondary" title="Details" onClick={() => openDetail(o)}><i className="bi bi-view-list"></i></button>
        </div>
      );
    };

  const openEdit = (o: AdminOrder) => {
    fetch(`${API_URL}/admin/orders/${o.id}`, { headers: adminHeaders() })
      .then((r) => r.json())
      .then((d) => setEditHold({
              id: o.id,
              orderNumber: o.orderNumber,
              status: o.status,
              lines: (d?.items ?? []).map((i: any) => ({ productId: i.productId ?? "", productName: i.productName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor })),
            }))
      .catch(() => setError("Could not load held order"));
  };

  const isDelivHint = (o: AdminOrder) => (o.deliveryType ?? "delivery") === "delivery";

  /** Age badge — visible on active-status rows (Pending/On Process/For Delivery). >1h amber, >3h red. */
  const ageOf = (o: AdminOrder): { mins: number; label: string; tone: string } | null => {
    if (["COMPLETED", "DELIVERED", "CANCELLED", "FAILED_DELIVERY"].includes(o.status)) return null;
    const mins = Math.max(0, Math.floor((Date.now() - new Date(o.createdAt).getTime()) / 60_000));
    if (mins < 60) return { mins, label: `${mins}m`, tone: "text-bg-secondary" };
    if (mins < 180) return { mins, label: `${Math.floor(mins / 60)}h${mins % 60 ? "+" : ""}`, tone: "text-bg-warning" };
    return { mins, label: `${Math.floor(mins / 60)}h+`, tone: "text-bg-danger" };
  };

    const looking = (o: AdminOrder) => {
            const utang = o.paymentMethod === "credit";
                  const age = ageOf(o);
                  return (
                    <>
                      <span className={`badge ${STATUS_BADGE[o.status] ?? "text-bg-secondary"} text-capitalize text-nowrap`}>
                                          {STATUS_LABEL[o.status] ?? o.status}
                                          {o.status === "RECEIVED" && isDelivHint(o) && <i className="bi bi-geo-alt ms-1"></i>}
                                        </span>
                                        {isDelivHint(o) && <span className="badge text-bg-primary ms-1" title="Delivery order — send for delivery, courier delivers"><i className="bi bi-truck me-1"></i>delivery</span>}
                                        {!isDelivHint(o) && <span className="badge text-bg-success ms-1" title="Pickup order — ready-for-pickup + complete at counter"><i className="bi bi-shop me-1"></i>pickup</span>}
                      {age && <span className={`badge ${age.tone} ms-1`} title={`Placed ${age.mins} min ago`}>{age.label}</span>}
                      {utang && <span className="badge text-bg-warning ms-1" title="Charged to utang"><i className="bi bi-journal-text me-1"></i>utang</span>}
                    </>
                  );
                };

    /** Opens the Details modal and lazily loads the signature + line items (list endpoint omits them but the detail endpoint returns them). */
        const openDetail = (o: AdminOrder) => {
                          setOrderDetail(o);
                          setDetailSignature(null);
                          setDetailItems(null);
                          setDetailHistory(null);
                          setDetailToken(null);
                          fetch(`${API_URL}/admin/orders/${o.id}`, { headers: adminHeaders() })
                            .then((r) => r.json())
                            .then((d) => {
                              // Merge full detail into the row so the modal has address/notes/breakdown.
                              setOrderDetail({ ...o, ...(d as AdminOrder) });
                      setDetailSignature(typeof d?.signatureData === "string" ? (d.signatureData as string) : null);
                      setDetailItems(Array.isArray(d?.items) ? (d.items as { productName: string; quantity: number; lineTotalMinor: number }[]) : []);
                      setDetailHistory(Array.isArray(d?.statusHistory) ? (d.statusHistory as { fromStatus: string | null; toStatus: string; createdAt: string; reason?: string | null; actorType?: string }[]) : []);
                      const t = Array.isArray(d?.claimTokens) ? (d.claimTokens as { token: string; usedAt: string | null }[]).find((c) => !c.usedAt)?.token : null;
                      setDetailToken(t ?? null);
                    })
                    .catch(() => setDetailSignature(null));
                };

  const cardGrid = (
      <div className="d-grid gap-2 d-lg-none">
        {orders.map((o) => (
          <div className={`card ${selected.has(o.id) ? "border-primary" : ""}`} key={o.id}>
            <div className="card-body py-2">
              <div className="d-flex justify-content-between align-items-center gap-2">
                <div className="d-flex align-items-center gap-2">
                  <input className="form-check-input" type="checkbox" checked={selected.has(o.id)} onChange={() => toggleSelect(o.id)} title="Select for batch" />
                  <div>
                    <span className="fw-semibold">{o.orderNumber}</span>
                    <div className="small text-muted">{o.customerName} · {toPesos(o.totalMinor)}</div>
                  </div>
                </div>
                {looking(o)}
              </div>
            <div className="small text-muted mb-1">{new Date(o.createdAt).toLocaleString()}</div>
            {rowActions(o)}
          </div>
        </div>
      ))}
    </div>
  );

  const tableGrid = (
    <div className="table-responsive d-none d-lg-block">
      <table className="table table-hover align-middle">
        <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input className="form-check-input" type="checkbox" title="Select all in view" checked={orders.length > 0 && selected.size === orders.length} onChange={(e) => setSelected(e.target.checked ? new Set(orders.map((x) => x.id)) : new Set())} />
                    </th>
                    <th>Order</th><th>Customer</th><th className="text-end">Total</th><th>Status</th><th>Placed</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className={selected.has(o.id) ? "table-primary" : ""}>
                      <td><input className="form-check-input" type="checkbox" checked={selected.has(o.id)} onChange={() => toggleSelect(o.id)} /></td>
                      <td className="fw-semibold">{o.orderNumber}</td>
              <td>{o.customerName}</td>
              <td className="text-end">{toPesos(o.totalMinor)}</td>
              <td>{looking(o)}</td>
              <td className="small text-muted">{new Date(o.createdAt).toLocaleString()}</td>
              <td>{rowActions(o)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
      <div>
        <h1 className="h4 mb-2"><i className="bi bi-receipt me-2"></i>Orders</h1>
        {error && <div className="alert alert-danger py-2 small">{error}</div>}

                {/* Pipeline KPI strip — click a stage to jump to its tab */}
                <div className="d-flex flex-wrap gap-2 mb-2">
                  {buildPipelineKpis(counts, setTab).map(([label, n, tone, go]) => (
            <button key={label} type="button" className="btn btn-outline-secondary btn-sm d-flex flex-column align-items-center px-3 py-2" onClick={go}>
              <span className={`badge ${n > 0 ? tone : "text-bg-secondary"} fs-6`}>{n > 99 ? "99+" : n}</span>
              <span className="small text-muted">{label}</span>
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <select className="form-select form-select-sm" style={{ width: 120 }} value={range} onChange={(e) => setRange(e.target.value as typeof range)}>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="tomorrow">Tomorrow</option>
            <option value="custom">Custom range</option>
          </select>
          {range === "custom" && (
            <>
              <input className="form-control form-control-sm" style={{ width: 140 }} type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="text-muted small">→</span>
              <input className="form-control form-control-sm" style={{ width: 140 }} type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </>
          )}
          <input className="form-control form-control-sm" style={{ width: 200 }} placeholder="Search order / customer / phone…" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          <select className="form-select form-select-sm" style={{ width: 110 }} value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} title="Source">
            <option value="">All sources</option>
            <option value="online">Online</option>
            <option value="pos">POS</option>
            <option value="PRE_ORDER">Pre-order</option>
          </select>
          <select className="form-select form-select-sm" style={{ width: 105 }} value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)} title="Payment">
            <option value="">All payment</option>
            <option value="cod">COD</option>
            <option value="credit">Utang</option>
          </select>
          <select className="form-select form-select-sm" style={{ width: 115 }} value={fulfillmentFilter} onChange={(e) => setFulfillmentFilter(e.target.value)} title="Fulfillment">
            <option value="">Delivery + pickup</option>
            <option value="delivery">Delivery only</option>
            <option value="pickup">Pickup only</option>
          </select>
          <div className="form-check form-switch form-check-sm" title="Auto-refresh every 30s">
            <input className="form-check-input" type="checkbox" id="ordAuto" checked={autoRefresh} onChange={(e) => { setAutoRefresh(e.target.checked); try { localStorage.setItem("orders.autoRefresh", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
            <label className="form-check-label small" htmlFor="ordAuto">Auto 30s</label>
          </div>
        </div>

        {/* Tabs */}
              <ul className="nav nav-pills mb-2 flex-wrap">
                {TABS.map((t) => {
                                const n = t.status ? t.status.reduce((s, st) => s + (counts[st] ?? 0), 0) : Object.values(counts).reduce((s, c) => s + c, 0);
                                return (
                    <li className="nav-item" key={t.id}>
                      <button className={`nav-link ${tab === t.id ? "active bg-primary" : ""}`} onClick={() => setTab(t.id)}>
                        {t.label}
                        {n > 0 && <span className={`badge ${tab === t.id ? "text-bg-primary" : "text-bg-secondary"} rounded-pill ms-1`}>{n > 99 ? "99+" : n}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>

        {/* Batch bar — appears when rows are selected */}
        {selected.size > 0 && (
          <div className="d-flex flex-wrap gap-1 align-items-center bg-primary bg-opacity-10 border rounded px-2 py-1 mb-2 w-100 small">
            <span className="fw-semibold">{selected.size} selected</span>
            {canWrite && canBatchReceive && (
              <button className="btn btn-sm btn-primary" disabled={transitioning === "batch"} onClick={() => runBatch("Received", async (o) => doTransition(o.id, "CONFIRMED"))}>
                <i className="bi bi-check-lg me-1"></i>Receive
              </button>
            )}
            {canWrite && canBatchCancel && (
              <button className="btn btn-sm btn-outline-danger" disabled={transitioning === "batch"} onClick={() => setPendingReason({ orderId: "__BATCH__", to: "CANCELLED" })}>
                <i className="bi bi-x-lg me-1"></i>Cancel
              </button>
            )}
            {canWrite && canBatchSend && (
              <button className="btn btn-sm btn-primary" disabled={transitioning === "batch"} onClick={() => runBatch("Sent for delivery", async (o) => sendForDelivery(o.id))}>
                <i className="bi bi-truck me-1"></i>Send for delivery
              </button>
            )}
            {canWrite && canBatchPickup && (
              <button className="btn btn-sm btn-success" disabled={transitioning === "batch"} onClick={() => runBatch("Completed (pickup)", async (o) => completeNow(o.id))}>
                <i className="bi bi-bag-check me-1"></i>Complete pickup
              </button>
            )}
            {canWrite && canBatchDelivered && (
              <button className="btn btn-sm btn-success" disabled={transitioning === "batch"} onClick={() => runBatch("Marked delivered", async (o) => doTransition(o.id, "DELIVERED"))}>
                <i className="bi bi-check2-circle me-1"></i>Mark delivered
              </button>
            )}
            <button className="btn btn-sm btn-outline-secondary" disabled={transitioning === "batch"} onClick={clearSelection}>Clear</button>
          </div>
        )}

        {loading ? (
          <p className="text-muted">Loading orders…</p>
        ) : orders.length === 0 ? (
          <p className="text-muted text-center py-4"><i className="bi bi-inbox fs-3 d-block mb-2"></i>No orders in this view.</p>
        ) : (
          <>
            {cardGrid}
            {tableGrid}
          </>
        )}

      {/* Reason modal */}
      {pendingReason && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Reason for {pendingReason.to}</h5>
                  <button type="button" className="btn-close" onClick={() => setPendingReason(null)}></button>
                </div>
                <div className="modal-body">
                  <textarea className="form-control" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer request…" />
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setPendingReason(null)}>Cancel</button>
                  <button className="btn btn-danger" disabled={reason.trim().length < 3} onClick={() => {
                         if (pendingReason.orderId === "__BATCH__") {
                           void runBatch("Cancelled", async (o) => doTransition(o.id, "CANCELLED", reason));
                           setPendingReason(null); setReason("");
                         } else {
                           doTransition(pendingReason.orderId, pendingReason.to, reason);
                         }
                       }}>Confirm</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Void/refund confirm */}
      {confirmAction && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{confirmAction.kind === "voidHold" ? "Void held order" : confirmAction.kind === "void" ? "Void sale" : "Refund sale"}</h5>
                  <button type="button" className="btn-close" onClick={() => setConfirmAction(null)}></button>
                </div>
                <div className="modal-body">
                  <p className="small">
                    {confirmAction.kind === "voidHold"
                      ? "This discards the held order and restores stock."
                      : confirmAction.kind === "void"
                        ? "This reverses the sale and restores stock."
                        : "This records a refund and cancels the order. Stock is not restored."}
                  </p>
                  <input className="form-control form-control-sm" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConfirmAction(null)}>Cancel</button>
                  <button className="btn btn-danger" disabled={transitioning === confirmAction.orderId} onClick={() => doVoidRefund(confirmAction.orderId, confirmAction.kind, reason)}>
                    {transitioning === confirmAction.orderId ? "Working…" : "Confirm"}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Edit held order modal */}
      {editHold && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                                  <h5 className="modal-title">Edit order — {editHold.orderNumber}</h5>
                                  <button type="button" className="btn-close" onClick={() => setEditHold(null)}></button>
                                </div>
                <div className="modal-body">
                  <select className="form-select form-select-sm mb-2" value="" onChange={(e) => e.target.value && addHoldLine(e.target.value)}>
                    <option value="" disabled>+ Add product…</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                  </select>
                  {editHold.lines.length === 0 ? (
                    <p className="text-muted small">No lines — sale will be voided if saved without items.</p>
                  ) : (
                    editHold.lines.map((l) => (
                      <div key={l.productId} className="d-flex align-items-center gap-2 mb-1">
                        <span className="flex-grow-1 small">{l.productName}</span>
                        <div className="input-group input-group-sm" style={{ width: 96 }}>
                          <button className="btn btn-outline-secondary" onClick={() => setHoldLineQty(l.productId, l.quantity - 1)}>-</button>
                          <input className="form-control text-center" value={l.quantity} readOnly />
                          <button className="btn btn-outline-secondary" onClick={() => setHoldLineQty(l.productId, l.quantity + 1)}>+</button>
                        </div>
                        <button className="btn btn-sm btn-outline-danger py-0" onClick={() => setHoldLineQty(l.productId, 0)}><i className="bi bi-x"></i></button>
                      </div>
                    ))
                  )}
                </div>
                <div className="modal-footer">
                                  <button className="btn btn-outline-secondary" onClick={() => setEditHold(null)}>Cancel</button>
                                  <button className="btn btn-primary" onClick={() => (editHold.status === "ON_HOLD" ? saveHoldEdit() : saveOrderEdit())}>Save changes</button>
                                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Pay held order modal */}
            {payHold && (
              <>
                <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="payHoldModalTitle">
                  <div className="modal-dialog modal-dialog-centered">
                    <div className="modal-content">
                      <div className="modal-header">
                        <h5 className="modal-title" id="payHoldModalTitle">Complete {payHold.orderNumber} · {toPesos(payHold.totalMinor)}</h5>
                        <button type="button" className="btn-close" aria-label="Close" onClick={() => setPayHold(null)}></button>
                      </div>
                <div className="modal-body">
                  <div className="d-flex gap-2 mb-2">
                    <button type="button" className={`btn btn-sm ${payMethod === "cash" ? "btn-success" : "btn-outline-success"} flex-fill`} onClick={() => setPayMethod("cash")}>Cash</button>
                    <button type="button" className={`btn btn-sm ${payMethod === "credit" ? "btn-warning" : "btn-outline-warning"} flex-fill`} onClick={() => setPayMethod("credit")}>Utang</button>
                  </div>
                  {payMethod === "cash" ? (
                    <>
                      <label className="form-label small">Amount tendered</label>
                      <input className="form-control" type="number" min="0" step="0.01" placeholder={`Due ${toPesos(payHold.totalMinor)}`} value={tendered} onChange={(e) => setTendered(e.target.value)} />
                      {(() => { const t = Math.round(parseFloat(tendered || "0") * 100); const ch = t - payHold.totalMinor; return ch >= 0 && t > 0 ? <div className="small text-success mt-1">Change: {toPesos(ch)}</div> : null; })()}
                    </>
                  ) : (
                    <>
                      <select className="form-select form-select-sm mb-2" value={payCustomerId} onChange={(e) => setPayCustomerId(e.target.value)}>
                        <option value="">Select customer…</option>
                        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <div className="row g-2">
                                              <div className="col-6">
                                                <label className="form-label small">Start</label>
                                                <input className="form-control form-control-sm" type="date" value={startAt ? startAt.slice(0, 10) : ""} onChange={(e) => setStartAt(e.target.value ? new Date(e.target.value).toISOString() : "")} />
                                              </div>
                                              <div className="col-6">
                                                <label className="form-label small">Due</label>
                                                <input className="form-control form-control-sm" type="date" value={dueAt ? dueAt.slice(0, 10) : ""} onChange={(e) => setDueAt(e.target.value ? new Date(e.target.value).toISOString() : "")} />
                                              </div>
                                            </div>
                                            <div className="mb-1">
                                              <div className="small text-muted mb-1">Customer signature required for utang</div>
                                              <SignaturePad onSignature={(d) => { setPaySig(d); if (d) setPaySigError(false); }} />
                                              {paySigError && <div className="text-danger small">Customer signature required — please sign above.</div>}
                                            </div>
                    </>
                  )}
                </div>
                  <hr className="my-2" />
                  {/* M1: split payment — several tenders settle one order (server re-validates) */}
                  <div className="d-flex align-items-center justify-content-between">
                    <div className="form-check form-switch">
                      <input className="form-check-input" type="checkbox" id="splitPayToggle" checked={splitMode}
                        onChange={(e) => {
                          setSplitMode(e.target.checked);
                          if (e.target.checked && tenderRows.length === 0 && payHold) {
                            setTenderRows([{ methodCode: "cash", amount: (payHold.totalMinor / 100).toFixed(2), tendered: "", reference: "" }]);
                          }
                        }} />
                      <label className="form-check-label small" htmlFor="splitPayToggle">Split payment (cash + gcash + utang)</label>
                    </div>
                    {splitMode && (
                      <button type="button" className="btn btn-sm btn-outline-primary"
                        onClick={() => setTenderRows((rows) => [...rows, { methodCode: payMethods[1]?.code ?? "cash", amount: "", tendered: "", reference: "" }])}>
                        <i className="bi bi-plus-lg me-1"></i>Add tender
                      </button>
                    )}
                  </div>
                  {splitMode && (
                    <div className="mt-2">
                      {payMethods.length === 0 && <div className="small text-muted">Loading payment methods…</div>}
                      {tenderRows.map((row, idx) => {
                        const m = payMethods.find((x) => x.code === row.methodCode);
                        return (
                          <div key={idx} id={`tender-row-${idx}`} className="border rounded p-2 mb-2">
                            <div className="d-flex gap-2 mb-1">
                              <select className="form-select form-select-sm" value={row.methodCode}
                                onChange={(e) => setTenderRows((rows) => rows.map((r, i) => (i === idx ? { ...r, methodCode: e.target.value } : r)))}>
                                {payMethods.map((pm) => <option key={pm.code} value={pm.code}>{pm.label}</option>)}
                              </select>
                              <input className="form-control form-control-sm" type="number" min="0" step="0.01" placeholder="Amount"
                                value={row.amount}
                                onChange={(e) => setTenderRows((rows) => rows.map((r, i) => (i === idx ? { ...r, amount: e.target.value } : r)))} />
                              {tenderRows.length > 1 && (
                                <button type="button" className="btn btn-sm btn-outline-danger"
                                  onClick={() => setTenderRows((rows) => rows.filter((_, i) => i !== idx))}>
                                  <i className="bi bi-x-lg"></i>
                                </button>
                              )}
                            </div>
                            {m?.kind === "CASH" && (
                              <input className="form-control form-control-sm mb-1" type="number" min="0" step="0.01" placeholder="Cash handed over (optional)"
                                value={row.tendered}
                                onChange={(e) => setTenderRows((rows) => rows.map((r, i) => (i === idx ? { ...r, tendered: e.target.value } : r)))} />
                            )}
                            {m?.requiresReference && (
                              <input className="form-control form-control-sm" placeholder={`${m.label} reference`}
                                value={row.reference}
                                onChange={(e) => setTenderRows((rows) => rows.map((r, i) => (i === idx ? { ...r, reference: e.target.value } : r)))} />
                            )}
                          </div>
                        );
                      })}
                      <div className="small d-flex justify-content-between">
                        <span className={splitTotals.remaining === 0 ? "text-success" : "text-danger fw-semibold"}>
                          {splitTotals.remaining === 0
                            ? "Fully tendered"
                            : splitTotals.remaining > 0 ? `Remaining ${toPesos(splitTotals.remaining)}` : `Over by ${toPesos(-splitTotals.remaining)}`}
                        </span>
                        {splitTotals.change > 0 && <span className="text-success">Change {toPesos(splitTotals.change)}</span>}
                      </div>
                    </div>
                  )}
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setPayHold(null)}>Cancel</button>
                  <button className="btn btn-success" onClick={onPayComplete}>Complete</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {receiptOrder && <ReceiptModal orderId={receiptOrder} onClose={() => setReceiptOrder(null)} />}

            {/* Delivery confirm — payment collected on a delivery order: ask "for delivery?" then confirm */}
            {deliveryConfirm && (
                          <>
                            <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="deliveryConfirmModalTitle">
                              <div className="modal-dialog modal-dialog-centered">
                                <div className="modal-content">
                                  <div className="modal-header">
                                    <h5 className="modal-title" id="deliveryConfirmModalTitle"><i className="bi bi-truck me-1"></i>Delivery for {deliveryConfirm.orderNumber}</h5>
                                    <button type="button" className="btn-close" aria-label="Close" onClick={() => setDeliveryConfirm(null)}></button>
                                  </div>
                      <div className="modal-body">
                        <p className="small">
                          Payment collected: <strong>{deliveryConfirm.method === "cash" ? "Cash" : "Utang (credit)"}</strong> · {toPesos(deliveryConfirm.totalMinor)}
                        </p>
                        <p className="small text-muted mb-1">This order is tagged <span className="badge text-bg-primary">delivery</span>. Send it out for delivery?</p>
                      </div>
                      <div className="modal-footer d-flex gap-2">
                        <button className="btn btn-outline-secondary flex-fill" onClick={() => { setDeliveryConfirm(null); void completeHold("COMPLETED"); }}>
                          <i className="bi bi-check-lg me-1"></i>No — complete
                        </button>
                        <button className="btn btn-primary flex-fill" onClick={() => { setDeliveryConfirm(null); void completeHold("OUT_FOR_DELIVERY"); }}>
                          <i className="bi bi-truck me-1"></i>Yes — for delivery
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="modal-backdrop fade show"></div>
              </>
            )}

            {orderDetail && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                                  <h5 className="modal-title">{orderDetail.orderNumber}</h5>
                                  <button type="button" className="btn-close" onClick={() => setOrderDetail(null)}></button>
                                </div>
                                <div className="modal-body small">
                                                  {/* Contact actions */}
                                                  {orderDetail.customerPhone && (
                                                    <div className="d-flex flex-wrap gap-1 mb-2">
                                                      <a className="btn btn-sm btn-outline-success" href={`tel:${orderDetail.customerPhone}`}><i className="bi bi-telephone me-1"></i>Call</a>
                                                      <a className="btn btn-sm btn-outline-primary" href={`sms:${orderDetail.customerPhone}`}><i className="bi bi-chat-dots me-1"></i>SMS</a>
                                                      <a className="btn btn-sm btn-outline-info" href={`https://wa.me/${orderDetail.customerPhone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer"><i className="bi bi-whatsapp me-1"></i>WhatsApp</a>
                                                      {detailToken && (
                                                        <button className="btn btn-sm btn-outline-secondary" title="Copy tracking token" onClick={() => { navigator.clipboard?.writeText(detailToken); toast("Tracking token copied"); }}>
                                                          <i className="bi bi-clipboard me-1"></i>Copy tracking
                                                        </button>
                                                      )}
                                                    </div>
                                                  )}
                                  <dl className="row mb-2">
                                    <dt className="col-5">Customer</dt><dd className="col-7">{orderDetail.customerName}</dd>
                                    <dt className="col-5">Phone</dt><dd className="col-7">{orderDetail.customerPhone || "—"}</dd>
                                    <dt className="col-5">Status</dt><dd className="col-7"><span className={`badge ${STATUS_BADGE[orderDetail.status] ?? "text-bg-secondary"}`}>{STATUS_LABEL[orderDetail.status] ?? orderDetail.status}</span></dd>
                                    <dt className="col-5">Total</dt><dd className="col-7 fw-semibold">{toPesos(orderDetail.totalMinor)}</dd>
                                    {orderDetail.paymentStatus && <><dt className="col-5">Payment</dt><dd className="col-7">{orderDetail.paymentStatus}</dd></>}
                                    {orderDetail.paymentMethod && (
                                      <><dt className="col-5">Method</dt><dd className="col-7">{orderDetail.paymentMethod === "credit" ? <><i className="bi bi-journal-text me-1 text-warning"></i>Utang (credit)</> : orderDetail.paymentMethod}</dd></>
                                    )}
                                    {orderDetail.source && <><dt className="col-5">Source</dt><dd className="col-7">{orderDetail.source === "PRE_ORDER" ? "Pre-order" : orderDetail.source === "pos" ? "POS" : "Online"}</dd></>}
                                                                        {(orderDetail.deliveryType ?? "delivery") === "delivery" ? (
                                                                          <><dt className="col-5">Fulfillment</dt><dd className="col-7"><i className="bi bi-truck me-1"></i>Delivery</dd></>
                                                                        ) : (
                                                                          <><dt className="col-5">Fulfillment</dt><dd className="col-7"><i className="bi bi-shop me-1"></i>Pickup</dd></>
                                                                        )}
                                                                        {orderDetail.deliveryAddressLine1 && (
                                                                          <><dt className="col-5">Address</dt><dd className="col-7">
                                                                            {orderDetail.deliveryAddressLine1}
                                                                            {orderDetail.deliveryAddressLine2 ? `, ${orderDetail.deliveryAddressLine2}` : ""}
                                                                            {orderDetail.landmark ? ` (${orderDetail.landmark})` : ""}
                                                                          </dd></>
                                                                        )}
                                                                        {orderDetail.notes && <><dt className="col-5">Notes</dt><dd className="col-7">{orderDetail.notes}</dd></>}
                                                                      </dl>
                                                                        {typeof orderDetail.subtotalMinor === "number" && (
                                                                          <div className="border rounded p-2 bg-light mb-2 small">
                                                                            <div className="d-flex justify-content-between"><span>Subtotal</span><span>{toPesos(orderDetail.subtotalMinor)}</span></div>
                                                                            {orderDetail.deliveryFeeMinor ? <div className="d-flex justify-content-between"><span>Delivery</span><span>{toPesos(orderDetail.deliveryFeeMinor)}</span></div> : null}
                                                                            {orderDetail.discountMinor ? <div className="d-flex justify-content-between text-danger"><span>Discount</span><span>−{toPesos(orderDetail.discountMinor)}</span></div> : null}
                                                                            <div className="d-flex justify-content-between fw-semibold border-top mt-1 pt-1"><span>Total</span><span>{toPesos(orderDetail.totalMinor)}</span></div>
                                                                          </div>
                                                                        )}
                                                                    {detailItems && (
                                                                      <div className="border rounded p-2 bg-light mb-2">
                                                                        <div className="fw-semibold small mb-1"><i className="bi bi-box-seam me-1"></i>Items</div>
                                                                        {detailItems.length === 0 ? (
                                                                          <p className="text-muted small mb-0">No items.</p>
                                                                        ) : (
                                                                          <table className="table table-sm mb-0">
                                                                            <tbody>
                                                                              {detailItems.map((i, idx) => (
                                                                                <tr key={idx}>
                                                                                  <td className="small">{i.productName}</td>
                                                                                  <td className="text-end small">×{i.quantity}</td>
                                                                                  <td className="text-end small">{toPesos(i.lineTotalMinor)}</td>
                                                                                </tr>
                                                                              ))}
                                                                            </tbody>
                                                                          </table>
                                                                        )}
                                                                      </div>
                                                                                                        )}
                                                                                                        {detailHistory && detailHistory.length > 0 && (
                                                                                                          <div className="border rounded p-2 bg-light mb-2">
                                                                                                            <div className="fw-semibold small mb-1"><i className="bi bi-clock-history me-1"></i>Timeline</div>
                                                                                                            <ul className="list-unstyled small mb-0">
                                                                                                              {detailHistory.map((h, i) => (
                                                                                                                <li key={i} className="d-flex justify-content-between align-items-start gap-2">
                                                                                                                  <span>
                                                                                                                    <span className={`badge ${STATUS_BADGE[h.toStatus] ?? "text-bg-secondary"} text-capitalize`}>{h.toStatus}</span>
                                                                                                                    {h.reason && <span className="text-muted ms-1">— {h.reason}</span>}
                                                                                                                  </span>
                                                                                                                  <span className="text-muted text-nowrap">{new Date(h.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                                                                                                                </li>
                                                                                                              ))}
                                                                                                            </ul>
                                                                                                          </div>
                                                                                                        )}
                                                                                                        {orderDetail.paymentMethod === "credit" && (
                                    <div className="border rounded p-2 bg-light">
                                      <div className="fw-semibold small mb-1"><i className="bi bi-pen me-1"></i>Customer signature</div>
                                      {detailSignature === null ? (
                                        <p className="text-muted small mb-0">Loading signature…</p>
                                      ) : detailSignature ? (
                                        <img src={detailSignature} alt="Customer signature" className="border rounded w-100" style={{ maxHeight: 140, objectFit: "contain", background: "#fff" }} />
                                      ) : (
                                        <p className="text-muted small mb-0">No signature on file.</p>
                                      )}
                                    </div>
                                  )}
                                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary btn-sm" onClick={() => setOrderDetail(null)}>Close</button>
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