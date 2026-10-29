"use client";

// Store settings (owner / manager).
// Layout (same pattern as Orders and Credit): a list of settings groups, each row saying what is set now.
// Sideways (WIDE) the list and the chosen group sit side by side; upright the group opens full screen
// with "← Settings". Groups are ordered by how often a rice store needs them: Printer first, the online
// shop and Messenger near the end. Each group has one Save bar that sticks to the bottom and says
// whether there is anything left to save. Offline: Printer still works (it is saved on this tablet);
// the other groups open from the saved copy but their buttons are off until the tablet is online.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminStoreId, getAuthItem, setAuthItem } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { askConfirm } from "../../lib/ask";
import { cachedGet, useOffline } from "../../lib/offlineCache";
import { getPrinterSettings } from "../../lib/printer-settings";
import { peso } from "../../lib/number-format";
import { useMediaQuery, WIDE } from "../../lib/use-media-query";
import { PesoInput, WholeInput } from "../NumberBoxes";
import DeliveryZonesCard from "./DeliveryZonesCard";
import NoStoreScope from "./NoStoreScope";
import PrinterSettingsCard from "./PrinterSettingsCard";

interface StoreSettings {
  id: string;
  name: string;
  slug: string;
  currencyCode: string;
  timezone: string;
  status: string;
  publicLink: { slug: string; token: string; status: string } | null;
  settings: {
    allowGuestOrders: boolean;
    orderingPaused: boolean;
    closedStoreMessage: string | null;
    minOrderAmountMinor: number;
    deliveryFeeMinor: number;
    deliveryEnabled: boolean;
    pickupEnabled: boolean;
    orderCutoff: string | null;
    maxOpenOrdersPerCustomer: number;
    creditLimitMinor: number;
    creditTermDays: number;
    requireOpenShift?: boolean;
    receiptHeader: string | null;
    receiptFooter: string | null;
    showVatLabel: boolean;
    vatEnabled: boolean;
    vatRateBp: number;
    pricesIncludeVat: boolean;
    vatShowOnReceipt: boolean;
    tin: string | null;
    dailySalesTargetMinor: number;
    hidePricePreOrder: boolean;
    seniorPwdDiscountEnabled: boolean;
    messengerConnected: boolean;
    messengerPageId: string | null;
    loyaltyPointsPerPeso: number;
    loyaltyWelcomeBonusPoints: number;
    loyaltyExpiryMonths: number;
    orderNumberPrefix: string | null;
    privacyRetentionDays: number;
  };
}

/** Everything on the screen that is saved to the server, as the boxes hold it. */
interface Form {
  dailyTarget: string; hidePrePrice: boolean; requireOpenShift: boolean;
  creditLimit: string; creditTermDays: string;
  vatEnabled: boolean; vatRate: string; pricesIncludeVat: boolean; vatShowOnReceipt: boolean; showVat: boolean; tin: string; seniorPwd: boolean;
  receiptHeader: string; receiptFooter: string;
  allowGuest: boolean; paused: boolean; deliveryEnabled: boolean; pickupEnabled: boolean;
  deliveryFee: string; minOrder: string; orderCutoff: string; maxOpenOrders: string; closedMessage: string; orderPrefix: string;
  messengerConnected: boolean; messengerPageId: string; loyaltyRate: string; loyaltyWelcome: string; loyaltyExpiry: string; privacyDays: string;
}

const pesos = (minor: number | undefined) => (minor ?? 0) > 0 ? String((minor ?? 0) / 100) : "";
const toMinor = (s: string) => Math.round(Number(s.replace(/,/g, "") || "0") * 100);
const toInt = (s: string, fallback: number) => { const n = parseInt(s.replace(/,/g, ""), 10); return Number.isFinite(n) ? n : fallback; };

function formFrom(s: StoreSettings["settings"]): Form {
  return {
    dailyTarget: pesos(s.dailySalesTargetMinor), hidePrePrice: s.hidePricePreOrder ?? false, requireOpenShift: s.requireOpenShift === true,
    creditLimit: pesos(s.creditLimitMinor), creditTermDays: String(s.creditTermDays ?? 30),
    vatEnabled: s.vatEnabled ?? true, vatRate: String((s.vatRateBp ?? 1200) / 100), pricesIncludeVat: s.pricesIncludeVat ?? true,
    vatShowOnReceipt: s.vatShowOnReceipt ?? true, showVat: s.showVatLabel ?? true, tin: s.tin ?? "", seniorPwd: s.seniorPwdDiscountEnabled ?? false,
    receiptHeader: s.receiptHeader ?? "", receiptFooter: s.receiptFooter ?? "",
    allowGuest: s.allowGuestOrders, paused: s.orderingPaused, deliveryEnabled: s.deliveryEnabled, pickupEnabled: s.pickupEnabled,
    deliveryFee: pesos(s.deliveryFeeMinor), minOrder: pesos(s.minOrderAmountMinor), orderCutoff: s.orderCutoff ?? "",
    maxOpenOrders: String(s.maxOpenOrdersPerCustomer ?? 10), closedMessage: s.closedStoreMessage ?? "", orderPrefix: s.orderNumberPrefix ?? "",
    messengerConnected: s.messengerConnected ?? false, messengerPageId: s.messengerPageId ?? "",
    loyaltyRate: String(s.loyaltyPointsPerPeso ?? 1), loyaltyWelcome: String(s.loyaltyWelcomeBonusPoints ?? 0),
    loyaltyExpiry: String(s.loyaltyExpiryMonths ?? 0), privacyDays: String(s.privacyRetentionDays ?? 0),
  };
}

type ServerGroup = "counter" | "credit" | "receipt" | "shop" | "messenger";
type Group = "printer" | ServerGroup | "account";

/** What each group sends when saved. Also used to tell whether a group has unsaved changes. */
const PAYLOAD: Record<ServerGroup, (f: Form) => Record<string, unknown>> = {
  counter: (f) => ({ dailySalesTargetMinor: toMinor(f.dailyTarget), hidePricePreOrder: f.hidePrePrice, requireOpenShift: f.requireOpenShift }),
  credit: (f) => ({ creditLimitMinor: toMinor(f.creditLimit), creditTermDays: toInt(f.creditTermDays, 30) }),
  receipt: (f) => ({
    vatEnabled: f.vatEnabled, vatRateBp: Math.round(Number(f.vatRate || "0") * 100), pricesIncludeVat: f.pricesIncludeVat,
    vatShowOnReceipt: f.vatShowOnReceipt, showVatLabel: f.showVat, tin: f.tin.trim() || null, seniorPwdDiscountEnabled: f.seniorPwd,
    receiptHeader: f.receiptHeader.trim() || null, receiptFooter: f.receiptFooter.trim() || null,
  }),
  shop: (f) => ({
    allowGuestOrders: f.allowGuest, orderingPaused: f.paused, deliveryEnabled: f.deliveryEnabled, pickupEnabled: f.pickupEnabled,
    deliveryFeeMinor: toMinor(f.deliveryFee), minOrderAmountMinor: toMinor(f.minOrder), orderCutoff: f.orderCutoff || null,
    maxOpenOrdersPerCustomer: toInt(f.maxOpenOrders, 10), closedStoreMessage: f.closedMessage.trim() || null,
    orderNumberPrefix: f.orderPrefix.trim().toUpperCase() || null,
  }),
  messenger: (f) => ({
    messengerConnected: f.messengerConnected, messengerPageId: f.messengerPageId.trim() || null,
    loyaltyPointsPerPeso: toInt(f.loyaltyRate, 1), loyaltyWelcomeBonusPoints: toInt(f.loyaltyWelcome, 0),
    loyaltyExpiryMonths: toInt(f.loyaltyExpiry, 0), privacyRetentionDays: toInt(f.privacyDays, 0),
  }),
};

/** Problems that stop a group from saving, shown under the box they belong to. */
function problems(g: ServerGroup, f: Form): Partial<Record<keyof Form, string>> {
  const p: Partial<Record<keyof Form, string>> = {};
  if (g === "credit" && toInt(f.creditTermDays, 0) < 1) p.creditTermDays = "At least 1 day.";
  if (g === "receipt") { const r = Number(f.vatRate || "0"); if (!(r >= 0 && r <= 100)) p.vatRate = "Between 0 and 100."; }
  if (g === "shop" && toInt(f.maxOpenOrders, 0) < 1) p.maxOpenOrders = "At least 1.";
  if (g === "messenger") {
    const r = toInt(f.loyaltyRate, 0);
    if (r < 1 || r > 100) p.loyaltyRate = "From 1 to 100.";
    if (toInt(f.privacyDays, 0) > 3650) p.privacyDays = "At most 3650 days (10 years).";
  }
  return p;
}

const GROUPS: { id: Group; icon: string; title: string; server: boolean }[] = [
  { id: "printer", icon: "bi-printer", title: "Printer and receipt text", server: false },
  { id: "counter", icon: "bi-shop", title: "Selling at the counter", server: true },
  { id: "credit", icon: "bi-journal-text", title: "Credit (utang)", server: true },
  { id: "receipt", icon: "bi-percent", title: "VAT and tax", server: true },
  { id: "shop", icon: "bi-globe", title: "Online shop", server: true },
  { id: "messenger", icon: "bi-chat-dots", title: "Messenger, points and privacy", server: true },
  { id: "account", icon: "bi-person", title: "My account", server: true },
];

/** One setting that is on or off: words on the left, a big switch on the right, the whole row taps. */
function SwitchRow({ id, label, help, checked, onChange }: { id: string; label: ReactNode; help?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="settings-switch form-check form-switch">
      <label className="form-check-label" htmlFor={id}>
        <span className="d-block fw-semibold">{label}</span>
        {help && <span className="d-block small text-muted">{help}</span>}
      </label>
      <input className="form-check-input" type="checkbox" role="switch" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

/** A labelled box with its help and its problem underneath. */
function Field({ id, label, help, problem, children }: { id: string; label: string; help?: ReactNode; problem?: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <label className="form-label fw-semibold mb-1" htmlFor={id}>{label}</label>
      {children}
      {problem ? <div className="text-danger small mt-1" id={`${id}-problem`}>{problem}</div> : help ? <div className="small text-muted mt-1">{help}</div> : null}
    </div>
  );
}

export default function SettingsPanel() {
  const storeId = getAdminStoreId();
  const wide = useMediaQuery(WIDE);
  const offline = useOffline();
  const [data, setData] = useState<StoreSettings | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Messenger page connection (its own buttons, not part of the Save bar).
  const [mpForm, setMpForm] = useState({ pageId: "", pageName: "", accessToken: "" });
  const [mpDeepLink, setMpDeepLink] = useState("");
  const [mpErr, setMpErr] = useState<string | null>(null);
  const [printerTick, setPrinterTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    // The saved copy on this tablet opens the screen offline too (Printer works without internet).
    const d = await cachedGet<StoreSettings>("/admin/settings");
    if (d?.settings) {
      const f = formFrom(d.settings);
      setData(d); setSaved(f); setForm(f); setError(null);
    } else setError("Could not load the settings. Check the internet and try again.");
    setLoading(false);
  }, []);

  useEffect(() => { if (storeId) void load(); }, [load, storeId]);

  if (!storeId) return <NoStoreScope />;
  if (loading && !form) return <p className="text-muted">Loading…</p>;

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const dirty = (g: Group) => !!form && !!saved && g in PAYLOAD && JSON.stringify(PAYLOAD[g as ServerGroup](form)) !== JSON.stringify(PAYLOAD[g as ServerGroup](saved));
  const openGroup = async (g: Group | null) => {
    if (group && g !== group && dirty(group) && !(await askConfirm("You have changes that are not saved. Leave without saving?", { ok: "Leave", cancel: "Stay", danger: true }))) return;
    if (group && dirty(group) && saved) setForm(saved);
    setGroup(g);
    if (!wide && typeof window !== "undefined") window.scrollTo({ top: 0 });
  };
  // Sideways there is always a group open on the right; Printer first.
  const shown: Group | null = group ?? (wide ? "printer" : null);

  const saveGroup = async (g: ServerGroup) => {
    if (!form) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(PAYLOAD[g](form)),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.message ?? body?.errors?.join(", ") ?? "Did not save. Try again."); return; }
      toast("Saved", "success");
      setSaved(form);
      void load();
    } catch {
      setError("No internet. Nothing was saved. Try again when the tablet is online.");
    } finally {
      setSaving(false);
    }
  };

  const messengerCall = async (path: string, method: string, body?: unknown) => {
    setMpErr(null);
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: { ...adminHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setMpErr(d?.errors?.join(", ") ?? d?.message ?? "Request failed"); return null; }
      return d;
    } catch (e) {
      setMpErr(e instanceof Error ? e.message : "Request failed");
      return null;
    }
  };
  const connectMessenger = async () => {
    const d = await messengerCall("/admin/messenger/connect", "POST", mpForm);
    if (!d) return;
    setMpForm({ pageId: "", pageName: "", accessToken: "" });
    toast("Messenger page connected", "success");
    void load();
  };
  const disconnectMessenger = async () => {
    if (!(await askConfirm("Disconnect the Messenger page?", { ok: "Disconnect", cancel: "Cancel", danger: true }))) return;
    if (!(await messengerCall("/admin/messenger/disconnect", "POST"))) return;
    setMpDeepLink("");
    void load();
  };
  const loadDeepLink = async () => {
    const d = await messengerCall("/admin/messenger/deep-link", "GET");
    if (d) setMpDeepLink(d.deepLink);
  };
  const privacyPreview = async () => {
    const res = await fetch(`${API_URL}/admin/privacy/retention`, { headers: adminHeaders() }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (res?.ok) toast(`${d.conversations} conversation(s), ${d.messages} message(s) can be removed`);
    else toast(d?.message ?? "Could not check. Try again.", "danger");
  };
  const privacyPurge = async () => {
    if (!(await askConfirm("Remove old Messenger conversations and messages? Consent records are kept. This cannot be undone.", { ok: "Remove", cancel: "Cancel", danger: true }))) return;
    const res = await fetch(`${API_URL}/admin/privacy/retention/purge`, { method: "POST", headers: adminHeaders() }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (res?.ok) toast(`Removed ${d.deletedConversations} conversation(s) and ${d.deletedMessages} message(s)`, "success");
    else toast(d?.message ?? "Did not remove. Try again.", "danger");
  };

  /** One line under each group's name: what is set now (saved values, not what is being typed). */
  const summary = (g: Group): string => {
    void printerTick;
    if (!saved) return "";
    switch (g) {
      case "printer": { const p = getPrinterSettings(); return `${p.widthMm} mm · ${p.autoPrint ? "prints after each sale" : "print by hand"}${p.bluetooth ? " · Bluetooth" : ""}`; }
      case "counter": return `${toMinor(saved.dailyTarget) > 0 ? `Target ${peso(toMinor(saved.dailyTarget))}` : "No daily target"} · ${saved.requireOpenShift ? "open the drawer first" : "sell any time"}`;
      case "credit": return toMinor(saved.creditLimit) > 0 ? `New customers ${peso(toMinor(saved.creditLimit))} · ${saved.creditTermDays} days to pay` : `No default limit · ${saved.creditTermDays} days to pay`;
      case "receipt": return `${saved.vatEnabled ? `VAT ${saved.vatRate}%${saved.pricesIncludeVat ? " included" : " added"}` : "No VAT"}${saved.tin ? " · TIN set" : ""}${saved.seniorPwd ? " · Senior/PWD 20%" : ""}`;
      case "shop": return saved.paused ? "Closed for now" : `${saved.allowGuest ? "Open to guests" : "Open"} · ${[saved.deliveryEnabled && "delivery", saved.pickupEnabled && "pickup"].filter(Boolean).join(" and ") || "no delivery or pickup"}`;
      case "messenger": return `${saved.messengerConnected ? "Messenger connected" : "Messenger not connected"} · ${saved.loyaltyRate} point per ₱1`;
      case "account": return getAuthItem("samstore.admin.email") ?? "Name, email and password";
    }
  };

  const menu = (
    <nav aria-label="Settings groups">
      <ul className="settings-menu">
        {GROUPS.map((g) => (
          <li key={g.id}>
            <button type="button" className={`settings-row${shown === g.id ? " is-open" : ""}`} aria-current={shown === g.id ? "true" : undefined} onClick={() => void openGroup(g.id)}>
              <i className={`bi ${g.icon} settings-row-icon`} aria-hidden="true"></i>
              <span className="flex-grow-1 min-w-0">
                <span className="d-block fw-semibold">{g.title}{dirty(g.id) && <span className="badge text-bg-warning ms-2">Not saved</span>}</span>
                <span className="d-block small text-muted text-truncate">{summary(g.id)}</span>
              </span>
              {offline && g.server && <i className="bi bi-wifi-off fs-5 text-muted" role="img" aria-label="Needs internet" title="Needs internet"></i>}
              <i className="bi bi-chevron-right text-muted" aria-hidden="true"></i>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );

  const saveBar = (g: ServerGroup) => {
    const isDirty = dirty(g);
    const blocked = form ? Object.keys(problems(g, form)).length > 0 : true;
    return (
      <div className={`settings-savebar position-sticky bottom-0${wide ? "" : " sticky-above-bar"}`}>
        <span className="me-auto" role="status">
          {saving ? <>Saving…</>
            : isDirty ? <><i className="bi bi-pencil-fill me-1" style={{ color: "#8A5A00" }} aria-hidden="true"></i>Not saved yet</>
            : <><i className="bi bi-check-circle-fill text-success me-1" aria-hidden="true"></i>All saved</>}
        </span>
        {isDirty && !saving && <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => saved && setForm(saved)}>Undo</button>}
        <button type="button" className="btn btn-success btn-lg px-4" disabled={!isDirty || saving || blocked || offline} onClick={() => void saveGroup(g)}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    );
  };

  const needsNet = offline && (
    <div className="alert alert-secondary d-flex align-items-center gap-2 py-2" role="status">
      <i className="bi bi-wifi-off fs-4" aria-hidden="true"></i>
      <div>These settings are kept on the server, so they can be changed only when the tablet is online. The printer works offline.</div>
    </div>
  );

  const body = (g: Group): ReactNode => {
    if (!form) return null;
    const p = g in PAYLOAD ? problems(g as ServerGroup, form) : {};
    switch (g) {
      case "printer":
        return <div onChange={() => setPrinterTick((n) => n + 1)} onClick={() => setPrinterTick((n) => n + 1)}><PrinterSettingsCard storeName={data?.name} /></div>;
      case "counter":
        return (
          <>
            <SwitchRow id="st-shift" label="Open the cash drawer before taking cash" checked={form.requireOpenShift} onChange={(v) => set({ requireOpenShift: v })}
              help="On: each day starts by counting the drawer. Off: staff can sell any time." />
            <SwitchRow id="st-hideprice" label="Hide item prices on pre-orders" checked={form.hidePrePrice} onChange={(v) => set({ hidePrePrice: v })}
              help="The Pre-order screen shows only the total, not the price of each item." />
            <Field id="st-target" label="Daily sales target (₱)" help="Shown on Overview so you can see how the day is going. Leave empty for none.">
              <PesoInput id="st-target" className="form-control form-control-lg" value={form.dailyTarget} onChange={(v) => set({ dailyTarget: v })} placeholder="No target" style={{ maxWidth: 260 }} />
            </Field>
          </>
        );
      case "credit":
        return (
          <>
            <Field id="st-climit" label="Credit limit for new customers (₱)" help="Leave empty or 0 so new customers start with no credit until you set their own limit on the Credit screen.">
              <PesoInput id="st-climit" className="form-control form-control-lg" value={form.creditLimit} onChange={(v) => set({ creditLimit: v })} placeholder="No credit" style={{ maxWidth: 260 }} />
            </Field>
            <Field id="st-cterm" label="Days to pay" help="Utang is due this many days after the sale." problem={p.creditTermDays}>
              <WholeInput id="st-cterm" className={`form-control form-control-lg${p.creditTermDays ? " is-invalid" : ""}`} value={form.creditTermDays} onChange={(v) => set({ creditTermDays: v })} style={{ maxWidth: 160 }}
                aria-invalid={!!p.creditTermDays} aria-describedby={p.creditTermDays ? "st-cterm-problem" : undefined} />
            </Field>
          </>
        );
      case "receipt":
        return (
          <>
            <SwitchRow id="st-vat" label="Charge VAT" checked={form.vatEnabled} onChange={(v) => set({ vatEnabled: v })}
              help="Off: no VAT anywhere. Totals stay the same either way." />
            {form.vatEnabled && (
              <>
                <Field id="st-vatrate" label="VAT rate (%)" problem={p.vatRate}>
                  <input id="st-vatrate" className={`form-control form-control-lg${p.vatRate ? " is-invalid" : ""}`} inputMode="decimal" value={form.vatRate} style={{ maxWidth: 160 }}
                    onChange={(e) => set({ vatRate: e.target.value.replace(/[^\d.]/g, "") })} aria-invalid={!!p.vatRate} aria-describedby={p.vatRate ? "st-vatrate-problem" : undefined} />
                </Field>
                <SwitchRow id="st-vatincl" label="Prices already include VAT" checked={form.pricesIncludeVat} onChange={(v) => set({ pricesIncludeVat: v })}
                  help="Usual in the Philippines: the VAT is taken out of the price, not added on top." />
                <SwitchRow id="st-vatslip" label="Show the VAT lines on receipts" checked={form.vatShowOnReceipt} onChange={(v) => set({ vatShowOnReceipt: v })}
                  help="Off: the receipt leaves out VATable sales and VAT. The total does not change." />
                <SwitchRow id="st-vatlabel" label="Show “VAT included” on order receipts" checked={form.showVat} onChange={(v) => set({ showVat: v })} />
              </>
            )}
            <SwitchRow id="st-senior" label="Senior citizen / PWD 20% discount" checked={form.seniorPwd} onChange={(v) => set({ seniorPwd: v })}
              help="Customers can claim it at checkout. Their ID and name are saved on the order." />
            <Field id="st-tin" label="TIN (printed on receipts)">
              <input id="st-tin" className="form-control form-control-lg" inputMode="numeric" value={form.tin} onChange={(e) => set({ tin: e.target.value })} placeholder="123-456-789-000" style={{ maxWidth: 320 }} />
            </Field>
            <details className="border rounded-3 mb-3 bg-white">
              <summary className="p-3 fw-semibold" style={{ minHeight: 48 }}>Extra lines on order receipts <span className="fw-normal text-muted">· optional</span></summary>
              <div className="px-3 pb-1">
                <p className="small text-muted">For receipts opened from Orders. The store name, address and contact for this tablet's printer are under Printer and receipt text.</p>
                <Field id="st-rhead" label="Line at the top">
                  <input id="st-rhead" className="form-control form-control-lg" maxLength={120} value={form.receiptHeader} onChange={(e) => set({ receiptHeader: e.target.value })} placeholder="e.g. Open 6 AM to 7 PM" />
                </Field>
                <Field id="st-rfoot" label="Line at the bottom">
                  <input id="st-rfoot" className="form-control form-control-lg" maxLength={120} value={form.receiptFooter} onChange={(e) => set({ receiptFooter: e.target.value })} placeholder="e.g. No returns after 3 days" />
                </Field>
              </div>
            </details>
          </>
        );
      case "shop":
        return (
          <>
            {data?.publicLink?.slug && (
              <div className="border rounded-3 p-3 mb-3 bg-light">
                <div className="fw-semibold">Shop link</div>
                <code className="text-break">/public/{data.publicLink.slug}</code>
                <div className="small text-muted">Share or change it on the Store Link screen.</div>
              </div>
            )}
            <SwitchRow id="st-paused" label="Close the shop for now" checked={form.paused} onChange={(v) => set({ paused: v })}
              help="No new online orders until you switch this off." />
            {form.paused && (
              <Field id="st-closedmsg" label="Message while closed">
                <input id="st-closedmsg" className="form-control form-control-lg" maxLength={160} value={form.closedMessage} onChange={(e) => set({ closedMessage: e.target.value })} placeholder="We're taking a break, back soon!" />
              </Field>
            )}
            <SwitchRow id="st-guest" label="Customers can order without an account" checked={form.allowGuest} onChange={(v) => set({ allowGuest: v })} />
            <SwitchRow id="st-delivery" label="Delivery" checked={form.deliveryEnabled} onChange={(v) => set({ deliveryEnabled: v })} />
            <SwitchRow id="st-pickup" label="Pickup at the store" checked={form.pickupEnabled} onChange={(v) => set({ pickupEnabled: v })} />
            <div className="row g-3 mt-1">
              {form.deliveryEnabled && (
                <div className="col-12 col-md-6">
                  <Field id="st-fee" label="Delivery fee (₱)" help="Delivery areas below can set their own fee.">
                    <PesoInput id="st-fee" className="form-control form-control-lg" value={form.deliveryFee} onChange={(v) => set({ deliveryFee: v })} placeholder="Free" />
                  </Field>
                </div>
              )}
              <div className="col-12 col-md-6">
                <Field id="st-min" label="Smallest order (₱)">
                  <PesoInput id="st-min" className="form-control form-control-lg" value={form.minOrder} onChange={(v) => set({ minOrder: v })} placeholder="Any amount" />
                </Field>
              </div>
              <div className="col-12 col-md-6">
                <Field id="st-cutoff" label="Last order time each day" help="Leave empty to take orders all day.">
                  <input id="st-cutoff" className="form-control form-control-lg" type="time" value={form.orderCutoff} onChange={(e) => set({ orderCutoff: e.target.value })} />
                </Field>
              </div>
              <div className="col-12 col-md-6">
                <Field id="st-maxopen" label="Open orders per customer, at most" problem={p.maxOpenOrders}>
                  <WholeInput id="st-maxopen" className={`form-control form-control-lg${p.maxOpenOrders ? " is-invalid" : ""}`} value={form.maxOpenOrders} onChange={(v) => set({ maxOpenOrders: v })}
                    aria-invalid={!!p.maxOpenOrders} aria-describedby={p.maxOpenOrders ? "st-maxopen-problem" : undefined} />
                </Field>
              </div>
              <div className="col-12 col-md-6">
                <Field id="st-prefix" label="Order number starts with" help={<>Example: <strong>{(form.orderPrefix.trim().toUpperCase() || "PIN")}-2026-000001</strong>. Leave empty for the usual numbers.</>}>
                  <input id="st-prefix" className="form-control form-control-lg text-uppercase" maxLength={6} value={form.orderPrefix} onChange={(e) => set({ orderPrefix: e.target.value.replace(/[^a-z0-9]/gi, "") })} placeholder="PIN" />
                </Field>
              </div>
            </div>
          </>
        );
      case "messenger":
        return (
          <>
            <h3 className="h6 text-uppercase text-muted">Loyalty points</h3>
            <div className="row g-3">
              <div className="col-12 col-md-4">
                <Field id="st-lrate" label="Points per ₱1" problem={p.loyaltyRate}>
                  <WholeInput id="st-lrate" className={`form-control form-control-lg${p.loyaltyRate ? " is-invalid" : ""}`} value={form.loyaltyRate} onChange={(v) => set({ loyaltyRate: v })}
                    aria-invalid={!!p.loyaltyRate} aria-describedby={p.loyaltyRate ? "st-lrate-problem" : undefined} />
                </Field>
              </div>
              <div className="col-12 col-md-4">
                <Field id="st-lwelcome" label="Welcome points" help="Once, on a customer's first order.">
                  <WholeInput id="st-lwelcome" className="form-control form-control-lg" value={form.loyaltyWelcome} onChange={(v) => set({ loyaltyWelcome: v })} />
                </Field>
              </div>
              <div className="col-12 col-md-4">
                <Field id="st-lexpiry" label="Points expire after (months)" help="0 = never. Oldest points are used first.">
                  <WholeInput id="st-lexpiry" className="form-control form-control-lg" value={form.loyaltyExpiry} onChange={(v) => set({ loyaltyExpiry: v })} />
                </Field>
              </div>
            </div>

            <h3 className="h6 text-uppercase text-muted mt-2">Messenger</h3>
            <div className="alert alert-secondary py-2">
              <i className="bi bi-messenger me-1" aria-hidden="true"></i>
              Messages are not sent yet. They start once a Facebook app, page token and webhook are set up and approved.
            </div>
            <SwitchRow id="st-mconn" label="Mark this store as connected to Messenger" checked={form.messengerConnected} onChange={(v) => set({ messengerConnected: v })}
              help="Only a note for the shop page. The real keys are kept on the server, never here." />
            <Field id="st-mpage" label="Messenger page ID">
              <input id="st-mpage" className="form-control form-control-lg" inputMode="numeric" value={form.messengerPageId} onChange={(e) => set({ messengerPageId: e.target.value })} placeholder="e.g. 1029384756" />
            </Field>
            <details className="border rounded-3 mb-3 bg-white">
              <summary className="p-3 fw-semibold" style={{ minHeight: 48 }}>Connect a Messenger page <span className="fw-normal text-muted">· {saved?.messengerConnected ? "connected" : "not connected"}</span></summary>
              <div className="px-3 pb-3">
                {mpErr && <div className="alert alert-danger py-2" role="alert">{mpErr}</div>}
                {!saved?.messengerConnected ? (
                  <>
                    <div className="row g-2">
                      <div className="col-12 col-md-4"><label className="form-label mb-1" htmlFor="mp-id">Page ID</label><input id="mp-id" className="form-control" value={mpForm.pageId} onChange={(e) => setMpForm({ ...mpForm, pageId: e.target.value })} /></div>
                      <div className="col-12 col-md-4"><label className="form-label mb-1" htmlFor="mp-name">Page name</label><input id="mp-name" className="form-control" value={mpForm.pageName} onChange={(e) => setMpForm({ ...mpForm, pageName: e.target.value })} /></div>
                      <div className="col-12 col-md-4"><label className="form-label mb-1" htmlFor="mp-token">Page access token</label><input id="mp-token" className="form-control" type="password" autoComplete="off" value={mpForm.accessToken} onChange={(e) => setMpForm({ ...mpForm, accessToken: e.target.value })} /></div>
                    </div>
                    <button type="button" className="btn btn-outline-dark mt-2" disabled={!mpForm.pageId.trim() || !mpForm.pageName.trim() || !mpForm.accessToken.trim()} onClick={() => void connectMessenger()}>Connect page</button>
                  </>
                ) : (
                  <div className="d-flex flex-wrap gap-2 align-items-center">
                    <span className="badge text-bg-success">Connected</span>
                    <button type="button" className="btn btn-outline-dark" onClick={() => void loadDeepLink()}>Show the chat link</button>
                    <button type="button" className="btn btn-outline-danger" onClick={() => void disconnectMessenger()}>Disconnect</button>
                    {mpDeepLink && (
                      <div className="w-100 d-flex flex-wrap gap-2 align-items-center">
                        <code className="text-break">{mpDeepLink}</code>
                        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { void navigator.clipboard?.writeText(mpDeepLink).then(() => toast("Copied")); }}>Copy</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </details>

            <h3 className="h6 text-uppercase text-muted mt-2">Privacy</h3>
            <Field id="st-privacy" label="Keep Messenger chats for (days)" help="0 = keep them. Old chats are removed only when you press Remove old chats. Consent records are always kept." problem={p.privacyDays}>
              <WholeInput id="st-privacy" className={`form-control form-control-lg${p.privacyDays ? " is-invalid" : ""}`} value={form.privacyDays} onChange={(v) => set({ privacyDays: v })} style={{ maxWidth: 200 }}
                aria-invalid={!!p.privacyDays} aria-describedby={p.privacyDays ? "st-privacy-problem" : undefined} />
            </Field>
            <div className="d-flex flex-wrap gap-2 mb-2">
              <button type="button" className="btn btn-outline-dark" onClick={() => void privacyPreview()}>How many can be removed?</button>
              <button type="button" className="btn btn-outline-danger" onClick={() => void privacyPurge()}>Remove old chats</button>
            </div>
          </>
        );
      case "account":
        return <AccountSection />;
    }
  };

  const meta = GROUPS.find((x) => x.id === shown);
  const detail = shown && meta && (
    <section aria-labelledby="settings-group-title">
      <h2 className="h5 d-flex align-items-center gap-2 mb-3" id="settings-group-title">
        <i className={`bi ${meta.icon}`} aria-hidden="true"></i>{meta.title}
      </h2>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {meta.server && needsNet}
      {meta.server ? (
        <fieldset disabled={offline} className="border-0 p-0 m-0" style={{ minWidth: 0 }}>
          <div className="settings-group">
            {body(shown)}
            {shown in PAYLOAD && saveBar(shown as ServerGroup)}
          </div>
          {shown === "shop" && form?.deliveryEnabled && <div className="mt-3"><DeliveryZonesCard /></div>}
        </fieldset>
      ) : body(shown)}
    </section>
  );

  return (
    <div className="settings-screen">
      <div className="d-flex flex-wrap align-items-baseline justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">Settings</h1>
        {data && <span className="text-muted">{data.name} · {data.status === "ACTIVE" ? "Active" : data.status} · {data.currencyCode} · {data.timezone}</span>}
      </div>
      {!form && error && <div className="alert alert-danger py-2" role="alert">{error} <button type="button" className="btn btn-outline-dark btn-sm ms-2" onClick={() => void load()}>Try again</button></div>}
      {form && (wide ? (
        <div className="row g-3">
          <div className="col-lg-4">{menu}</div>
          <div className="col-lg-8 pos-side">{detail}</div>
        </div>
      ) : shown ? (
        <>
          <button type="button" className="btn btn-link px-0 mb-2 fs-5" onClick={() => void openGroup(null)}>← Settings</button>
          {detail}
        </>
      ) : menu)}
    </div>
  );
}

function AccountSection() {
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [profName, setProfName] = useState("");
  const [profEmail, setProfEmail] = useState(getAuthItem("samstore.admin.email") ?? "");
  const [profMsg, setProfMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [profBusy, setProfBusy] = useState(false);

  const changePw = async () => {
    if (newPw.length < 8) { setPwMsg({ ok: false, text: "The new password needs at least 8 characters." }); return; }
    setPwBusy(true); setPwMsg(null);
    try {
      const res = await fetch(`${API_URL}/auth/change-password`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ email: profEmail, currentPassword: curPw, newPassword: newPw }),
      });
      const d = await res.json();
      if (!res.ok) { setPwMsg({ ok: false, text: d?.message ?? "Did not change. Try again." }); return; }
      setPwMsg({ ok: true, text: "Password changed." });
      setCurPw(""); setNewPw("");
      if (typeof d?.token === "string") setAuthItem("samstore.admin.token", d.token);
    } catch {
      setPwMsg({ ok: false, text: "No internet. The password did not change." });
    } finally { setPwBusy(false); }
  };

  const saveProfile = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profEmail)) { setProfMsg({ ok: false, text: "Enter a valid email." }); return; }
    setProfBusy(true); setProfMsg(null);
    try {
      const res = await fetch(`${API_URL}/admin/auth/profile`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ email: profEmail.trim(), name: profName.trim() || null }),
      });
      const d = await res.json();
      if (!res.ok) { setProfMsg({ ok: false, text: d?.message ?? d?.errors?.join(", ") ?? "Did not save. Try again." }); return; }
      setProfMsg({ ok: true, text: "Saved." });
      setAuthItem("samstore.admin.email", d.email);
    } catch {
      setProfMsg({ ok: false, text: "No internet. Nothing was saved." });
    } finally { setProfBusy(false); }
  };

  return (
    <>
      <div className="border rounded-3 p-3 mb-3 bg-white">
        <h3 className="h6 text-uppercase text-muted">My name and email</h3>
        <Field id="ac-name" label="Name">
          <input id="ac-name" className="form-control form-control-lg" autoComplete="name" value={profName} onChange={(e) => setProfName(e.target.value)} placeholder="Your name" />
        </Field>
        <Field id="ac-email" label="Email">
          <input id="ac-email" className="form-control form-control-lg" type="email" autoComplete="email" value={profEmail} onChange={(e) => setProfEmail(e.target.value)} placeholder="you@store.com" />
        </Field>
        {profMsg && <div className={`alert ${profMsg.ok ? "alert-success" : "alert-danger"} py-2`} role="status">{profMsg.text}</div>}
        <button type="button" className="btn btn-success btn-lg" disabled={profBusy} onClick={() => void saveProfile()}>{profBusy ? "Saving…" : "Save name and email"}</button>
      </div>
      <div className="border rounded-3 p-3 mb-3 bg-white">
        <h3 className="h6 text-uppercase text-muted">Change password</h3>
        <Field id="ac-cur" label="Current password">
          <input id="ac-cur" className="form-control form-control-lg" type="password" autoComplete="current-password" value={curPw} onChange={(e) => setCurPw(e.target.value)} />
        </Field>
        <Field id="ac-new" label="New password" help="At least 8 characters.">
          <input id="ac-new" className="form-control form-control-lg" type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </Field>
        {pwMsg && <div className={`alert ${pwMsg.ok ? "alert-success" : "alert-danger"} py-2`} role="status">{pwMsg.text}</div>}
        <button type="button" className="btn btn-outline-dark btn-lg" disabled={pwBusy || !curPw || !newPw} onClick={() => void changePw()}>{pwBusy ? "Changing…" : "Change password"}</button>
      </div>
    </>
  );
}
