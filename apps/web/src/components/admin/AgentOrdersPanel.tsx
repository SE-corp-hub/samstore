"use client";

// Rice Ops M7 — the store's side of agent orders.
//   Waiting     — Approve (choose where each line comes from; it is held there and
//                 appears on that location's Release list) or Decline with a reason.
//   In progress — approved orders waiting for Delivered / Not delivered;
//                 once delivered, Take payment: cash, GCash or credit for what was delivered.
//   Done        — paid, declined or cancelled (last 30 days).

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import NumPad from "./NumPad";
import SignaturePad from "./SignaturePad";
import { askText } from "../../lib/ask";

interface Loc { id: string; name: string; code: string | null; type: string }
interface Order {
  id: string; orderNumber: string; status: string; statusLabel: string; totalMinor: number; customerName: string; customerPhone: string; address: string; landmark: string | null; note: string | null;
  location: { id: string; name: string } | null; agentName: string | null; declineReason: string | null; createdAt: string; readyToPay: boolean;
  lines: { id: string; productId: string | null; name: string; soldBy: string | null; quantity: number; grams: number | null; lineTotalMinor: number }[];
  trips: { id: string; docNumber: string | null; productId: string; status: string; releasedQty: number | null; deliveredQty: number | null; fromLocationId: string }[];
}
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const peso = (m: number) => `₱${(m / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const kg = (g: number) => `${(g / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg`;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const toMinor = (s: string) => Math.round(Number(s || "0") * 100);
const lineText = (l: Order["lines"][number]) => (l.soldBy === "PIECE" || !l.grams ? `${l.quantity} × ${l.name}` : `${kg(l.grams)} ${l.name}`);

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
}

export default function AgentOrdersPanel() {
  const [view, setView] = useState<"waiting" | "active" | "done">("waiting");
  const [orders, setOrders] = useState<Order[]>([]);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [stock, setStock] = useState<Record<string, Record<string, number>>>({});
  const [sources, setSources] = useState<Record<string, string>>({});
  const [paying, setPaying] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [o, c] = await Promise.all([
      fetch(`${API_URL}/admin/agent-orders?view=${view}`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${API_URL}/admin/benta/catalog`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
    ]);
    setOrders((o?.orders ?? []) as Order[]);
    setLocations(((c?.locations ?? []) as (Loc & { type?: string })[]).filter((l) => l.type !== "BUFFER"));
    setStock(Object.fromEntries(((c?.products ?? []) as { id: string; stock: Record<string, number> }[]).map((p) => [p.id, p.stock])));
  }, [view]);
  useEffect(() => { void load().catch(() => setError("Could not load")); }, [load]);

  const approve = async (o: Order) => {
    setError(null);
    const r = await post(`/admin/agent-orders/${o.id}/approve`, { sources: o.lines.map((l) => ({ itemId: l.id, sourceLocationId: sources[l.id] || o.location?.id })) });
    if (!r.ok) { setError(errText(r.data, "Not approved")); return; }
    toast(`Approved ${o.orderNumber} — the rice left the store. Tap Delivered when it arrives.`);
    await load();
  };
  const delivered = async (o: Order) => {
    setError(null);
    const r = await post(`/admin/agent-orders/${o.id}/delivered`, {});
    if (!r.ok) { setError(errText(r.data, "Not saved")); return; }
    toast("Delivered — you can take payment now");
    await load();
  };
  const notDelivered = async (o: Order) => {
    const reason = await askText(`Why was ${o.customerName}'s order not delivered? The rice goes back on the shelf.`, { ok: "Not delivered", danger: true });
    if (!reason) return;
    setError(null);
    const r = await post(`/admin/agent-orders/${o.id}/not-delivered`, { reason });
    if (!r.ok) { setError(errText(r.data, "Not saved")); return; }
    toast("Not delivered — the rice is back in stock");
    await load();
  };
  const decline = async (o: Order) => {
    const reason = await askText(`Why decline ${o.customerName}'s order? (the agent will see this)`, { ok: "Decline", danger: true });
    if (!reason) return;
    const r = await post(`/admin/agent-orders/${o.id}/decline`, { reason });
    if (!r.ok) { setError(errText(r.data, "Not declined")); return; }
    toast("Declined");
    await load();
  };

  if (paying) return <PayAgentOrder order={paying} onCancel={() => setPaying(null)} onDone={async () => { setPaying(null); await load(); }} />;

  return (
    <div style={{ fontSize: 18 }}>
      <h1 className="h4">Agent orders</h1>
      <ul className="nav nav-tabs mb-3">
        {([["waiting", "Waiting"], ["active", "In progress"], ["done", "Done"]] as const).map(([k, label]) => (
          <li key={k} className="nav-item"><button className={`nav-link ${view === k ? "active" : ""}`} onClick={() => setView(k)}>{label}</button></li>
        ))}
      </ul>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {orders.length === 0 && <p className="text-muted">None.</p>}
      <div className="d-grid gap-3" style={{ maxWidth: 720 }}>
        {orders.map((o) => (
          <div key={o.id} className="card">
            <div className="card-body">
              <div className="d-flex justify-content-between gap-2">
                <span className="fw-semibold">{o.customerName} · {o.customerPhone}</span>
                <span className="badge text-bg-light border">{o.statusLabel}</span>
              </div>
              <div className="small text-muted">{o.orderNumber} · agent: {o.agentName ?? "—"} · {new Date(o.createdAt).toLocaleString("en-PH")}</div>
              <div className="small">{o.address}{o.landmark ? ` (${o.landmark})` : ""}</div>
              {o.note && <div className="small fst-italic">“{o.note}”</div>}
              <ul className="list-unstyled my-2">
                {o.lines.map((l) => (
                  <li key={l.id} className="d-flex flex-wrap justify-content-between align-items-center gap-2 py-1 border-bottom">
                    <span>{lineText(l)} — {peso(l.lineTotalMinor)}</span>
                    {view === "waiting" && l.productId && (
                      <select className="form-select" style={{ maxWidth: 260 }} aria-label={`Take ${l.name} from`} value={sources[l.id] || o.location?.id || ""} onChange={(e) => setSources({ ...sources, [l.id]: e.target.value })}>
                        {locations.map((loc) => {
                          const n = stock[l.productId!]?.[loc.id] ?? 0;
                          return <option key={loc.id} value={loc.id}>Take from {loc.name} (has {l.soldBy === "PIECE" ? n : kg(n)})</option>;
                        })}
                      </select>
                    )}
                    {view !== "waiting" && (() => {
                      const t = o.trips.find((x) => x.productId === l.productId);
                      return t ? <span className="small text-muted">{t.docNumber} · {t.deliveredQty === null ? "on the way" : t.deliveredQty > 0 ? "delivered" : "not delivered"}</span> : null;
                    })()}
                  </li>
                ))}
              </ul>
              <div className="d-flex justify-content-between align-items-center">
                <strong className="fs-5">{peso(o.totalMinor)}</strong>
                {view === "waiting" && (
                  <div className="d-flex gap-2">
                    <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => void decline(o)}>Decline</button>
                    <button type="button" className="btn btn-success btn-lg" onClick={() => void approve(o)}>Approve</button>
                  </div>
                )}
                {view === "active" && o.readyToPay && <button type="button" className="btn btn-success btn-lg" onClick={() => setPaying(o)}>Take payment</button>}
                {view === "active" && !o.readyToPay && (
                  <div className="d-flex gap-2">
                    <button type="button" className="btn btn-outline-danger btn-lg" onClick={() => void notDelivered(o)}>Not delivered</button>
                    <button type="button" className="btn btn-success btn-lg" onClick={() => void delivered(o)}>Delivered</button>
                  </div>
                )}
                {o.declineReason && <span className="text-danger small">Declined: {o.declineReason}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PayAgentOrder({ order, onCancel, onDone }: { order: Order; onCancel: () => void; onDone: () => void | Promise<void> }) {
  const [method, setMethod] = useState<"cash" | "gcash" | "utang">("cash");
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delivered = new Map(order.trips.map((t) => [t.productId, t.deliveredQty ?? 0]));
  const partial = order.lines.some((l) => (delivered.get(l.productId ?? "") ?? 0) < l.quantity);
  const save = async () => {
    setBusy(true); setError(null);
    const r = await post(`/admin/agent-orders/${order.id}/pay`, {
      method, tenderedMinor: method === "cash" && tendered ? toMinor(tendered) : undefined, reference: method === "gcash" ? reference.trim() : undefined,
      signatures: method === "utang" && sig ? [{ signerKind: "CUSTOMER", signerName: order.customerName, imagePng: sig }] : [],
    });
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "Did not go through")); return; }
    toast(`Paid: ${peso(Number(r.data?.dueMinor ?? 0))}${Number(r.data?.changeMinor ?? 0) > 0 ? ` · change ${peso(Number(r.data?.changeMinor))}` : ""}`);
    await onDone();
  };
  return (
    <div className="card border-success" style={{ maxWidth: 520, fontSize: 18 }}>
      <div className="card-body">
        <h2 className="h5">Take payment — {order.customerName}</h2>
        {partial && <div className="alert alert-info py-2">Not everything was delivered — only what was delivered is paid.</div>}
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <div className="d-grid gap-2 mb-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          {(["cash", "gcash", "utang"] as const).map((m) => (
            <button key={m} type="button" className={`btn btn-lg ${method === m ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setMethod(m)}>{m === "cash" ? "Cash" : m === "gcash" ? "GCash" : "Credit"}</button>
          ))}
        </div>
        {method === "cash" && <NumPad value={tendered} onChange={setTendered} decimals={2} label="Cash received" unit="₱" />}
        {method === "gcash" && (<><label className="form-label" htmlFor="pa-ref">GCash reference no.</label>
          <input id="pa-ref" className="form-control form-control-lg" inputMode="numeric" value={reference} onChange={(e) => setReference(e.target.value.replace(/\s/g, "").slice(0, 40))} /></>)}
        {method === "utang" && (<><div className="fw-semibold">Signature of {order.customerName}</div><SignaturePad onSignature={setSig} /></>)}
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>Back</button>
          <button type="button" className="btn btn-success btn-lg" disabled={busy || (method === "gcash" && reference.trim().length < 4) || (method === "utang" && !sig)} onClick={() => void save()}>{busy ? "Please wait…" : "Receive payment"}</button>
        </div>
      </div>
    </div>
  );
}
