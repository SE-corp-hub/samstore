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
import PaymentReview from "./PaymentReview";
import ChatPanel from "./ChatPanel";
import { toast } from "../../lib/toast";
import { useMediaQuery, WIDE } from "../../lib/use-media-query";
import { peso } from "../../lib/number-format";
import { savedThenFresh } from "../../lib/offlineCache";

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
  RECEIVED: "To receive", CONFIRMED: "Confirmed", PREPARING: "Preparing", READY: "Ready",
  OUT_FOR_DELIVERY: "Out for delivery", DELIVERED: "Delivered", ON_HOLD: "On hold",
  COMPLETED: "Completed", CANCELLED: "Cancelled", FAILED_DELIVERY: "Failed delivery",
};

const TABS: { id: string; label: string; status?: string[]; hint: string }[] = [
  { id: "today", label: "All", status: undefined, hint: "Every order for the day you picked. Tap an order to see its items and what to do next." },
  { id: "pending", label: "To receive", status: ["RECEIVED"], hint: "New orders, oldest first. Receive them, or cancel with a reason." },
  { id: "onprocess", label: "In progress", status: ["CONFIRMED", "PREPARING", "READY", "ON_HOLD"], hint: "Received or held orders. Send for delivery, mark ready for pickup, or take payment." },
  { id: "fordelivery", label: "Out for delivery", status: ["OUT_FOR_DELIVERY"], hint: "With the courier. Mark delivered when the customer has it." },
  { id: "delivered", label: "Delivered", status: ["DELIVERED"], hint: "Delivered and paid on delivery." },
  { id: "completed", label: "Completed", status: ["COMPLETED"], hint: "Paid and done. Reprint receipts here." },
  { id: "void", label: "Void", status: ["CANCELLED", "FAILED_DELIVERY"], hint: "Cancelled orders and failed deliveries. A failed delivery can be sent again." },
];

/** One thing a user can do with an order. "main" is the next step (one per order, shown on its row). */
interface OrderAction { key: string; label: string; icon: string; tone: "main" | "plain" | "danger"; run: () => void }

interface EditLine { productId: string; productName: string; quantity: number; unitPriceMinor: number }
interface ProductOption { id: string; name: string; sku: string }

const toPesos = (m: number) => peso(m);
const dayRange = (d: Date) => ({ from: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).toISOString(), to: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).toISOString() });

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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [lastLoaded, setLastLoaded] = useState("");
  const wide = useMediaQuery(WIDE);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [pendingReason, setPendingReason] = useState<{ orderId: string; to: string } | null>(null);
  const [reason, setReason] = useState("");
  const [receiptOrder, setReceiptOrder] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ orderId: string; kind: "void" | "refund" | "voidHold" } | null>(null);
  const [orderDetail, setOrderDetail] = useState<AdminOrder | null>(null);
  const [detailSignature, setDetailSignature] = useState<string | null>(null);
  const [detailItems, setDetailItems] = useState<{ productName: string; quantity: number; lineTotalMinor: number }[] | null>(null);
  const [detailReceived, setDetailReceived] = useState<{ signerName: string; imagePng: string; createdAt: string }[]>([]);
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
                        setLastLoaded(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
            // Per-tab counts (for badges) — same filters as the list, fire-and-forget, never blocks.
                        const cq = new URLSearchParams();
                                                for (const [k, v] of [["from", q.get("from")], ["to", q.get("to")], ["customer", q.get("customer")], ["source", q.get("source")], ["payment", q.get("payment")], ["fulfillment", q.get("fulfillment")]] as const) {
                                                  if (v) cq.set(k, v);
                                                }
                        fetch(`${API_URL}/admin/orders/counts?${cq.toString()}`, { headers: adminHeaders() })
                          .then((r) => r.json())
                          .then((d) => d?.counts && setCounts(d.counts))
                          .catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [tab, range, customFrom, customTo, sourceFilter, paymentFilter, fulfillmentFilter, customer]);

    useEffect(() => { load(); }, [load]);
    // The new-order form's product and customer lists: once per visit, both at once, from the copy
    // saved on this tablet first (they used to be fetched one after the other on every list refresh).
    useEffect(() => {
      if (!canWrite) return;
      void savedThenFresh<{ products?: ProductOption[] }>("/admin/products", (p) => setProducts((p.products ?? []).map((x) => ({ id: x.id, name: x.name, sku: x.sku }))));
      void savedThenFresh<{ customers?: { id: string; name: string | null; email?: string | null; phone?: string | null }[] }>("/admin/customers", (c) => setCustomers((c.customers ?? []).map((x) => ({ id: x.id, name: x.name ?? x.email ?? x.phone ?? "Customer" }))));
    }, [canWrite]);

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
      toast(`${orders.find((x) => x.id === orderId)?.orderNumber ?? "Order"}: ${STATUS_LABEL[toStatus] ?? toStatus}`);
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
        toast(kind === "voidHold" ? "Held order voided — stock restored" : kind === "void" ? "Sale voided — stock restored" : "Sale refunded and cancelled");
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
          toast(`${data.orderNumber ?? "Order"}: out for delivery`);
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
        if (hasCreditRow && !payCustomerId) { setError("Select a customer for the credit tender"); return false; }
        if (hasCreditRow && !paySig) { setPaySigError(true); setError("Customer signature is required for the credit tender — please sign"); return false; }
        const missingRef = rows.find((r) => {
          const m = payMethods.find((x) => x.code === r.methodCode);
          return m?.requiresReference && !r.reference.trim();
        });
        if (missingRef) { setError(`${payMethods.find((m) => m.code === missingRef.methodCode)?.label} needs a reference number`); return false; }
        return true;
      }
      const tenderedMinor = Math.round(parseFloat(tendered || "0") * 100);
      if (payMethod === "cash" && tenderedMinor < payHold.totalMinor) { setError("Tendered amount must cover the total"); return false; }
      if (payMethod === "credit" && !payCustomerId) { setError("Select a customer for credit"); return false; }
      if (payMethod === "credit" && !paySig) { setPaySigError(true); setError("Customer signature is required for credit — please sign"); return false; }
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

  const isDeliv = (o: AdminOrder) => (o.deliveryType ?? "delivery") === "delivery"; // legacy/online = delivery
  const busy = (o: AdminOrder) => transitioning === o.id;
  const openPay = (o: AdminOrder, method: "cash" | "credit") => {
    setPayHold({ id: o.id, orderNumber: o.orderNumber, totalMinor: o.totalMinor, isDelivery: Boolean(o.deliveryAddressLine1?.trim()) });
    setPayMethod(method); setPaySig(null); setPaySigError(false); setTendered("");
  };

  /** Everything this user can do with an order, next step first. Role-gated like before. */
  const actionsFor = (o: AdminOrder): OrderAction[] => {
    const a: OrderAction[] = [];
    const s = o.status;
    const live = ["CONFIRMED", "PREPARING", "READY"].includes(s);
    if (canWrite) {
      if (s === "ON_HOLD") {
        a.push({ key: "pay", label: "Pay", icon: "bi-cash", tone: "main", run: () => openPay(o, "cash") });
        a.push({ key: "credit", label: "Charge to credit", icon: "bi-journal", tone: "plain", run: () => openPay(o, "credit") });
        a.push({ key: "edit", label: "Change items", icon: "bi-pencil", tone: "plain", run: () => openEdit(o) });
        if (canVoidRefund) a.push({ key: "void", label: "Void held order", icon: "bi-x-circle", tone: "danger", run: () => setConfirmAction({ orderId: o.id, kind: "voidHold" }) });
      }
      if (s === "RECEIVED") {
        a.push({ key: "receive", label: "Receive", icon: "bi-check-lg", tone: "main", run: () => void transition(o.id, "CONFIRMED") });
        a.push({ key: "cancel", label: "Cancel order", icon: "bi-x-lg", tone: "danger", run: () => void transition(o.id, "CANCELLED") });
      }
      if (live && isDeliv(o)) a.push({ key: "send", label: "Send for delivery", icon: "bi-truck", tone: "main", run: () => void sendForDelivery(o.id) });
      if (live && !isDeliv(o) && s !== "READY") a.push({ key: "ready", label: "Ready for pickup", icon: "bi-bell", tone: "main", run: () => void transition(o.id, "READY") });
      if (!isDeliv(o) && s === "READY") a.push({ key: "pickup", label: "Complete pickup", icon: "bi-bag-check", tone: "main", run: () => void completeNow(o.id) });
      if (live) {
        a.push({ key: "pay", label: "Pay", icon: "bi-cash", tone: "plain", run: () => openPay(o, "cash") });
        a.push({ key: "edit", label: "Change items", icon: "bi-pencil", tone: "plain", run: () => openEdit(o) });
        if (isDeliv(o) && s === "PREPARING") a.push({ key: "markready", label: "Mark ready", icon: "bi-box-seam", tone: "plain", run: () => void transition(o.id, "READY") });
        if (s !== "CONFIRMED") a.push({ key: "cancel", label: "Cancel order", icon: "bi-x-lg", tone: "danger", run: () => void transition(o.id, "CANCELLED") });
        if (canVoidRefund) a.push({ key: "void", label: "Void sale", icon: "bi-x-circle", tone: "danger", run: () => setConfirmAction({ orderId: o.id, kind: "void" }) });
      }
      if (s === "OUT_FOR_DELIVERY") {
        a.push({ key: "delivered", label: "Mark delivered", icon: "bi-check2-circle", tone: "main", run: () => void transition(o.id, "DELIVERED") });
        a.push({ key: "failed", label: "Delivery failed", icon: "bi-exclamation-triangle", tone: "danger", run: () => void transition(o.id, "FAILED_DELIVERY") });
      }
      if (s === "FAILED_DELIVERY") a.push({ key: "retry", label: "Retry delivery", icon: "bi-arrow-repeat", tone: "main", run: () => void transition(o.id, "OUT_FOR_DELIVERY") });
      if (s !== "ON_HOLD") a.push({ key: "receipt", label: "Reprint receipt", icon: "bi-printer", tone: "plain", run: () => setReceiptOrder(o.id) });
      if (canVoidRefund && s === "COMPLETED") {
        const refund = o.paymentStatus === "COLLECTED";
        a.push({ key: "voidrefund", label: refund ? "Refund sale" : "Void sale", icon: "bi-x-circle", tone: "danger", run: () => setConfirmAction({ orderId: o.id, kind: refund ? "refund" : "void" }) });
      }
    }
    return a;
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

  /** How long an active order has waited, in words. Over 1 h amber, over 3 h red. */
  const ageOf = (o: AdminOrder): { mins: number; label: string; tone: string } | null => {
    if (["COMPLETED", "DELIVERED", "CANCELLED", "FAILED_DELIVERY"].includes(o.status)) return null;
    const mins = Math.max(0, Math.floor((Date.now() - new Date(o.createdAt).getTime()) / 60_000));
    if (mins < 60) return { mins, label: `${mins} min`, tone: "text-bg-secondary" };
    const h = Math.floor(mins / 60);
    return { mins, label: `${h} h${mins % 60 ? "+" : ""} waiting`, tone: mins < 180 ? "text-bg-warning" : "text-bg-danger" };
  };

  /** Placed time: just the time for today, the date too for other days. */
  const placedAt = (iso: string) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  };

  const statusBadge = (status: string) => (
    <span className={`badge ${STATUS_BADGE[status] ?? "text-bg-secondary"} text-nowrap`}>{STATUS_LABEL[status] ?? status}</span>
  );

  /** Opens the details (side pane when wide, full screen when upright) and loads items, history and signatures. */
  const openDetail = (o: AdminOrder) => {
    setOrderDetail(o);
    setDetailSignature(null);
    setDetailItems(null);
    setDetailHistory(null);
    setDetailReceived([]);
    setDetailToken(null);
    // Courier hand-over: who received the order, signed on the courier page.
    fetch(`${API_URL}/admin/signatures?documentType=ORDER&documentId=${o.id}`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDetailReceived(Array.isArray(d?.signatures) ? d.signatures : []))
      .catch(() => setDetailReceived([]));
    loadDetail(o);
  };
  const loadDetail = (o: AdminOrder) => {
    fetch(`${API_URL}/admin/orders/${o.id}`, { headers: adminHeaders() })
      .then((r) => r.json())
      .then((d) => {
        // Merge full detail into the row so the pane has address/notes/breakdown.
        setOrderDetail((cur) => (cur && cur.id === o.id ? { ...o, ...(d as AdminOrder) } : cur));
        setDetailSignature(typeof d?.signatureData === "string" ? (d.signatureData as string) : "");
        setDetailItems(Array.isArray(d?.items) ? (d.items as { productName: string; quantity: number; lineTotalMinor: number }[]) : []);
        setDetailHistory(Array.isArray(d?.statusHistory) ? (d.statusHistory as { fromStatus: string | null; toStatus: string; createdAt: string; reason?: string | null; actorType?: string }[]) : []);
        const t = Array.isArray(d?.claimTokens) ? (d.claimTokens as { token: string; usedAt: string | null }[]).find((c) => !c.usedAt)?.token : null;
        setDetailToken(t ?? null);
      })
      .catch(() => setDetailSignature(""));
  };
  // After the list reloads (an action ran), refresh the open order so its status and buttons are current.
  const detailId = orderDetail?.id;
  useEffect(() => {
    // The order may have left this list (e.g. received → In progress); it stays open with its new status.
    if (!detailId || !orderDetail) return;
    loadDetail(orders.find((x) => x.id === detailId) ?? orderDetail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);

  const curTab = TABS.find((t) => t.id === tab)!;
  const countFor = (t: (typeof TABS)[number]) => (t.status ? t.status.reduce((s, st) => s + (counts[st] ?? 0), 0) : Object.values(counts).reduce((s, c) => s + c, 0));
  const extraFilters = [sourceFilter, paymentFilter, fulfillmentFilter].filter(Boolean).length;
  const clearFilters = () => { setSourceFilter(""); setPaymentFilter(""); setFulfillmentFilter(""); setCustomer(""); };
  const dayWords = range === "today" ? "today" : range === "yesterday" ? "yesterday" : range === "tomorrow" ? "tomorrow" : "in these dates";

  const orderRow = (o: AdminOrder) => {
    const acts = actionsFor(o);
    const main = acts.find((x) => x.tone === "main");
    const reprint = acts.find((x) => x.key === "receipt");
    const age = ageOf(o);
    const open = orderDetail?.id === o.id;
    return (
      <li key={o.id} className={`order-row ${open ? "is-open" : ""} ${selected.has(o.id) ? "is-picked" : ""}`}>
        <label className="order-pick" title="Select for a batch action">
          <input className="form-check-input m-0" type="checkbox" checked={selected.has(o.id)} onChange={() => toggleSelect(o.id)} aria-label={`Select ${o.orderNumber}`} />
        </label>
        <button type="button" className="order-main" onClick={() => openDetail(o)} aria-current={open ? "true" : undefined}>
          <span className="min-w-0">
            <span className="d-block fw-bold text-truncate">{o.customerName}</span>
            <span className="d-block small text-muted">
              {o.orderNumber} · {isDeliv(o) ? <><i className="bi bi-truck" aria-hidden="true"></i> Delivery</> : <><i className="bi bi-shop" aria-hidden="true"></i> Pickup</>}
              {o.paymentMethod === "credit" && <> · <i className="bi bi-journal-text" aria-hidden="true"></i> Credit</>}
              {" · "}{placedAt(o.createdAt)}
            </span>
          </span>
          <span className="text-end flex-shrink-0">
            <span className="d-block fw-bold num">{toPesos(o.totalMinor)}</span>
            <span className="d-inline-flex flex-wrap justify-content-end gap-1">
              {statusBadge(o.status)}
              {age && <span className={`badge ${age.tone}`} title={`Placed ${age.mins} min ago`}>{age.label}</span>}
            </span>
          </span>
        </button>
        {reprint && (
          <button type="button" className="btn btn-outline-dark order-reprint" onClick={reprint.run} aria-label={`Reprint receipt for ${o.orderNumber}`}>
            <i className="bi bi-printer me-1" aria-hidden="true"></i>Reprint
          </button>
        )}
        {main && (
          <button type="button" className="btn btn-success order-go" disabled={busy(o)} onClick={main.run}>
            {busy(o) ? <span className="spinner-border spinner-border-sm me-1" aria-hidden="true"></span> : <i className={`bi ${main.icon} me-1`} aria-hidden="true"></i>}
            {main.label}
          </button>
        )}
      </li>
    );
  };

  const detailPane = orderDetail && (() => {
    const o = orderDetail;
    const acts = actionsFor(o);
    const main = acts.filter((x) => x.tone === "main");
    const plain = acts.filter((x) => x.tone === "plain");
    const danger = acts.filter((x) => x.tone === "danger");
    return (
      <div className="order-detail">
        <div className="d-flex align-items-center gap-2 mb-2">
          {!wide && <button type="button" className="btn btn-outline-dark" onClick={() => setOrderDetail(null)}><i className="bi bi-arrow-left me-1" aria-hidden="true"></i>Back</button>}
          <h2 className="h5 mb-0 flex-grow-1" id="orderDetailTitle">{o.orderNumber}</h2>
          {statusBadge(o.status)}
          {wide && <button type="button" className="btn-close" aria-label="Close details" onClick={() => setOrderDetail(null)}></button>}
        </div>
        <div className="d-flex justify-content-between align-items-end gap-2 mb-2">
          <div className="min-w-0">
            <div className="fw-bold fs-5 text-truncate">{o.customerName}</div>
            <div className="small text-muted">{isDeliv(o) ? "Delivery" : "Pickup"} · {o.source === "PRE_ORDER" ? "Pre-order" : o.source === "pos" ? "POS" : "Online"} · {placedAt(o.createdAt)}</div>
          </div>
          <div className="fs-4 fw-bold num">{toPesos(o.totalMinor)}</div>
        </div>

        {/* Next step first, then the other things you can do, then the risky ones apart at the bottom. */}
        {main.map((x) => (
          <button key={x.key} type="button" className="btn btn-success btn-lg w-100 mb-2" disabled={busy(o)} onClick={x.run}>
            <i className={`bi ${x.icon} me-2`} aria-hidden="true"></i>{x.label}
          </button>
        ))}
        {plain.length > 0 && (
          <div className="d-grid gap-2 mb-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            {plain.map((x) => (
              <button key={x.key} type="button" className="btn btn-outline-dark" disabled={busy(o)} onClick={x.run}>
                <i className={`bi ${x.icon} me-1`} aria-hidden="true"></i>{x.label}
              </button>
            ))}
          </div>
        )}

        {o.customerPhone && (
          <div className="d-flex flex-wrap gap-2 mb-3">
            <a className="btn btn-outline-dark" href={`tel:${o.customerPhone}`}><i className="bi bi-telephone me-1" aria-hidden="true"></i>Call {o.customerPhone}</a>
            <a className="btn btn-outline-dark" href={`sms:${o.customerPhone}`}><i className="bi bi-chat-dots me-1" aria-hidden="true"></i>Text</a>
            {detailToken && (
              <button type="button" className="btn btn-outline-dark" onClick={() => { navigator.clipboard?.writeText(detailToken); toast("Tracking code copied"); }}>
                <i className="bi bi-clipboard me-1" aria-hidden="true"></i>Copy tracking
              </button>
            )}
          </div>
        )}

        {o.deliveryAddressLine1 && (
          <p className="mb-2"><i className="bi bi-geo-alt me-1" aria-hidden="true"></i>
            {o.deliveryAddressLine1}{o.deliveryAddressLine2 ? `, ${o.deliveryAddressLine2}` : ""}{o.landmark ? ` (${o.landmark})` : ""}
          </p>
        )}
        {o.notes && <p className="mb-2"><i className="bi bi-sticky me-1" aria-hidden="true"></i>{o.notes}</p>}

        <h3 className="h6 mt-3 mb-1">Items</h3>
        {detailItems === null ? (
          <p className="text-muted placeholder-glow mb-2"><span className="placeholder col-8"></span></p>
        ) : detailItems.length === 0 ? (
          <p className="text-muted mb-2">No items.</p>
        ) : (
          <table className="table table-sm mb-2">
            <tbody>
              {detailItems.map((i, idx) => (
                <tr key={idx}>
                  <td>{i.productName}</td>
                  <td className="text-end text-nowrap">× {i.quantity}</td>
                  <td className="text-end text-nowrap num">{toPesos(i.lineTotalMinor)}</td>
                </tr>
              ))}
            </tbody>
            {typeof o.subtotalMinor === "number" && (
              <tfoot>
                {o.deliveryFeeMinor ? <tr><td colSpan={2}>Delivery fee</td><td className="text-end num">{toPesos(o.deliveryFeeMinor)}</td></tr> : null}
                {o.discountMinor ? <tr><td colSpan={2}>Discount</td><td className="text-end num">−{toPesos(o.discountMinor)}</td></tr> : null}
                <tr className="fw-bold"><td colSpan={2}>Total</td><td className="text-end num">{toPesos(o.totalMinor)}</td></tr>
              </tfoot>
            )}
          </table>
        )}
        {(o.paymentStatus || o.paymentMethod) && (
          <p className="mb-2">Payment: {o.paymentMethod === "credit" ? "Credit" : o.paymentMethod === "cod" ? "Cash on delivery" : o.paymentMethod}{o.paymentStatus ? ` · ${o.paymentStatus === "COLLECTED" ? "paid" : o.paymentStatus === "PENDING" ? "not paid yet" : o.paymentStatus.toLowerCase().replace(/_/g, " ")}` : ""}</p>
        )}

        {detailHistory && detailHistory.length > 0 && (
          <>
            <h3 className="h6 mt-3 mb-1">What happened</h3>
            <ul className="list-unstyled mb-2">
              {detailHistory.map((h, i) => (
                <li key={i} className="d-flex justify-content-between align-items-start gap-2 py-1 border-bottom">
                  <span>{STATUS_LABEL[h.toStatus] ?? h.toStatus}{h.reason && <span className="text-muted"> — {h.reason}</span>}</span>
                  <span className="text-muted text-nowrap">{placedAt(h.createdAt)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {detailReceived.map((sg, i) => (
          <div key={i} className="mb-2">
            <h3 className="h6 mt-3 mb-1">Received by {sg.signerName} · {placedAt(sg.createdAt)}</h3>
            <img src={sg.imagePng} alt={`Signature of ${sg.signerName}`} className="border rounded w-100" style={{ maxHeight: 140, objectFit: "contain", background: "#fff" }} />
          </div>
        ))}
        {o.paymentMethod === "credit" && (
          <div className="mb-2">
            <h3 className="h6 mt-3 mb-1">Customer signature</h3>
            {detailSignature === null ? (
              <p className="text-muted mb-0">Loading signature…</p>
            ) : detailSignature ? (
              <img src={detailSignature} alt="Customer signature" className="border rounded w-100" style={{ maxHeight: 140, objectFit: "contain", background: "#fff" }} />
            ) : (
              <p className="text-muted mb-0">No signature on file.</p>
            )}
          </div>
        )}

        {danger.length > 0 && (
          <div className="d-flex flex-wrap gap-2 border-top pt-3 mt-3">
            {danger.map((x) => (
              <button key={x.key} type="button" className="btn btn-outline-danger" disabled={busy(o)} onClick={x.run}>
                <i className={`bi ${x.icon} me-1`} aria-hidden="true"></i>{x.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  })();

  const list = loading && orders.length === 0 ? (
    <ul className="order-list placeholder-glow" aria-busy="true" aria-label="Loading orders">
      {[0, 1, 2, 3].map((i) => <li key={i} className="order-row"><span className="placeholder col-12 rounded" style={{ height: 48 }}></span></li>)}
    </ul>
  ) : orders.length === 0 ? (
    <div className="text-center py-5 border rounded bg-white">
      <i className="bi bi-inbox fs-1 d-block mb-2 text-muted" aria-hidden="true"></i>
      <p className="fw-bold mb-1">{tab === "today" ? `No orders ${dayWords}` : `No "${curTab.label}" orders ${dayWords}`}</p>
      <p className="text-muted mb-3">{customer || extraFilters ? "Some filters are on. Clear them to see more." : "New orders show here as they come in."}</p>
      <div className="d-flex justify-content-center flex-wrap gap-2">
        {(customer || extraFilters > 0) && <button type="button" className="btn btn-outline-dark" onClick={clearFilters}>Clear filters</button>}
        {tab !== "today" && <button type="button" className="btn btn-outline-dark" onClick={() => setTab("today")}>Show all orders</button>}
      </div>
    </div>
  ) : (
    <ul className="order-list" aria-busy={loading}>{orders.map(orderRow)}</ul>
  );

  const chip = (on: boolean) => `btn ${on ? "btn-dark" : "btn-outline-dark"} rounded-pill`;

  return (
      <div className="orders-screen">
        <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
          <h1 className="h4 mb-0 me-auto"><i className="bi bi-receipt me-2" aria-hidden="true"></i>Orders</h1>
          <button type="button" className="btn btn-outline-dark" onClick={() => setReviewOpen(true)}><i className="bi bi-inboxes me-1" aria-hidden="true"></i>Payment review</button>
          <button type="button" className="btn btn-outline-dark" onClick={() => setChatOpen(true)}><i className="bi bi-chat-dots me-1" aria-hidden="true"></i>Chat inbox</button>
          <button type="button" className="btn btn-outline-dark" onClick={() => void load()} disabled={loading} aria-label="Refresh orders">
            <i className={`bi bi-arrow-clockwise ${loading ? "spin" : ""}`} aria-hidden="true"></i>
            <span className="ms-1 d-none d-md-inline">{lastLoaded ? `Updated ${lastLoaded}` : "Refresh"}</span>
          </button>
        </div>
        {error && (
          <div className="alert alert-danger d-flex align-items-start gap-2 py-2" role="alert">
            <span className="flex-grow-1">{error}</span>
            <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => setError(null)}></button>
          </div>
        )}

        {/* Day + search on one line; the rarer filters fold away behind "Filters". */}
        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <div className="d-flex flex-wrap gap-2" role="group" aria-label="Day">
            {([["yesterday", "Yesterday"], ["today", "Today"], ["tomorrow", "Tomorrow"], ["custom", "Pick dates"]] as const).map(([id, label]) => (
              <button key={id} type="button" className={chip(range === id)} aria-pressed={range === id} onClick={() => setRange(id)}>{label}</button>
            ))}
          </div>
          <div className="position-relative ord-search">
            <label htmlFor="ordSearch" className="visually-hidden">Search orders</label>
            <i className="bi bi-search position-absolute top-50 translate-middle-y ms-3 text-muted" aria-hidden="true"></i>
            <input id="ordSearch" type="search" className="form-control ps-5" placeholder="Name, phone or order no." value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </div>
          <button type="button" className={`btn ms-auto ms-lg-0 ${filtersOpen || extraFilters ? "btn-dark" : "btn-outline-dark"}`} aria-expanded={filtersOpen} aria-controls="ordFilters" onClick={() => setFiltersOpen(!filtersOpen)}>
            <i className="bi bi-sliders me-1" aria-hidden="true"></i>Filters{extraFilters > 0 && <span className="badge text-bg-light ms-1">{extraFilters}</span>}
          </button>
        </div>
        {range === "custom" && (
          <div className="d-flex flex-wrap gap-2 align-items-end mb-2">
            <div><label className="form-label small mb-0" htmlFor="ordFrom">From</label><input id="ordFrom" className="form-control" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /></div>
            <div><label className="form-label small mb-0" htmlFor="ordTo">To</label><input id="ordTo" className="form-control" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></div>
          </div>
        )}
        {filtersOpen && (
          <div id="ordFilters" className="border rounded bg-white p-2 mb-2">
            <div className="row g-2 align-items-end">
              <div className="col-12 col-md-4">
                <label className="form-label small mb-0" htmlFor="ordSource">Where from</label>
                <select id="ordSource" className="form-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                  <option value="">All</option><option value="online">Online</option><option value="pos">POS</option><option value="PRE_ORDER">Pre-order</option>
                </select>
              </div>
              <div className="col-6 col-md-4">
                <label className="form-label small mb-0" htmlFor="ordPay">Payment</label>
                <select id="ordPay" className="form-select" value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}>
                  <option value="">All</option><option value="cod">Cash on delivery</option><option value="credit">Credit</option>
                </select>
              </div>
              <div className="col-6 col-md-4">
                <label className="form-label small mb-0" htmlFor="ordFul">Delivery or pickup</label>
                <select id="ordFul" className="form-select" value={fulfillmentFilter} onChange={(e) => setFulfillmentFilter(e.target.value)}>
                  <option value="">Both</option><option value="delivery">Delivery</option><option value="pickup">Pickup</option>
                </select>
              </div>
            </div>
            <div className="d-flex flex-wrap align-items-center gap-3 mt-2">
              <div className="form-check form-switch mb-0">
                <input className="form-check-input" type="checkbox" role="switch" id="ordAuto" checked={autoRefresh} onChange={(e) => { setAutoRefresh(e.target.checked); try { localStorage.setItem("orders.autoRefresh", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
                <label className="form-check-label" htmlFor="ordAuto">Check for new orders every 30 seconds</label>
              </div>
              {(extraFilters > 0 || customer) && <button type="button" className="btn btn-link ms-auto" onClick={clearFilters}>Clear filters</button>}
            </div>
          </div>
        )}

        {/* Status chips: one row, in the order an order moves. The count is how many are there now. */}
        <div className="d-flex flex-wrap gap-2 mb-1" role="group" aria-label="Order status">
          {TABS.map((t) => {
            const n = countFor(t);
            return (
              <button key={t.id} type="button" className={chip(tab === t.id)} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
                <span className={`badge rounded-pill ms-2 ${tab === t.id ? "text-bg-light" : n > 0 && (t.id === "pending" || t.id === "fordelivery") ? "text-bg-warning" : "text-bg-secondary"}`}>{n > 99 ? "99+" : n}</span>
              </button>
            );
          })}
        </div>
        <p className="text-muted small mb-2">{curTab.hint}</p>

        {wide ? (
          <div className="row g-3">
            <div className={orderDetail ? "col-lg-7" : "col-12"}>{list}</div>
            {orderDetail && <div className="col-lg-5"><div className="pos-side border rounded bg-white p-3" role="region" aria-labelledby="orderDetailTitle">{detailPane}</div></div>}
          </div>
        ) : list}

        {/* Batch bar — sticks to the bottom (above the tablet bar) while orders are ticked. */}
        {selected.size > 0 && (
          <div className="position-sticky bottom-0 sticky-above-bar bg-white border border-dark rounded shadow p-2 mt-2 d-flex flex-wrap gap-2 align-items-center" style={{ zIndex: 5 }}>
            <span className="fw-bold me-1">{selected.size} ticked</span>
            {selected.size < orders.length && <button type="button" className="btn btn-outline-dark" onClick={() => setSelected(new Set(orders.map((x) => x.id)))}>Tick all {orders.length}</button>}
            {canWrite && canBatchReceive && (
              <button className="btn btn-success" disabled={transitioning === "batch"} onClick={() => runBatch("Received", async (o) => doTransition(o.id, "CONFIRMED"))}>
                <i className="bi bi-check-lg me-1" aria-hidden="true"></i>Receive
              </button>
            )}
            {canWrite && canBatchSend && (
              <button className="btn btn-success" disabled={transitioning === "batch"} onClick={() => runBatch("Sent for delivery", async (o) => sendForDelivery(o.id))}>
                <i className="bi bi-truck me-1" aria-hidden="true"></i>Send for delivery
              </button>
            )}
            {canWrite && canBatchPickup && (
              <button className="btn btn-success" disabled={transitioning === "batch"} onClick={() => runBatch("Completed (pickup)", async (o) => completeNow(o.id))}>
                <i className="bi bi-bag-check me-1" aria-hidden="true"></i>Complete pickup
              </button>
            )}
            {canWrite && canBatchDelivered && (
              <button className="btn btn-success" disabled={transitioning === "batch"} onClick={() => runBatch("Marked delivered", async (o) => doTransition(o.id, "DELIVERED"))}>
                <i className="bi bi-check2-circle me-1" aria-hidden="true"></i>Mark delivered
              </button>
            )}
            {canWrite && canBatchCancel && (
              <button className="btn btn-outline-danger" disabled={transitioning === "batch"} onClick={() => setPendingReason({ orderId: "__BATCH__", to: "CANCELLED" })}>
                <i className="bi bi-x-lg me-1" aria-hidden="true"></i>Cancel
              </button>
            )}
            <button className="btn btn-outline-dark ms-auto" disabled={transitioning === "batch"} onClick={clearSelection}>Untick</button>
          </div>
        )}

        {/* Upright: the order opens full screen, with Back. */}
        {!wide && orderDetail && (
          <>
            <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="orderDetailTitle">
              <div className="modal-dialog modal-fullscreen-lg-down modal-dialog-scrollable">
                <div className="modal-content">
                  <div className="modal-body">{detailPane}</div>
                </div>
              </div>
            </div>
            <div className="modal-backdrop fade show"></div>
          </>
        )}

      {/* Reason modal */}
      {pendingReason && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{pendingReason.to === "FAILED_DELIVERY" ? "Why did the delivery fail?" : pendingReason.orderId === "__BATCH__" ? `Why cancel ${selected.size} orders?` : "Why cancel this order?"}</h5>
                  <button type="button" className="btn-close" onClick={() => setPendingReason(null)}></button>
                </div>
                <div className="modal-body">
                  <textarea className="form-control" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer changed their mind" aria-label="Reason (at least 3 letters)" />
                  <div className="form-text">At least 3 letters. Saved in the order history.</div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setPendingReason(null)}>Go back</button>
                  <button className="btn btn-danger" disabled={reason.trim().length < 3} onClick={() => {
                         if (pendingReason.orderId === "__BATCH__") {
                           void runBatch("Cancelled", async (o) => doTransition(o.id, "CANCELLED", reason));
                           setPendingReason(null); setReason("");
                         } else {
                           doTransition(pendingReason.orderId, pendingReason.to, reason);
                         }
                       }}>{pendingReason.to === "FAILED_DELIVERY" ? "Mark failed" : "Cancel order"}</button>
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
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConfirmAction(null)}>Go back</button>
                  <button className="btn btn-danger" disabled={transitioning === confirmAction.orderId} onClick={() => doVoidRefund(confirmAction.orderId, confirmAction.kind, reason)}>
                    {transitioning === confirmAction.orderId ? "Working…" : confirmAction.kind === "refund" ? "Refund" : "Void"}
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
                    <button type="button" className={`btn btn-sm ${payMethod === "credit" ? "btn-warning" : "btn-outline-warning"} flex-fill`} onClick={() => setPayMethod("credit")}>Credit</button>
                  </div>
                  {payMethod === "cash" ? (
                    <>
                      <label htmlFor="orders-amount-tendered" className="form-label small">Amount tendered</label>
                      <input id="orders-amount-tendered" className="form-control" type="number" min="0" step="0.01" placeholder={`Due ${toPesos(payHold.totalMinor)}`} value={tendered} onChange={(e) => setTendered(e.target.value)} />
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
                                                <label htmlFor="orders-start" className="form-label small">Start</label>
                                                <input id="orders-start" className="form-control form-control-sm" type="date" value={startAt ? startAt.slice(0, 10) : ""} onChange={(e) => setStartAt(e.target.value ? new Date(e.target.value).toISOString() : "")} />
                                              </div>
                                              <div className="col-6">
                                                <label htmlFor="orders-due" className="form-label small">Due</label>
                                                <input id="orders-due" className="form-control form-control-sm" type="date" value={dueAt ? dueAt.slice(0, 10) : ""} onChange={(e) => setDueAt(e.target.value ? new Date(e.target.value).toISOString() : "")} />
                                              </div>
                                            </div>
                                            <div className="mb-1">
                                              <div className="small text-muted mb-1">Customer signature required for credit</div>
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
                      <label className="form-check-label small" htmlFor="splitPayToggle">Split payment (cash + gcash + credit)</label>
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
      {reviewOpen && <PaymentReview onClose={() => setReviewOpen(false)} onChanged={() => void load()} />}
      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} onChanged={() => void load()} />}

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
                          Payment collected: <strong>{deliveryConfirm.method === "cash" ? "Cash" : "Credit"}</strong> · {toPesos(deliveryConfirm.totalMinor)}
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

    </div>
  );
}