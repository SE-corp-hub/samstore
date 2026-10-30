"use client";

// Rice Ops M6 — Credit: the customer list, Credit payment at this location, and the texts.
//   * Customers: name + mobile. New customers have NO credit limit; the owner/manager can set one (0 = no credit). At the limit, the customer pays first.
//   * Credit payment: cash or GCash, partial is fine; the money goes to this location's
//     drawer; a text goes out with what is left.
//   * Texts: each one shows Sent / Failed (with Send again) / No number.
//   * Settings (owner): texts on/off, monthly balance text, overdue reminder.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, isOwnerRole } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import NumPad from "./NumPad";
import SignaturePad from "./SignaturePad";
import { PesoInput } from "../NumberBoxes";
import { buildText, openTextApp, type TextKind } from "../../lib/text-message";
import { creditStatusWords, limitPhrase } from "../../lib/credit-status";
import { printSlip } from "../../lib/slip-print";
import { peso } from "../../lib/number-format";
import { isBelowCost } from "../../lib/below-cost";
import { askBelowCost, saveUnitCost } from "./BelowCostDialog";

interface Cust {
  id: string; name: string; phone: string | null; balanceMinor: number; creditApproved: boolean; limitMinor: number | null; unlimited: boolean; ownLimit: boolean; status: string; availableMinor: number | null;
  oldestUtangAt: string | null; lastText: { status: string; createdAt: string } | null;
}
interface Sms { id: string; template: string; text: string; status: "QUEUED" | "SENT" | "FAILED" | "SKIPPED" | "OPENED"; provider: string | null; lastError: string | null; createdAt: string; storeCustomer: { customer: { name: string | null } } | null }
interface Settings { utangSmsEnabled: boolean; utangMonthlyReminder: boolean; utangOverdueReminder: boolean; utangOverdueDays: number; smsSenderName: string | null }
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

/** Days the oldest unpaid purchase is past its due date (payments are applied to the oldest purchases first). */
function overdueDays(entries: { type: string; amountMinor: number; startAt: string; dueAt: string | null }[], now = Date.now()): number {
  const sorted = [...entries].sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  let paid = sorted.filter((e) => e.type === "payment").reduce((s, e) => s + Math.abs(e.amountMinor), 0);
  for (const e of sorted) {
    if (e.type !== "purchase") continue;
    const left = e.amountMinor - Math.min(paid, e.amountMinor);
    paid -= Math.min(paid, e.amountMinor);
    if (left > 0 && e.dueAt) return Math.max(0, Math.floor((now - new Date(e.dueAt).getTime()) / 86_400_000));
  }
  return 0;
}

const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const toMinor = (s: string) => Math.round(Number(s || "0") * 100);
const days = (iso: string | null) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : 0);

function SmsBadge({ s }: { s: Sms["status"] }) {
  if (s === "SENT") return <span className="badge text-bg-success">Sent</span>;
  if (s === "QUEUED") return <span className="badge text-bg-info">Sending</span>;
  if (s === "FAILED") return <span className="badge text-bg-danger">Failed</span>;
  if (s === "OPENED") return <span className="badge text-bg-primary" title="Opened in the phone's text app — we cannot tell if it was sent">Text opened</span>;
  return <span className="badge text-bg-secondary">Not sent</span>;
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: ApiBody | null }> {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
}

export default function UtangRicePanel({ role }: { role?: string; onNavigate?: (tab: string) => void }) {
  const owner = !!role && (isOwnerRole(role) || role === "MANAGER");
  const [tab, setTab] = useState<"list" | "texts" | "settings">("list");
  const [customers, setCustomers] = useState<Cust[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Cust | null>(null);
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [texts, setTexts] = useState<Sms[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"owing" | "all">("owing");
  const [storeName, setStoreName] = useState("");
  const [history, setHistory] = useState<{ id: string; type: string; amountMinor: number; startAt: string; dueAt: string | null; note: string | null }[] | null>(null);
  const [justPaid, setJustPaid] = useState<{ paidMinor: number; balanceMinor: number } | null>(null);

  const load = useCallback(async () => {
    const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
    const res = await fetch(`${API_URL}/admin/utang/customers${q}`, { headers: adminHeaders() });
    const d = await res.json().catch(() => null);
    if (!res.ok) { setError(errText(d, "Could not load")); return; }
    setCustomers(d.customers as Cust[]);
  }, [search]);
  const loadTexts = useCallback(async (customerId?: string) => {
    const res = await fetch(`${API_URL}/admin/sms${customerId ? `?customerId=${encodeURIComponent(customerId)}` : ""}`, { headers: adminHeaders() });
    if (res.ok) setTexts((await res.json()).messages as Sms[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((me) => setLocationId(me?.homeLocationId ?? null));
    void fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => setStoreName(d?.name ?? "")).catch(() => {});
    void fetch(`${API_URL}/admin/utang/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setSettings(d.settings as Settings));
  }, []);
  useEffect(() => { if (tab === "texts") void loadTexts(); }, [tab, loadTexts]);
  useEffect(() => { if (selected) void loadTexts(selected.id); }, [selected, loadTexts]);
  useEffect(() => {
    setHistory(null); setJustPaid(null);
    if (!selected) return;
    void fetch(`${API_URL}/admin/credit/${encodeURIComponent(selected.id)}`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => setHistory(d?.entries ?? [])).catch(() => setHistory([]));
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Open the phone's text app with the customer's balance (or a payment receipt) ready. */
  const printStatement = (c: Cust, a4: boolean) => {
    const entries = [...(history ?? [])].sort((x, y) => new Date(x.startAt).getTime() - new Date(y.startAt).getTime());
    let run = 0;
    const over = overdueDays(entries);
    printSlip({
      storeName: storeName || "SAM STORE", title: "CREDIT STATEMENT", reference: c.name, when: new Date().toLocaleDateString("en-PH"), a4,
      lines: [...(c.phone ? [{ label: "Phone", value: c.phone }] : []), { label: "Limit", value: limitPhrase(c, peso) }],
      rows: entries.map((e) => {
        run += e.amountMinor;
        return {
          name: `${new Date(e.startAt).toLocaleDateString("en-PH")} ${e.type === "payment" ? "Payment" : "Utang"}${e.dueAt && e.type === "purchase" ? ` (due ${new Date(e.dueAt).toLocaleDateString("en-PH")})` : ""}${e.note ? ` ${e.note}` : ""}`,
          qty: `${e.type === "payment" ? "-" : ""}${peso(Math.abs(e.amountMinor))}  bal ${peso(run)}`,
        };
      }),
      totals: [{ label: "Balance", value: peso(c.balanceMinor) }, { label: "Days overdue", value: over > 0 ? String(over) : "none" }],
      signatures: [{ role: "Received by", name: "" }],
    });
  };
  const textCustomer = (c: Cust, kind: TextKind, extra: { paidMinor?: number; balanceMinor: number }) => {
    const text = buildText(kind, { storeName: storeName || "SAM STORE", customerName: c.name, paidMinor: extra.paidMinor, balanceMinor: extra.balanceMinor });
    if (!openTextApp({ phone: c.phone, text, template: kind, storeCustomerId: c.id })) { toast("This customer has no valid mobile number — add it first", "danger"); return; }
    window.setTimeout(() => void loadTexts(c.id), 1500);
  };

  const resend = async (id: string) => {
    const r = await post(`/admin/sms/${id}/resend`, {});
    if (!r.ok) { setError(errText(r.data, "Could not send")); return; }
    toast(r.data?.sent ? "Sent" : "Still not sent");
    await loadTexts(selected?.id);
  };

  const saveSettings = async (patch: Partial<Settings>) => {
    const r = await post("/admin/utang/settings", patch);
    if (!r.ok) { setError(errText(r.data, "Could not save")); return; }
    setSettings(r.data?.settings as Settings);
    toast("Saved");
  };

  const owing = customers.filter((c) => c.balanceMinor > 0);
  const shown = filter === "owing" ? owing : customers;
  const totalOwed = owing.reduce((s, c) => s + c.balanceMinor, 0);

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
        <h1 className="h4 mb-0">Credit</h1>
        <span className="fs-5" style={{ fontVariantNumeric: "tabular-nums" }}>Total: <strong>{peso(totalOwed)}</strong> · {owing.length} customers</span>
      </div>
      <ul className="nav nav-tabs mb-3">
        <li className="nav-item"><button className={`nav-link ${tab === "list" ? "active" : ""}`} onClick={() => { setTab("list"); setSelected(null); }}>Customers</button></li>
        <li className="nav-item"><button className={`nav-link ${tab === "texts" ? "active" : ""}`} onClick={() => { setTab("texts"); setSelected(null); }}>Texts</button></li>
        {owner && <li className="nav-item"><button className={`nav-link ${tab === "settings" ? "active" : ""}`} onClick={() => { setTab("settings"); setSelected(null); }}>Settings</button></li>}
      </ul>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {tab === "list" && !selected && !adding && (
        <>
          <div className="d-flex gap-2 mb-3">
            <input className="form-control form-control-lg" placeholder="Search (name or number)" aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button type="button" className="btn btn-success btn-lg text-nowrap flex-shrink-0" onClick={() => setAdding(true)}>+ Customer</button>
          </div>
          <div className="btn-group mb-3" role="group" aria-label="Who to show">
            <button type="button" className={`btn ${filter === "owing" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setFilter("owing")}>Who owes ({owing.length})</button>
            <button type="button" className={`btn ${filter === "all" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setFilter("all")}>All customers ({customers.length})</button>
          </div>
          <div className="list-group">
            {shown.map((c) => (
              <button key={c.id} type="button" className="list-group-item list-group-item-action py-3 d-flex justify-content-between align-items-center" onClick={() => setSelected(c)}>
                <span>
                  <span className="fw-semibold">{c.name}</span>
                  <span className="d-block small text-muted">{c.phone ?? "no number"} · limit {limitPhrase(c, peso)}{c.balanceMinor > 0 && c.oldestUtangAt ? ` · ${days(c.oldestUtangAt)} days` : ""}</span>
                </span>
                <span className="text-end" style={{ fontVariantNumeric: "tabular-nums" }}>
                  <span className={`fs-5 ${c.status === "AT_LIMIT" ? "text-danger" : ""}`}>{peso(c.balanceMinor)}</span>
                  {c.creditApproved && <span className="d-block"><span className={`badge ${creditStatusWords(c.status).cls}`}>{creditStatusWords(c.status).label}</span></span>}
                  {c.lastText?.status === "FAILED" && <span className="d-block"><span className="badge text-bg-danger">Failed</span></span>}
                </span>
              </button>
            ))}
            {shown.length === 0 && <p className="text-muted">{filter === "owing" ? "Nobody owes right now." : "No customers yet."}</p>}
          </div>
        </>
      )}

      {tab === "list" && adding && <AddCustomer owner={owner} onCancel={() => setAdding(false)} onDone={async () => { setAdding(false); await load(); }} />}

      {tab === "list" && selected && !paying && (
        <div style={{ maxWidth: 620 }}>
          <button type="button" className="btn btn-link px-0 mb-2" onClick={() => setSelected(null)}>← Customers</button>
          <div className="card mb-3">
            <div className="card-body">
              <div className="h5 mb-1">{selected.name}</div>
              <div className="text-muted mb-2">{selected.phone ?? "no number"}</div>
              <div className="fs-3" style={{ fontVariantNumeric: "tabular-nums" }}>Owes: <strong>{peso(selected.balanceMinor)}</strong></div>
              <div>Limit: {limitPhrase(selected, peso)}{!selected.creditApproved && " — cannot buy on credit yet"}</div>
              {selected.creditApproved && <div className="mb-1">Status: <span className={`badge ${creditStatusWords(selected.status).cls}`}>{creditStatusWords(selected.status).label}</span>{selected.availableMinor !== null && <span className="ms-2">can still borrow {peso(selected.availableMinor)}</span>}</div>}
              {selected.status === "AT_LIMIT" && <div className="alert alert-warning py-2 mt-2 mb-0">At the limit. The customer must pay some of the balance first, then can buy on credit again.</div>}
              {owner && <SpecialPrices customerId={selected.id} />}
              {owner && <LimitEditor customer={selected} onSaved={async () => { setSelected(null); await load(); }} />}
              <div className="d-grid gap-2 mt-3">
                <button type="button" className="btn btn-success btn-lg" disabled={selected.balanceMinor <= 0} onClick={() => setPaying(true)}>Credit payment</button>
                <button type="button" className="btn btn-outline-primary btn-lg" onClick={() => textCustomer(selected, "balance", { balanceMinor: selected.balanceMinor })}><i className="bi bi-chat-dots me-1"></i>Text the balance ({peso(selected.balanceMinor)})</button>
              </div>
              <div className="d-flex flex-wrap gap-2 mt-2">
                <button type="button" className="btn btn-outline-dark" disabled={!history} onClick={() => printStatement(selected, false)}><i className="bi bi-printer me-1"></i>Print statement (slip)</button>
                <button type="button" className="btn btn-outline-dark" disabled={!history} onClick={() => printStatement(selected, true)}><i className="bi bi-file-earmark-text me-1"></i>Print statement (A4)</button>
              </div>
              {justPaid && (
                <div className="alert alert-success mt-3 mb-0">
                  Received {peso(justPaid.paidMinor)} — {peso(justPaid.balanceMinor)} left.
                  <button type="button" className="btn btn-primary btn-sm ms-2" onClick={() => textCustomer(selected, "payment_received", { paidMinor: justPaid.paidMinor, balanceMinor: justPaid.balanceMinor })}>Text the customer</button>
                </div>
              )}
            </div>
          </div>
          <h2 className="h6">History</h2>
          {history === null ? <p className="text-muted">Loading…</p> : history.length === 0 ? <p className="text-muted">No credit entries yet.</p> : (
            <ul className="list-group mb-3" style={{ fontVariantNumeric: "tabular-nums" }}>
              {history.slice(0, 30).map((e) => (
                <li key={e.id} className="list-group-item d-flex justify-content-between gap-2">
                  <span className="small">{new Date(e.startAt).toLocaleDateString("en-PH")} · {e.type === "purchase" ? "Utang" : e.type === "payment" ? "Payment" : e.type}{e.dueAt && e.type === "purchase" ? ` · due ${new Date(e.dueAt).toLocaleDateString("en-PH")}` : ""}{e.note ? ` · ${e.note}` : ""}</span>
                  <span className={e.type === "payment" ? "text-success" : ""}>{e.type === "payment" ? "−" : ""}{peso(Math.abs(e.amountMinor))}</span>
                </li>
              ))}
            </ul>
          )}
          <h2 className="h6">Texts</h2>
          <TextList texts={texts} onResend={resend} />
        </div>
      )}

      {tab === "list" && selected && paying && (
        <PayForm customer={selected} locationId={locationId} onCancel={() => setPaying(false)}
          onDone={async (balanceMinor, paidMinor) => { setPaying(false); setSelected({ ...selected, balanceMinor }); await load(); await loadTexts(selected.id); setJustPaid({ paidMinor, balanceMinor }); }} />
      )}

      {tab === "texts" && <TextList texts={texts} onResend={resend} showName />}

      {tab === "settings" && owner && settings && (
        <div className="card" style={{ maxWidth: 520 }}>
          <div className="card-body">
            {([
              ["utangSmsEnabled", "Send a text for every credit sale and payment"],
              ["utangMonthlyReminder", "Monthly balance text (first day of the month)"],
              ["utangOverdueReminder", `Reminder when over ${settings.utangOverdueDays} days (once a week)`],
            ] as const).map(([k, label]) => (
              <div key={k} className="form-check form-switch mb-3">
                <input className="form-check-input" type="checkbox" id={`us-${k}`} checked={settings[k]} onChange={(e) => { const patch: Partial<Settings> = {}; patch[k] = e.target.checked; void saveSettings(patch); }} />
                <label className="form-check-label" htmlFor={`us-${k}`}>{label}</label>
              </div>
            ))}
            <p className="small text-muted mb-0">Until there is an SMS account, texts are recorded but not really sent (test mode).</p>
          </div>
        </div>
      )}
    </div>
  );
}

function TextList({ texts, onResend, showName = false }: { texts: Sms[]; onResend: (id: string) => void; showName?: boolean }) {
  if (texts.length === 0) return <p className="text-muted">No texts yet.</p>;
  return (
    <div className="list-group">
      {texts.map((t) => (
        <div key={t.id} className="list-group-item">
          <div className="d-flex justify-content-between gap-2">
            <span className="small text-muted">{showName && t.storeCustomer?.customer.name ? `${t.storeCustomer.customer.name} · ` : ""}{new Date(t.createdAt).toLocaleString("en-PH")}</span>
            <span><SmsBadge s={t.status} />{t.provider === "mock" && t.status === "SENT" && <span className="badge text-bg-warning border ms-1" title="No SMS provider yet — not really sent">test only · no real text sent</span>}</span>
          </div>
          <div>{t.text}</div>
          {t.lastError && t.status !== "SENT" && <div className="small text-danger">{t.lastError}</div>}
          {(t.status === "FAILED" || t.status === "SKIPPED") && <button type="button" className="btn btn-outline-dark btn-sm mt-1" onClick={() => onResend(t.id)}>Send again</button>}
        </div>
      ))}
    </div>
  );
}

function LimitEditor({ customer, onSaved }: { customer: Cust; onSaved: () => void | Promise<void> }) {
  const [value, setValue] = useState(customer.creditApproved && customer.limitMinor !== null && !customer.unlimited ? String(customer.limitMinor / 100) : "");
  const [busy, setBusy] = useState(false);
  const save = async (unlimited: boolean) => {
    setBusy(true);
    const limitMinor = toMinor(value);
    const r = await post(`/admin/utang/customers/${customer.id}/limit`, unlimited ? { unlimited: true } : { limitMinor });
    setBusy(false);
    if (!r.ok) { toast(errText(r.data, "Could not save")); return; }
    toast(unlimited ? "No limit" : limitMinor > 0 ? `Limit: ${peso(limitMinor)}` : "Credit removed");
    await onSaved();
  };
  return (
    <div className="mt-2">
      <div className="input-group">
        <span className="input-group-text">Limit ₱</span>
        <PesoInput aria-label="Limit" value={value} onChange={setValue} placeholder="0.00" />
        <button type="button" className="btn btn-outline-dark" disabled={busy} onClick={() => void save(false)}>Save limit</button>
      </div>
      <div className="d-flex flex-wrap gap-2 mt-2">
        {!customer.unlimited && <button type="button" className="btn btn-outline-secondary btn-sm" disabled={busy} onClick={() => void save(true)}>No limit</button>}
        <span className="small text-muted align-self-center">0 = no credit at all.</span>
      </div>
    </div>
  );
}

function AddCustomer({ owner, onCancel, onDone }: { owner: boolean; onCancel: () => void; onDone: () => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    const r = await post("/admin/utang/customers", { name: name.trim(), phone: phone.trim(), ...(owner && limit ? { limitMinor: toMinor(limit) } : {}) });
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "Could not add")); return; }
    toast(`Added: ${name.trim()}`);
    await onDone();
  };
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div className="card-body">
        <h2 className="h5">New customer</h2>
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <label className="form-label" htmlFor="ac-name">Name</label>
        <input id="ac-name" className="form-control form-control-lg mb-2" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} />
        <label className="form-label" htmlFor="ac-phone">Mobile number</label>
        <input id="ac-phone" className="form-control form-control-lg mb-2" inputMode="tel" placeholder="09xx xxx xxxx" value={phone} onChange={(e) => setPhone(e.target.value.slice(0, 16))} />
        {owner ? (
          <><label className="form-label" htmlFor="ac-limit">Credit limit (₱) — leave empty for no limit</label>
            <PesoInput id="ac-limit" className="form-control form-control-lg mb-2" value={limit} onChange={setLimit} placeholder="No limit" /></>
        ) : <p className="small text-muted">New customers start with no limit. The owner can set one later.</p>}
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>Back</button>
          <button type="button" className="btn btn-success btn-lg" disabled={busy || name.trim().length < 2 || phone.trim().length < 10} onClick={() => void save()}>Add</button>
        </div>
      </div>
    </div>
  );
}

function PayForm({ customer, locationId, onCancel, onDone }: { customer: Cust; locationId: string | null; onCancel: () => void; onDone: (balanceMinor: number, paidMinor: number) => void | Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "gcash">("cash");
  const [reference, setReference] = useState("");
  const [staffSig, setStaffSig] = useState<string | null>(null);
  const [custSig, setCustSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amt = toMinor(amount);
  const ready = amt > 0 && amt <= customer.balanceMinor && !!staffSig && (method === "cash" || reference.trim().length >= 4) && !busy;
  const save = async () => {
    setBusy(true); setError(null);
    const signatures = [{ signerKind: "STAFF", imagePng: staffSig }, ...(custSig ? [{ signerKind: "CUSTOMER", signerName: customer.name, imagePng: custSig }] : [])];
    const sent = await sendStep("/admin/utang/payments", { customerId: customer.id, amountMinor: amt, method, reference: method === "gcash" ? reference.trim() : undefined, locationId: locationId ?? undefined, signatures }, `Payment from ${customer.name}`);
    setBusy(false);
    if (sent.status === "queued") { await onDone(customer.balanceMinor - amt, amt); return; }
    const r = { ok: sent.ok, data: sent.data as ApiBody | null };
    if (!r.ok) { setError(errText(r.data, "Did not go through")); return; }
    const bal = Number(r.data?.balanceMinor ?? 0);
    toast(`Received ${peso(amt)} — ${peso(bal)} left${r.data?.smsStatus === "SKIPPED" ? " (no number, no text sent)" : ""}`);
    await onDone(bal, amt);
  };
  return (
    <div className="card border-success" style={{ maxWidth: 520 }}>
      <div className="card-body">
        <h2 className="h5">Credit payment — {customer.name}</h2>
        <div className="mb-2">Owes: <strong>{peso(customer.balanceMinor)}</strong></div>
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <div className="btn-group w-100 mb-2" role="group" aria-label="Method">
          <button type="button" className={`btn btn-lg ${method === "cash" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setMethod("cash")}>Cash</button>
          <button type="button" className={`btn btn-lg ${method === "gcash" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setMethod("gcash")}>GCash</button>
        </div>
        <NumPad value={amount} onChange={setAmount} decimals={2} label="Amount paid" unit="₱" />
        <button type="button" className="btn btn-link px-0" onClick={() => setAmount(String(customer.balanceMinor / 100))}>Pay all ({peso(customer.balanceMinor)})</button>
        {amt > customer.balanceMinor && <div className="text-danger">Too much — they only owe {peso(customer.balanceMinor)}.</div>}
        {amt > 0 && amt <= customer.balanceMinor && <div className="fs-5">Left after: <strong>{peso(customer.balanceMinor - amt)}</strong></div>}
        {method === "gcash" && (
          <><label className="form-label mt-2" htmlFor="pf-ref">GCash reference no.</label>
            <input id="pf-ref" className="form-control form-control-lg" inputMode="numeric" value={reference} onChange={(e) => setReference(e.target.value.replace(/\s/g, "").slice(0, 40))} /></>
        )}
        <div className="fw-semibold mt-3">Your signature (staff)</div>
        <SignaturePad onSignature={setStaffSig} />
        <div className="fw-semibold mt-2">Signature of {customer.name} (if here)</div>
        <SignaturePad onSignature={setCustSig} />
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>Back</button>
          <button type="button" className="btn btn-success btn-lg" disabled={!ready} onClick={() => void save()}>{busy ? "Please wait…" : "Receive"}</button>
        </div>
      </div>
    </div>
  );
}

/** Owner/manager: this customer's own prices (per piece, or per kilo for loose rice). They beat the store price at the counter. */
function SpecialPrices({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<{ id: string; productId: string; name: string; loose: boolean; priceMinor: number; listPriceMinor: number }[] | null>(null);
  const [products, setProducts] = useState<{ id: string; name: string; loose: boolean; costMinor: number }[]>([]);
  const [productId, setProductId] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`${API_URL}/admin/benta/customer-prices?customerId=${encodeURIComponent(customerId)}`, { headers: adminHeaders() });
    const d = await res.json().catch(() => null);
    setRows(res.ok ? (d?.prices ?? []) : []);
  }, [customerId]);
  useEffect(() => {
    setRows(null); void load();
    fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((ps) => {
      setProducts(((ps?.products ?? ps?.items ?? []) as { id: string; name: string; stockBaseUnit?: string | null; stockBaseQuantity?: number | null; costMinor?: number }[]).map((p) => ({ id: p.id, name: p.name, loose: (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1, costMinor: p.costMinor ?? 0 })));
    }).catch(() => undefined);
  }, [load]);
  const post = async (path: string, body: unknown) => {
    setBusy(true); setError(null);
    const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "That did not go through"); return false; }
    await load();
    return true;
  };
  const chosen = products.find((p) => p.id === productId);
  const costOf = (id: string) => products.find((p) => p.id === id)?.costMinor ?? 0;
  // A special price under the unit cost: fix it, change the cost, or keep it anyway.
  const saveSpecial = async () => {
    let priceMinor = Math.round(Number(price) * 100);
    if (chosen && isBelowCost(priceMinor, chosen.costMinor)) {
      const pick = await askBelowCost({ name: chosen.name, priceMinor, costMinor: chosen.costMinor, unit: chosen.loose ? "kilo" : "piece", showCost: true, canChangeCost: true, proceed: "Save anyway" });
      if (!pick) return;
      if (pick.kind === "price") priceMinor = pick.priceMinor;
      if (pick.kind === "cost") {
        const err = await saveUnitCost(chosen.id, pick.costMinor);
        if (err) { setError(err); return; }
        setProducts((ps) => ps.map((p) => (p.id === chosen.id ? { ...p, costMinor: pick.costMinor } : p)));
        toast("Unit cost saved");
      }
    }
    if (await post("/admin/benta/customer-prices", { customerId, productId, priceMinor })) { setProductId(""); setPrice(""); }
  };
  return (
    <div className="border rounded p-2 mt-3">
      <div className="fw-semibold mb-1">Special prices</div>
      {error && <div className="alert alert-danger py-1 small">{error}</div>}
      {rows === null ? <p className="text-muted small mb-1">Loading…</p> : rows.length === 0 ? <p className="text-muted small mb-1">None. This customer pays the store price.</p> : (
        <ul className="list-group mb-2">
          {rows.map((r) => (
            <li key={r.id} className="list-group-item d-flex align-items-center gap-2 py-1">
              <span className="me-auto">{r.name} <span className="text-muted small">store {peso(r.listPriceMinor)}{r.loose ? "/kg" : ""}</span></span>
              {isBelowCost(r.priceMinor, costOf(r.productId)) && <span className="badge text-bg-danger">Below cost {peso(costOf(r.productId))}{r.loose ? "/kg" : ""}</span>}
              <strong>{peso(r.priceMinor)}{r.loose ? "/kg" : ""}</strong>
              <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy} onClick={() => void post(`/admin/benta/customer-prices/${r.id}/remove`, {})}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row g-2 align-items-end">
        <div className="col-12 col-md-6">
          <select className="form-select" aria-label="Product" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose a product…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="col-6 col-md-3"><PesoInput id="sp-price" className="form-control" value={price} onChange={setPrice} placeholder={chosen?.loose ? "₱ per kilo" : "₱ each"} /></div>
        <div className="col-6 col-md-3"><button type="button" className="btn btn-success w-100" disabled={busy || !productId || !(Number(price) > 0)} onClick={() => void saveSpecial()}>Save price</button></div>
      </div>
    </div>
  );
}
