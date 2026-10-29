"use client";

// Rice Ops M6 — Credit: the customer list, Credit payment at this location, and the texts.
//   * Customers: name + mobile. New customers have NO credit limit; the owner/manager can set one (0 = no credit). At the limit, the customer pays first.
//   * Credit payment: cash or GCash, partial is fine; the money goes to this location's
//     drawer; a text goes out with what is left.
//   * Texts: each one shows Sent / Failed (with Send again) / No number.
//   * Settings (owner): texts on/off, monthly balance text, overdue reminder.
// Layout (same pattern as Orders): filter chips with counts, list rows ≥64px; sideways (WIDE) the list
// and the chosen customer sit side by side, upright the customer opens full screen with "← Back".
// The daily jobs (take a payment, text, print) are at the top of a customer; the owner's limit and
// special prices fold away under "Customer settings".

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
import { useMediaQuery, WIDE } from "../../lib/use-media-query";

interface Cust {
  id: string; name: string; phone: string | null; balanceMinor: number; creditApproved: boolean; limitMinor: number | null; unlimited: boolean; ownLimit: boolean; status: string; availableMinor: number | null;
  oldestUtangAt: string | null; lastText: { status: string; createdAt: string } | null;
}
interface Sms { id: string; template: string; text: string; status: "QUEUED" | "SENT" | "FAILED" | "SKIPPED" | "OPENED"; provider: string | null; lastError: string | null; createdAt: string; storeCustomer: { customer: { name: string | null } } | null }
interface Settings { utangSmsEnabled: boolean; utangMonthlyReminder: boolean; utangOverdueReminder: boolean; utangOverdueDays: number; smsSenderName: string | null }
interface Entry { id: string; type: string; amountMinor: number; startAt: string; dueAt: string | null; note: string | null }
interface Paid { paidMinor: number; balanceMinor: number; method: "cash" | "gcash"; reference: string; queued: boolean }
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
type Filter = "owing" | "overdue" | "limit" | "all";

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
const date = (iso: string) => new Date(iso).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
const NUM = { fontVariantNumeric: "tabular-nums" } as const;

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

/** One row of pill buttons (44px+), the selected one filled — the same chips as Orders. */
function Chips<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[]; label: string }) {
  return (
    <div className="d-flex flex-wrap gap-2 mb-3" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" aria-pressed={value === it.id} style={{ minHeight: 44 }}
          className={`btn rounded-pill px-3 ${value === it.id ? "btn-dark" : "btn-outline-dark"}`} onClick={() => onChange(it.id)}>{it.label}</button>
      ))}
    </div>
  );
}

export default function UtangRicePanel({ role }: { role?: string; onNavigate?: (tab: string) => void }) {
  const owner = !!role && (isOwnerRole(role) || role === "MANAGER");
  const wide = useMediaQuery(WIDE);
  const [tab, setTab] = useState<"list" | "texts" | "settings">("list");
  const [customers, setCustomers] = useState<Cust[] | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Cust | null>(null);
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [texts, setTexts] = useState<Sms[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("owing");
  const [storeName, setStoreName] = useState("");
  const [history, setHistory] = useState<Entry[] | null>(null);
  const [justPaid, setJustPaid] = useState<Paid | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  // Entries ticked for the statement; null = not choosing, the statement prints everything.
  const [pick, setPick] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
    const res = await fetch(`${API_URL}/admin/utang/customers${q}`, { headers: adminHeaders() });
    const d = await res.json().catch(() => null);
    if (!res.ok) { setError(errText(d, "Could not load")); return; }
    const list = d.customers as Cust[];
    setError(null);
    setCustomers(list);
    // Keep the open customer's numbers fresh (a payment, a new limit).
    setSelected((s) => (s ? list.find((c) => c.id === s.id) ?? s : s));
  }, [search]);
  const loadTexts = useCallback(async (customerId?: string) => {
    const res = await fetch(`${API_URL}/admin/sms${customerId ? `?customerId=${encodeURIComponent(customerId)}` : ""}`, { headers: adminHeaders() });
    if (res.ok) setTexts((await res.json()).messages as Sms[]);
  }, []);
  const loadHistory = useCallback(async (id: string) => {
    const d = await fetch(`${API_URL}/admin/credit/${encodeURIComponent(id)}`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    setHistory((d?.entries ?? []) as Entry[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((me) => setLocationId(me?.homeLocationId ?? null));
    void fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => setStoreName(d?.store?.name ?? "")).catch(() => {});
    void fetch(`${API_URL}/admin/utang/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setSettings(d.settings as Settings));
  }, []);
  useEffect(() => { if (tab === "texts") void loadTexts(); }, [tab, loadTexts]);
  useEffect(() => {
    setHistory(null); setJustPaid(null); setPaying(false); setShowAllHistory(false); setPick(null);
    if (!selected) return;
    void loadTexts(selected.id);
    void loadHistory(selected.id);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (c: Cust | null) => { setAdding(false); setSelected(c); };

  /** Slip or A4 statement. With entries ticked, only those print; each keeps its real balance after. */
  const printStatement = (c: Cust, a4: boolean) => {
    const entries = [...(history ?? [])].sort((x, y) => new Date(x.startAt).getTime() - new Date(y.startAt).getTime());
    let run = 0;
    const over = overdueDays(entries);
    const rows = entries.map((e) => {
      run += e.amountMinor;
      return {
        id: e.id,
        name: `${new Date(e.startAt).toLocaleDateString("en-PH")} ${e.type === "payment" ? "Payment" : "Utang"}${e.dueAt && e.type === "purchase" ? ` (due ${new Date(e.dueAt).toLocaleDateString("en-PH")})` : ""}${e.note ? ` ${e.note}` : ""}`,
        qty: `${e.type === "payment" ? "-" : ""}${peso(Math.abs(e.amountMinor))}  bal ${peso(run)}`,
      };
    });
    const chosen = pick ? rows.filter((r) => pick.has(r.id)) : rows;
    printSlip({
      storeName: storeName || "SAM STORE", title: "CREDIT STATEMENT", reference: c.name, when: new Date().toLocaleDateString("en-PH"), a4,
      lines: [...(c.phone ? [{ label: "Phone", value: c.phone }] : []), { label: "Limit", value: limitPhrase(c, peso) },
        ...(pick ? [{ label: "Entries", value: `${chosen.length} of ${rows.length}` }] : [])],
      rows: chosen.map(({ name, qty }) => ({ name, qty })),
      totals: [{ label: "Balance", value: peso(c.balanceMinor) }, { label: "Days overdue", value: over > 0 ? String(over) : "none" }],
      signatures: [{ role: "Received by", name: "" }],
    });
  };
  /** The customer's copy of a credit payment: what was paid and what is left. */
  const printPayment = (c: Cust, p: Paid) => printSlip({
    storeName: storeName || "SAM STORE", title: "CREDIT PAYMENT", reference: c.name, when: new Date().toLocaleString("en-PH"),
    lines: [{ label: "Paid by", value: p.method === "gcash" ? `GCash ${p.reference}` : "Cash" }],
    totals: [{ label: "Paid", value: peso(p.paidMinor) }, { label: "Balance left", value: peso(p.balanceMinor) }],
    signatures: [{ role: "Received by", name: "" }],
  });
  /** Open the phone's text app with the customer's balance (or a payment receipt) ready. */
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

  const all = customers ?? [];
  const overAfter = settings?.utangOverdueDays ?? 30;
  const owing = all.filter((c) => c.balanceMinor > 0);
  const overdue = owing.filter((c) => days(c.oldestUtangAt) > overAfter).sort((a, b) => days(b.oldestUtangAt) - days(a.oldestUtangAt));
  const atLimit = owing.filter((c) => c.status === "AT_LIMIT" || c.status === "NEAR_LIMIT");
  const shown = filter === "owing" ? owing : filter === "overdue" ? overdue : filter === "limit" ? atLimit : all;
  const totalOwed = owing.reduce((s, c) => s + c.balanceMinor, 0);
  const emptyWords: Record<Filter, string> = {
    owing: "Nobody owes right now.", overdue: `Nobody has owed for more than ${overAfter} days.`, limit: "Nobody is near or at their limit.", all: "No customers yet.",
  };

  const list = (
    <>
      <div className="d-flex gap-2 mb-3">
        <input type="search" className="form-control form-control-lg" placeholder="Search name or number" aria-label="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn btn-success btn-lg text-nowrap" onClick={() => { setSelected(null); setAdding(true); }}><i className="bi bi-person-plus me-1" aria-hidden="true"></i>New</button>
      </div>
      <Chips label="Who to show" value={filter} onChange={setFilter} items={[
        { id: "owing", label: `Owes (${owing.length})` },
        { id: "overdue", label: `Over ${overAfter} days (${overdue.length})` },
        { id: "limit", label: `Near limit (${atLimit.length})` },
        { id: "all", label: `All (${all.length})` },
      ]} />
      {customers === null ? <p className="text-muted">Loading…</p> : shown.length === 0 ? (
        <div className="text-center text-muted border rounded-3 py-4 px-3">
          <i className="bi bi-emoji-smile fs-2 d-block mb-1" aria-hidden="true"></i>{search.trim() ? `No customer matches “${search.trim()}”.` : emptyWords[filter]}
        </div>
      ) : (
        <div className="list-group">
          {shown.map((c) => {
            const d = days(c.oldestUtangAt);
            const late = c.balanceMinor > 0 && d > overAfter;
            const st = creditStatusWords(c.status);
            const isOpen = selected?.id === c.id;
            return (
              <button key={c.id} type="button" aria-current={isOpen || undefined} onClick={() => open(c)}
                className={`list-group-item list-group-item-action d-flex align-items-center gap-3 py-2 ${isOpen ? "bg-light" : ""}`}
                style={{ minHeight: 64, borderLeft: isOpen ? "6px solid #1f1d1a" : undefined }}>
                <span className="flex-grow-1" style={{ minWidth: 0 }}>
                  <span className="fw-semibold d-block text-break">{c.name}</span>
                  <span className="small text-muted d-block">
                    {c.phone ?? "No number"}{c.balanceMinor > 0 && c.oldestUtangAt ? ` · owing ${d} day${d === 1 ? "" : "s"}` : ""}
                  </span>
                </span>
                <span className="text-end flex-shrink-0" style={NUM}>
                  <span className={`fs-5 fw-semibold d-block ${c.balanceMinor > 0 ? "" : "text-muted"}`}>{peso(c.balanceMinor)}</span>
                  <span className="d-inline-flex flex-wrap justify-content-end gap-1">
                    {late && <span className="badge text-bg-warning">Over {overAfter} days</span>}
                    {(c.status === "AT_LIMIT" || c.status === "NEAR_LIMIT" || !c.creditApproved) && <span className={`badge ${st.cls}`}>{st.label}</span>}
                    {c.lastText?.status === "FAILED" && <span className="badge text-bg-danger">Text failed</span>}
                  </span>
                </span>
                <i className="bi bi-chevron-right text-muted" aria-hidden="true"></i>
              </button>
            );
          })}
        </div>
      )}
    </>
  );

  const detail = (c: Cust) => {
    const st = creditStatusWords(c.status);
    const sorted = [...(history ?? [])].sort((x, y) => new Date(x.startAt).getTime() - new Date(y.startAt).getTime());
    let run = 0;
    const rows = sorted.map((e) => ({ ...e, after: (run += e.amountMinor) })).reverse();
    const failedTexts = texts.filter((t) => t.status === "FAILED").length;
    const printBtn = (cust: Cust, a4: boolean, full = false) => (
      <button type="button" className={`btn btn-outline-dark ${full ? "w-100" : ""}`} disabled={!history || pick?.size === 0} onClick={() => printStatement(cust, a4)}>
        <i className={`bi ${a4 ? "bi-file-earmark-text" : "bi-printer"} me-1`} aria-hidden="true"></i>{a4 ? "Statement (A4)" : "Print statement"}{pick ? ` (${pick.size})` : ""}
      </button>
    );
    return (
      <div>
        {justPaid && (
          <div className="alert alert-success d-flex flex-wrap align-items-center gap-2 mb-3" role="status">
            <i className="bi bi-check-circle-fill fs-3" aria-hidden="true"></i>
            <div className="flex-grow-1">
              <div className="fw-semibold fs-5">Received {peso(justPaid.paidMinor)}</div>
              <div style={NUM}>{peso(justPaid.balanceMinor)} left{justPaid.queued ? " · saved on the tablet, uploads when online" : ""}</div>
            </div>
            <div className="d-flex flex-wrap gap-2">
              <button type="button" className="btn btn-outline-dark" onClick={() => printPayment(c, justPaid)}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print receipt</button>
              <button type="button" className="btn btn-outline-dark" disabled={!c.phone} onClick={() => textCustomer(c, "payment_received", { paidMinor: justPaid.paidMinor, balanceMinor: justPaid.balanceMinor })}><i className="bi bi-chat-dots me-1" aria-hidden="true"></i>Text receipt</button>
            </div>
          </div>
        )}
        <div className="card mb-3">
          <div className="card-body">
            <div className="d-flex flex-wrap justify-content-between gap-2">
              <div style={{ minWidth: 0 }}>
                <h2 className="h4 mb-1 text-break">{c.name}</h2>
                <div className="text-muted">{c.phone ? <a href={`tel:${c.phone}`} className="link-dark"><i className="bi bi-telephone me-1" aria-hidden="true"></i>{c.phone}</a> : "No mobile number"}</div>
              </div>
              <div className="text-end" style={NUM}>
                <div className="small text-muted">Owes</div>
                <div className={`fw-bold ${c.status === "AT_LIMIT" ? "text-danger" : ""}`} style={{ fontSize: 34, lineHeight: 1.1 }}>{peso(c.balanceMinor)}</div>
              </div>
            </div>
            <div className="d-flex flex-wrap align-items-center gap-2 mt-2" style={NUM}>
              <span className={`badge ${st.cls}`}>{st.label}</span>
              {limitPhrase(c, peso) !== st.label && <span>Limit {limitPhrase(c, peso)}</span>}
              {c.creditApproved && c.availableMinor !== null && <span className="text-muted">· can still borrow {peso(c.availableMinor)}</span>}
              {c.balanceMinor > 0 && c.oldestUtangAt && <span className="text-muted">· owing {days(c.oldestUtangAt)} days</span>}
            </div>
            {!c.creditApproved && <div className="small text-muted mt-1">Cannot buy on credit yet{owner ? " — set a limit under Customer settings." : " — ask the owner to set a limit."}</div>}
            {c.status === "AT_LIMIT" && <div className="alert alert-warning py-2 mt-2 mb-0">At the limit. The customer must pay some of the balance first, then can buy on credit again.</div>}

            <div className="row g-2 mt-2">
              <div className="col-12 col-md-6">
                <button type="button" className="btn btn-success btn-lg w-100 h-100" style={{ minHeight: 64 }} disabled={c.balanceMinor <= 0} onClick={() => setPaying(true)}>
                  <i className="bi bi-cash-coin me-2" aria-hidden="true"></i>{c.balanceMinor > 0 ? "Receive payment" : "Nothing to pay"}
                </button>
              </div>
              <div className="col-12 col-md-6">
                <button type="button" className="btn btn-outline-dark btn-lg w-100 h-100" style={{ minHeight: 64 }} disabled={!c.phone} onClick={() => textCustomer(c, "balance", { balanceMinor: c.balanceMinor })}>
                  <i className="bi bi-chat-dots me-2" aria-hidden="true"></i>Text the balance
                </button>
              </div>
              <div className="col-6">{printBtn(c, false, true)}</div>
              <div className="col-6">{printBtn(c, true, true)}</div>
            </div>
          </div>
        </div>

        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
          <h3 className="h6 text-uppercase text-muted mb-0">History</h3>
          {rows.length > 0 && (pick ? (
            <div className="d-flex flex-wrap gap-2">
              <button type="button" className="btn btn-outline-dark btn-sm" onClick={() => setPick(new Set(rows.map((e) => e.id)))}>All</button>
              <button type="button" className="btn btn-outline-dark btn-sm" onClick={() => setPick(new Set())}>None</button>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setPick(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn btn-outline-dark btn-sm" onClick={() => { setPick(new Set(rows.map((e) => e.id))); setShowAllHistory(true); }}>
              <i className="bi bi-check2-square me-1" aria-hidden="true"></i>Choose what to print
            </button>
          ))}
        </div>
        {pick && rows.length > 0 && (
          <div className="alert alert-info py-2">
            <div className="mb-2">Tick the entries for the statement · <strong>{pick.size} of {rows.length}</strong></div>
            <div className="d-flex flex-wrap gap-2">{printBtn(c, false)}{printBtn(c, true)}</div>
          </div>
        )}
        {history === null ? <p className="text-muted">Loading…</p> : rows.length === 0 ? <p className="text-muted">No credit entries yet.</p> : (
          <>
            <ul className="list-group mb-2" style={NUM}>
              {(showAllHistory ? rows : rows.slice(0, 10)).map((e) => (
                <li key={e.id} className="list-group-item d-flex align-items-center gap-3 py-2" style={{ minHeight: 56, cursor: pick ? "pointer" : undefined }}
                  onClick={pick ? () => setPick((p) => { const n = new Set(p); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; }) : undefined}>
                  {pick ? <input type="checkbox" className="form-check-input m-0 flex-shrink-0" style={{ width: 28, height: 28 }} checked={pick.has(e.id)} readOnly aria-label={`Print ${e.type === "payment" ? "payment" : "utang"} of ${date(e.startAt)}`} />
                    : <i className={`bi ${e.type === "payment" ? "bi-arrow-down-circle text-success" : "bi-bag"} fs-5`} aria-hidden="true"></i>}
                  <span className="flex-grow-1" style={{ minWidth: 0 }}>
                    <span className="d-block">{e.type === "purchase" ? "Utang" : e.type === "payment" ? "Payment" : e.type}{e.note ? <span className="text-muted"> · {e.note}</span> : null}</span>
                    <span className="small text-muted">{date(e.startAt)}{e.dueAt && e.type === "purchase" ? ` · due ${date(e.dueAt)}` : ""}</span>
                  </span>
                  <span className="text-end">
                    <span className={`d-block fw-semibold ${e.type === "payment" ? "text-success" : ""}`}>{e.type === "payment" ? "−" : "+"}{peso(Math.abs(e.amountMinor))}</span>
                    <span className="small text-muted">bal {peso(e.after)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {rows.length > 10 && !showAllHistory && <button type="button" className="btn btn-link px-0 mb-2" onClick={() => setShowAllHistory(true)}>Show all {rows.length}</button>}
          </>
        )}

        <details className="border rounded-3 mb-3 bg-white">
          <summary className="p-3 fw-semibold" style={{ minHeight: 44 }}>Texts ({texts.length}){failedTexts > 0 && <span className="badge text-bg-danger ms-2">{failedTexts} failed</span>}</summary>
          <div className="px-3 pb-3"><TextList texts={texts} onResend={resend} /></div>
        </details>

        {owner && (
          <details className="border rounded-3 mb-3 bg-white">
            <summary className="p-3 fw-semibold" style={{ minHeight: 44 }}>Customer settings <span className="fw-normal text-muted">· limit and special prices</span></summary>
            <div className="px-3 pb-3">
              <div className="fw-semibold mb-1">Credit limit <span className="fw-normal text-muted">(now: {limitPhrase(c, peso)})</span></div>
              <LimitEditor customer={c} onSaved={load} />
              <SpecialPrices customerId={c.id} />
            </div>
          </details>
        )}
      </div>
    );
  };

  const back = <button type="button" className="btn btn-link px-0 mb-2 fs-5" onClick={() => open(null)}>← Customers</button>;
  const pay = selected && (
    <PayForm customer={selected} locationId={locationId} wide={wide} onCancel={() => setPaying(false)}
      onDone={async (p) => { setPaying(false); setSelected({ ...selected, balanceMinor: p.balanceMinor }); setJustPaid(p); await load(); void loadTexts(selected.id); void loadHistory(selected.id); }} />
  );
  const add = <AddCustomer owner={owner} onCancel={() => setAdding(false)} onDone={async () => { setAdding(false); await load(); }} />;

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-baseline justify-content-between gap-2 mb-2">
        <h1 className="h4 mb-0">Credit</h1>
        <span style={NUM}><span className="fs-4 fw-bold">{peso(totalOwed)}</span> <span className="text-muted">owed by {owing.length} customer{owing.length === 1 ? "" : "s"}</span></span>
      </div>
      <ul className="nav nav-tabs mb-3">
        <li className="nav-item"><button className={`nav-link ${tab === "list" ? "active" : ""}`} onClick={() => { setTab("list"); open(null); }}>Customers</button></li>
        <li className="nav-item"><button className={`nav-link ${tab === "texts" ? "active" : ""}`} onClick={() => { setTab("texts"); open(null); }}>Texts</button></li>
        {owner && <li className="nav-item"><button className={`nav-link ${tab === "settings" ? "active" : ""}`} onClick={() => { setTab("settings"); open(null); }}>Settings</button></li>}
      </ul>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {tab === "list" && (paying && selected ? pay : wide ? (
        <div className="row g-3">
          <div className="col-lg-5">{list}</div>
          <div className="col-lg-7 pos-side">
            {adding ? add : selected ? detail(selected) : (
              <div className="text-center text-muted border rounded-3 py-5 px-4 bg-white">
                <i className="bi bi-person-lines-fill d-block mb-2" style={{ fontSize: 40 }} aria-hidden="true"></i>
                Tap a customer to take a payment, text the balance or print a statement.
              </div>
            )}
          </div>
        </div>
      ) : adding ? add : selected ? <>{back}{detail(selected)}</> : list)}

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

/** Receive a credit payment: amount (big pad + quick amounts), cash or GCash, signatures, then one Receive button that says the amount. */
function PayForm({ customer, locationId, wide, onCancel, onDone }: { customer: Cust; locationId: string | null; wide: boolean; onCancel: () => void; onDone: (p: Paid) => void | Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "gcash">("cash");
  const [reference, setReference] = useState("");
  const [staffSig, setStaffSig] = useState<string | null>(null);
  const [custSig, setCustSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owed = customer.balanceMinor;
  const amt = toMinor(amount);
  // What still stops the Receive button, in words (the button never just sits grey).
  const missing = amt <= 0 ? "Enter the amount paid" : amt > owed ? `Too much — they only owe ${peso(owed)}` : method === "gcash" && reference.trim().length < 4 ? "Enter the GCash reference no." : !staffSig ? "Staff signature needed" : null;
  const ready = !missing && !busy;
  const quick = [10000, 20000, 50000, 100000].filter((m) => m < owed);
  const save = async () => {
    setBusy(true); setError(null);
    const signatures = [{ signerKind: "STAFF", imagePng: staffSig }, ...(custSig ? [{ signerKind: "CUSTOMER", signerName: customer.name, imagePng: custSig }] : [])];
    const ref = method === "gcash" ? reference.trim() : "";
    const sent = await sendStep("/admin/utang/payments", { customerId: customer.id, amountMinor: amt, method, reference: ref || undefined, locationId: locationId ?? undefined, signatures }, `Payment from ${customer.name}`);
    setBusy(false);
    if (sent.status === "queued") { await onDone({ paidMinor: amt, balanceMinor: owed - amt, method, reference: ref, queued: true }); return; }
    const data = sent.data as ApiBody | null;
    if (!sent.ok) { setError(errText(data, "Did not go through")); return; }
    const bal = Number(data?.balanceMinor ?? 0);
    if (data?.smsStatus === "SKIPPED") toast("No mobile number, so no text was sent");
    await onDone({ paidMinor: amt, balanceMinor: bal, method, reference: ref, queued: false });
  };
  const step = (n: number, title: string) => <div className="d-flex align-items-center gap-2 fw-semibold mb-2"><span className="badge rounded-pill text-bg-dark" style={{ fontSize: 14 }}>{n}</span>{title}</div>;
  return (
    <div className="card border-success">
      <div className="card-body pb-0">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
          <div>
            <button type="button" className="btn btn-link px-0 fs-5" disabled={busy} onClick={onCancel}>← {customer.name}</button>
            <h2 className="h4 mb-0">Receive payment</h2>
          </div>
          <div className="text-end" style={NUM}><div className="small text-muted">Owes now</div><div className="fs-3 fw-bold">{peso(owed)}</div></div>
        </div>
        {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
        <div className="row g-4">
          <div className={wide ? "col-lg-6" : "col-12"}>
            {step(1, "How much did they pay?")}
            <div className="d-flex flex-wrap gap-2 mb-2">
              <button type="button" className={`btn rounded-pill px-3 ${amt === owed ? "btn-dark" : "btn-outline-dark"}`} style={{ minHeight: 44 }} onClick={() => setAmount(String(owed / 100))}>All {peso(owed)}</button>
              {quick.map((m) => <button key={m} type="button" className={`btn rounded-pill px-3 ${amt === m ? "btn-dark" : "btn-outline-dark"}`} style={{ minHeight: 44 }} onClick={() => setAmount(String(m / 100))}>{peso(m).replace(".00", "")}</button>)}
            </div>
            <NumPad value={amount} onChange={setAmount} decimals={2} label="Amount paid" unit="₱" />
          </div>
          <div className={wide ? "col-lg-6" : "col-12"}>
            {step(2, "Paid by")}
            <div className="btn-group w-100 mb-2" role="group" aria-label="Paid by">
              <button type="button" aria-pressed={method === "cash"} className={`btn btn-lg ${method === "cash" ? "btn-dark" : "btn-outline-dark"}`} style={{ minHeight: 56 }} onClick={() => setMethod("cash")}><i className="bi bi-cash me-1" aria-hidden="true"></i>Cash</button>
              <button type="button" aria-pressed={method === "gcash"} className={`btn btn-lg ${method === "gcash" ? "btn-dark" : "btn-outline-dark"}`} style={{ minHeight: 56 }} onClick={() => setMethod("gcash")}><i className="bi bi-phone me-1" aria-hidden="true"></i>GCash</button>
            </div>
            {method === "gcash" && (
              <div className="mb-2"><label className="form-label mb-1" htmlFor="pf-ref">GCash reference no.</label>
                <input id="pf-ref" className="form-control form-control-lg" inputMode="numeric" value={reference} onChange={(e) => setReference(e.target.value.replace(/\s/g, "").slice(0, 40))} /></div>
            )}
            <div className="mt-3">{step(3, "Signatures")}</div>
            <div className="mb-1">Staff (you) <span className="text-danger">*</span></div>
            {/* Kept narrow so both pads and the Receive bar fit a sideways tablet without much scrolling. */}
            <div style={{ maxWidth: 440 }}><SignaturePad onSignature={setStaffSig} /></div>
            <div className="mt-2 mb-1">{customer.name} <span className="text-muted">(if here)</span></div>
            <div style={{ maxWidth: 440 }}><SignaturePad onSignature={setCustSig} /></div>
          </div>
        </div>
      </div>
      <div className="position-sticky bottom-0 sticky-above-bar bg-white border-top border-success rounded-bottom p-3 mt-3 d-flex flex-wrap align-items-center gap-2" style={{ zIndex: 5 }}>
        <div className="flex-grow-1" style={NUM} aria-live="polite">
          {amt > 0 && amt <= owed ? <><div className="fw-semibold">Paid {peso(amt)} · {method === "gcash" ? "GCash" : "Cash"}</div><div className="text-muted">{peso(owed - amt)} left after</div></> : null}
          {missing && <div className={amt > owed ? "text-danger fw-semibold" : "text-muted"}>{missing}</div>}
        </div>
        <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>Back</button>
        <button type="button" className="btn btn-success btn-lg px-4" style={{ minHeight: 56 }} disabled={!ready} onClick={() => void save()}>{busy ? "Please wait…" : amt > 0 ? `Receive ${peso(amt)}` : "Receive"}</button>
      </div>
    </div>
  );
}

/** Owner/manager: this customer's own prices (per piece, or per kilo for loose rice). They beat the store price at the counter. */
function SpecialPrices({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<{ id: string; productId: string; name: string; loose: boolean; priceMinor: number; listPriceMinor: number }[] | null>(null);
  const [products, setProducts] = useState<{ id: string; name: string; loose: boolean }[]>([]);
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
      setProducts(((ps?.products ?? ps?.items ?? []) as { id: string; name: string; stockBaseUnit?: string | null; stockBaseQuantity?: number | null }[]).map((p) => ({ id: p.id, name: p.name, loose: (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1 })));
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
  return (
    <div className="border rounded p-2 mt-3">
      <div className="fw-semibold mb-1">Special prices</div>
      {error && <div className="alert alert-danger py-1 small">{error}</div>}
      {rows === null ? <p className="text-muted small mb-1">Loading…</p> : rows.length === 0 ? <p className="text-muted small mb-1">None. This customer pays the store price.</p> : (
        <ul className="list-group mb-2">
          {rows.map((r) => (
            <li key={r.id} className="list-group-item d-flex align-items-center gap-2 py-1">
              <span className="me-auto">{r.name} <span className="text-muted small">store {peso(r.listPriceMinor)}{r.loose ? "/kg" : ""}</span></span>
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
        <div className="col-6 col-md-3"><button type="button" className="btn btn-success w-100" disabled={busy || !productId || !(Number(price) > 0)} onClick={async () => { if (await post("/admin/benta/customer-prices", { customerId, productId, priceMinor: Math.round(Number(price) * 100) })) { setProductId(""); setPrice(""); } }}>Save price</button></div>
      </div>
    </div>
  );
}
