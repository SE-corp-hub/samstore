"use client";

// Rice Ops M7 — the sales agent's phone: three buttons.
//   New order    — customer, rice, amount, address, preferred store → Waiting
//   My orders    — every order and where it stands (Approved, On the way, Delivered, Paid…)
//   Status       — only the ones still moving
// One key per order, kept until it is saved: a double-tap is one order.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { newSaleKey } from "../../lib/saleKey";
import NumPad from "./NumPad";

interface Loc { id: string; name: string; code: string | null; type: string }
interface Item { id: string; name: string; loose: boolean; priceMinor: number; stock: Record<string, number> }
type Mode = "PIECE" | "KILO" | "PESO";
interface Line { productId: string; mode: Mode; value: string }
interface Order {
  id: string; orderNumber: string; status: string; statusLabel: string; totalMinor: number; customerName: string; address: string;
  location: { id: string; name: string } | null; declineReason: string | null; createdAt: string;
  lines: { name: string; soldBy: string | null; quantity: number; grams: number | null; lineTotalMinor: number }[];
}
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const peso = (m: number) => `₱${(m / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const kg = (g: number) => `${(g / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg`;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const toMinor = (s: string) => Math.round(Number(s || "0") * 100);
const STATUS_CLASS: Record<string, string> = {
  NAGHIHINTAY: "text-bg-warning", APRUBADO: "text-bg-primary", NAILABAS: "text-bg-info", NAIHATID: "text-bg-info", BAYAD_NA: "text-bg-success", TINANGGIHAN: "text-bg-danger", KINANSELA: "text-bg-secondary",
};

export default function AgentPanel() {
  const [screen, setScreen] = useState<"home" | "new" | "mine" | "status">("home");
  const [orders, setOrders] = useState<Order[]>([]);
  const loadMine = useCallback(async () => {
    const res = await fetch(`${API_URL}/admin/agent-orders/mine`, { headers: adminHeaders() });
    if (res.ok) setOrders((await res.json()).orders as Order[]);
  }, []);
  useEffect(() => { void loadMine(); }, [loadMine, screen]);
  const moving = orders.filter((o) => !["BAYAD_NA", "TINANGGIHAN", "KINANSELA"].includes(o.status));

  if (screen === "new") return <NewOrder onDone={() => setScreen("mine")} onCancel={() => setScreen("home")} />;
  if (screen === "mine" || screen === "status") {
    const list = screen === "mine" ? orders : moving;
    return (
      <div style={{ fontSize: 18, maxWidth: 620 }}>
        <button type="button" className="btn btn-link px-0 mb-2" onClick={() => setScreen("home")}>← Back</button>
        <h1 className="h4">{screen === "mine" ? "My orders" : "Status"}</h1>
        {list.length === 0 ? <p className="text-muted">None.</p> : (
          <div className="list-group">
            {list.map((o) => (
              <div key={o.id} className="list-group-item py-3">
                <div className="d-flex justify-content-between gap-2">
                  <span className="fw-semibold">{o.customerName}</span>
                  <span className={`badge ${STATUS_CLASS[o.status] ?? "text-bg-light"} fs-6`}>{o.statusLabel}</span>
                </div>
                <div className="small text-muted">{o.orderNumber} · {o.location?.name} · {new Date(o.createdAt).toLocaleString("en-PH")}</div>
                <div>{o.lines.map((l) => (l.soldBy === "PIECE" || !l.grams ? `${l.quantity} × ${l.name}` : `${kg(l.grams)} ${l.name}`)).join(", ")} — <strong>{peso(o.totalMinor)}</strong></div>
                {o.declineReason && <div className="text-danger">Reason: {o.declineReason}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 18, maxWidth: 420 }}>
      <h1 className="h4 mb-3">Agent orders</h1>
      <div className="d-grid gap-3">
        <button type="button" className="btn btn-success btn-lg py-4 fs-4" onClick={() => setScreen("new")}>New order</button>
        <button type="button" className="btn btn-outline-dark btn-lg py-4 fs-4" onClick={() => setScreen("mine")}>My orders</button>
        <button type="button" className="btn btn-outline-dark btn-lg py-4 fs-4" onClick={() => setScreen("status")}>Status {moving.length > 0 && <span className="badge text-bg-warning">{moving.length}</span>}</button>
      </div>
    </div>
  );
}

function NewOrder({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [locationId, setLocationId] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [editing, setEditing] = useState<Line | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);

  const load = useCallback(async (loc?: string) => {
    const res = await fetch(`${API_URL}/admin/agent-orders/catalog${loc ? `?locationId=${encodeURIComponent(loc)}` : ""}`, { headers: adminHeaders() });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok || !d) { setError(errText(d, "Could not load")); return; }
    const stores = (d.locations as Loc[]).filter((l) => l.type === "STORE");
    setLocations(stores);
    setItems(d.products as Item[]);
    setLocationId((cur) => cur || stores[0]?.id || "");
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (locationId) void load(locationId); }, [locationId, load]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const amount = (l: Line) => {
    const it = byId.get(l.productId);
    if (!it) return 0;
    if (l.mode === "PESO") return toMinor(l.value);
    if (l.mode === "KILO") return Math.round((Number(l.value || "0") * 1000 * it.priceMinor) / 1000);
    return Number(l.value || "0") * it.priceMinor;
  };
  const total = lines.reduce((s, l) => s + amount(l), 0);
  const ready = !!locationId && lines.length > 0 && name.trim().length >= 2 && phone.trim().length >= 10 && address.trim().length >= 5 && !busy;

  const save = async () => {
    setBusy(true); setError(null);
    if (!keyRef.current) keyRef.current = newSaleKey();
    const body = {
      idempotencyKey: keyRef.current, locationId, customerName: name.trim(), customerPhone: phone.trim(), address: address.trim(), landmark: landmark.trim() || undefined, note: note.trim() || undefined,
      lines: lines.map((l) => ({ productId: l.productId, ...(l.mode === "PIECE" ? { quantity: Number(l.value) } : l.mode === "KILO" ? { kilos: l.value } : { amountMinor: toMinor(l.value) }) })),
    };
    try {
      const res = await fetch(`${API_URL}/admin/agent-orders`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
      const d = (await res.json().catch(() => null)) as ApiBody | null;
      if (!res.ok) { setError(errText(d, "The order was not sent")); return; }
      keyRef.current = null;
      toast(`Sent: ${String(d?.orderNumber ?? "")} — waiting for the store`);
      onDone();
    } catch {
      setError("No signal — try again. The order will not be doubled.");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    const it = byId.get(editing.productId);
    return (
      <div className="card border-success" style={{ maxWidth: 520, fontSize: 18 }}>
        <div className="card-body">
          <h2 className="h5">{it?.name} · {peso(it?.priceMinor ?? 0)}{it?.loose ? "/kg" : ""}</h2>
          {it?.loose && (
            <div className="btn-group w-100 mb-3" role="group" aria-label="Kilos or pesos?">
              <button type="button" className={`btn btn-lg ${editing.mode === "KILO" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setEditing({ ...editing, mode: "KILO", value: "" })}>Kilos</button>
              <button type="button" className={`btn btn-lg ${editing.mode === "PESO" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setEditing({ ...editing, mode: "PESO", value: "" })}>Pesos</button>
            </div>
          )}
          <NumPad value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} decimals={editing.mode === "KILO" ? 3 : editing.mode === "PESO" ? 2 : 0}
            label="Amount" unit={editing.mode === "PESO" ? "₱" : editing.mode === "KILO" ? "kg" : "sacks"} />
          <div className="fs-5 mt-2">= <strong>{peso(amount(editing))}</strong></div>
          <div className="d-flex justify-content-between mt-3">
            <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setEditing(null)}>Back</button>
            <button type="button" className="btn btn-success btn-lg" disabled={amount(editing) <= 0} onClick={() => { setLines([...lines.filter((l) => l.productId !== editing.productId), editing]); setEditing(null); }}>Add</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontSize: 18, maxWidth: 620 }}>
      <button type="button" className="btn btn-link px-0 mb-2" onClick={onCancel}>← Back</button>
      <h1 className="h4">New order</h1>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      <label className="form-label" htmlFor="ag-store">Store that delivers</label>
      <select id="ag-store" className="form-select form-select-lg mb-3" value={locationId} onChange={(e) => { setLocationId(e.target.value); setLines([]); }}>
        {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      <div className="row g-2 mb-3">
        {items.map((i) => (
          <div key={i.id} className="col-6 col-md-4">
            <button type="button" className="btn btn-outline-dark w-100 h-100 text-start p-2" style={{ minHeight: 90 }} onClick={() => setEditing({ productId: i.id, mode: i.loose ? "KILO" : "PIECE", value: "" })}>
              <div className="fw-semibold">{i.name}</div>
              <div>{peso(i.priceMinor)}{i.loose ? "/kg" : ""}</div>
            </button>
          </div>
        ))}
      </div>
      {lines.length > 0 && (
        <ul className="list-group mb-3" style={{ fontVariantNumeric: "tabular-nums" }}>
          {lines.map((l) => (
            <li key={l.productId} className="list-group-item d-flex justify-content-between">
              <span>{l.mode === "PIECE" ? `${l.value} × ` : l.mode === "KILO" ? `${l.value} kg ` : `₱${l.value} of `}{byId.get(l.productId)?.name}</span>
              <span>{peso(amount(l))} <button type="button" className="btn btn-link text-danger p-0 ms-2" aria-label="Remove" onClick={() => setLines(lines.filter((x) => x !== l))}>×</button></span>
            </li>
          ))}
          <li className="list-group-item d-flex justify-content-between fw-bold"><span>Total</span><span>{peso(total)}</span></li>
        </ul>
      )}
      <label className="form-label" htmlFor="ag-name">Customer name</label>
      <input id="ag-name" className="form-control form-control-lg mb-2" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} />
      <label className="form-label" htmlFor="ag-phone">Customer mobile</label>
      <input id="ag-phone" className="form-control form-control-lg mb-2" inputMode="tel" placeholder="09xx xxx xxxx" value={phone} onChange={(e) => setPhone(e.target.value.slice(0, 16))} />
      <label className="form-label" htmlFor="ag-addr">Address</label>
      <input id="ag-addr" className="form-control form-control-lg mb-2" value={address} onChange={(e) => setAddress(e.target.value.slice(0, 200))} />
      <label className="form-label" htmlFor="ag-mark">Landmark (if any)</label>
      <input id="ag-mark" className="form-control form-control-lg mb-2" value={landmark} onChange={(e) => setLandmark(e.target.value.slice(0, 120))} />
      <label className="form-label" htmlFor="ag-note">Note for the store (if any)</label>
      <input id="ag-note" className="form-control form-control-lg mb-3" value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))} />
      <button type="button" className="btn btn-success btn-lg w-100" disabled={!ready} onClick={() => void save()}>{busy ? "Please wait…" : `Send the order (${peso(total)})`}</button>
    </div>
  );
}
