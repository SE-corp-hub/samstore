"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";

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
  };
}

type Section = "general" | "pos" | "receipt" | "orders" | "taxes" | "invoices";

export default function SettingsPanel() {
  const [data, setData] = useState<StoreSettings | null>(null);
  const [section, setSection] = useState<Section>("general");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── General ──
  const [allowGuest, setAllowGuest] = useState(true);
  const [paused, setPaused] = useState(false);
  const [deliveryEnabled, setDeliveryEnabled] = useState(true);
  const [pickupEnabled, setPickupEnabled] = useState(false);

  // ── POS ──
  const [dailyTargetPesos, setDailyTargetPesos] = useState("");
  const [hidePrePrice, setHidePrePrice] = useState(false);
  const [receiptHeader, setReceiptHeader] = useState("");
  const [receiptFooter, setReceiptFooter] = useState("");
  const [showVat, setShowVat] = useState(true);

  // ── Orders ──
  const [deliveryFeePesos, setDeliveryFeePesos] = useState("");
  const [minOrderPesos, setMinOrderPesos] = useState("");
  const [orderCutoff, setOrderCutoff] = useState("");
  const [maxOpenOrders, setMaxOpenOrders] = useState("10");
  const [closedStoreMessage, setClosedStoreMessage] = useState("");
  const [creditLimitPesos, setCreditLimitPesos] = useState("");
  const [creditTermDays, setCreditTermDays] = useState("30");

  // ── Taxes ──
  const [vatEnabled, setVatEnabled] = useState(true);
  const [vatRatePct, setVatRatePct] = useState("12");
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [vatShowOnReceipt, setVatShowOnReceipt] = useState(true);
  const [tin, setTin] = useState("");
  const [seniorPwdDiscountEnabled, setSeniorPwdDiscountEnabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/settings`, { headers: { ...adminHeaders() } });
      if (!res.ok) throw new Error("Failed to load settings");
      const d = (await res.json()) as StoreSettings;
      setData(d);
      setAllowGuest(d.settings.allowGuestOrders);
      setPaused(d.settings.orderingPaused);
      setDeliveryEnabled(d.settings.deliveryEnabled);
      setPickupEnabled(d.settings.pickupEnabled);
      setDailyTargetPesos((d.settings.dailySalesTargetMinor ?? 0) > 0 ? ((d.settings.dailySalesTargetMinor ?? 0) / 100).toString() : "");
      setHidePrePrice(d.settings.hidePricePreOrder ?? false);
      setReceiptHeader(d.settings.receiptHeader ?? "");
      setReceiptFooter(d.settings.receiptFooter ?? "");
      setShowVat(d.settings.showVatLabel);
      setDeliveryFeePesos((d.settings.deliveryFeeMinor / 100).toString());
      setMinOrderPesos((d.settings.minOrderAmountMinor / 100).toString());
      setOrderCutoff(d.settings.orderCutoff ?? "");
      setMaxOpenOrders(d.settings.maxOpenOrdersPerCustomer.toString());
      setClosedStoreMessage(d.settings.closedStoreMessage ?? "");
      setCreditLimitPesos((d.settings.creditLimitMinor / 100).toString());
      setCreditTermDays(d.settings.creditTermDays.toString());
      setVatEnabled(d.settings.vatEnabled ?? true);
      setVatRatePct(((d.settings.vatRateBp ?? 1200) / 100).toString());
      setPricesIncludeVat(d.settings.pricesIncludeVat ?? true);
      setVatShowOnReceipt(d.settings.vatShowOnReceipt ?? true);
      setTin(d.settings.tin ?? "");
      setSeniorPwdDiscountEnabled(d.settings.seniorPwdDiscountEnabled ?? false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveSection = async (fields: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`${API_URL}/admin/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(fields),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.message ?? body?.errors?.join(", ") ?? "Save failed");
        return;
      }
      setSaved(true);
      toast("Settings saved");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveGeneral = () => saveSection({
    allowGuestOrders: allowGuest,
    orderingPaused: paused,
    deliveryEnabled,
    pickupEnabled,
  });

  const savePos = () => saveSection({
    dailySalesTargetMinor: Math.round(parseFloat(dailyTargetPesos || "0") * 100),
    hidePricePreOrder: hidePrePrice,
    receiptHeader: receiptHeader || null,
    receiptFooter: receiptFooter || null,
    showVatLabel: showVat,
  });

  const saveReceipt = () => saveSection({
    showVatLabel: showVat,
  });

  const saveOrders = () => saveSection({
    deliveryFeeMinor: Math.round(parseFloat(deliveryFeePesos || "0") * 100),
    minOrderAmountMinor: Math.round(parseFloat(minOrderPesos || "0") * 100),
    orderCutoff: orderCutoff || null,
    maxOpenOrdersPerCustomer: parseInt(maxOpenOrders, 10) || 10,
    closedStoreMessage: closedStoreMessage || null,
    creditLimitMinor: Math.round(parseFloat(creditLimitPesos || "0") * 100),
    creditTermDays: parseInt(creditTermDays, 10) || 30,
  });

  const saveTaxes = () => saveSection({
    vatEnabled,
    vatRateBp: Math.round(parseFloat(vatRatePct || "0") * 100),
    pricesIncludeVat,
    vatShowOnReceipt,
    tin: tin.trim() || null,
    seniorPwdDiscountEnabled,
  });

  const saveInvoices = () => toast("Invoice settings saved");

  if (loading) return <p className="text-muted">Loading…</p>;

  const sections: { id: Section; label: string }[] = [
    { id: "general", label: "General" },
    { id: "pos", label: "POS" },
    { id: "receipt", label: "Receipt" },
    { id: "orders", label: "Orders" },
    { id: "taxes", label: "Taxes" },
    { id: "invoices", label: "Invoices" },
  ];

  return (
    <div>
      <h1 className="h4 mb-3">Store Settings</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {saved && <div className="alert alert-success py-2 small">Settings saved.</div>}

      {data && (
        <>
          <div className="card mb-4">
            <div className="card-body">
              <h6 className="card-title">{data.name} <span className="badge text-bg-secondary ms-1">{data.status}</span></h6>
              <p className="small text-muted mb-1">Public link: <code>/public/{data.publicLink?.slug}</code></p>
              <p className="small text-muted mb-0">Currency <strong>{data.currencyCode}</strong> · Timezone <strong>{data.timezone}</strong></p>
            </div>
          </div>

          <ul className="nav nav-tabs mb-3">
            {sections.map((s) => (
              <li className="nav-item" key={s.id}>
                <button className={`nav-link ${section === s.id ? "active" : ""}`} onClick={() => setSection(s.id)}>{s.label}</button>
              </li>
            ))}
          </ul>

          {section === "general" && (
            <div>
              <div className="card mb-4">
                <div className="card-body">
                  <h6 className="card-title small fw-bold">Store identity</h6>
                  <div className="row g-3">
                    <div className="col-md-6">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="allowGuest" checked={allowGuest} onChange={(e) => setAllowGuest(e.target.checked)} />
                        <label className="form-check-label" htmlFor="allowGuest">Allow guest orders (public link)</label>
                      </div>
                    </div>
                    <div className="col-md-6">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="paused" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
                        <label className="form-check-label" htmlFor="paused">Pause ordering (closes the store)</label>
                      </div>
                    </div>
                    <div className="col-md-6">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="delivery" checked={deliveryEnabled} onChange={(e) => setDeliveryEnabled(e.target.checked)} />
                        <label className="form-check-label" htmlFor="delivery">Delivery enabled</label>
                      </div>
                    </div>
                    <div className="col-md-6">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="pickup" checked={pickupEnabled} onChange={(e) => setPickupEnabled(e.target.checked)} />
                        <label className="form-check-label" htmlFor="pickup">Pickup enabled</label>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 d-flex justify-content-end">
                    <button className="btn btn-primary" type="button" disabled={saving} onClick={saveGeneral}>{saving ? "Saving…" : "Save general"}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {section === "pos" && (
            <div>
              <div className="card mb-4">
                <div className="card-body">
                  <h6 className="card-title small fw-bold">POS settings</h6>
                  <div className="row g-3">
                    <div className="col-md-4">
                      <label className="form-label small">Daily sales target (₱) — shown on Overview</label>
                      <input className="form-control" type="number" step="0.01" min="0" value={dailyTargetPesos} onChange={(e) => setDailyTargetPesos(e.target.value)} placeholder="0 = off" />
                    </div>
                    <div className="col-md-8">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="hidePrePrice" checked={hidePrePrice} onChange={(e) => setHidePrePrice(e.target.checked)} />
                        <label className="form-check-label" htmlFor="hidePrePrice">Hide price on pre order <span className="text-muted small">(per-product prices hidden in the Pre Orders screen — subtotal/total stay)</span></label>
                      </div>
                    </div>
                    <div className="col-md-8">
                      <label className="form-label small">Receipt header text</label>
                      <input className="form-control" value={receiptHeader} onChange={(e) => setReceiptHeader(e.target.value)} placeholder="e.g. Salamat po! / Store address & phone" />
                    </div>
                    <div className="col-md-8">
                      <label className="form-label small">Receipt footer text</label>
                      <input className="form-control" value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} placeholder="e.g. No returns after 3 days" />
                    </div>
                    <div className="col-md-8">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="showVat" checked={showVat} onChange={(e) => setShowVat(e.target.checked)} />
                        <label className="form-check-label" htmlFor="showVat">Show VAT display-only label on receipts</label>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 d-flex justify-content-end">
                    <button className="btn btn-primary" type="button" disabled={saving} onClick={savePos}>{saving ? "Saving…" : "Save POS settings"}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {section === "receipt" && (
            <div>
              <div className="card mb-4">
                <div className="card-body">
                  <h6 className="card-title small fw-bold">Receipt print settings</h6>
                  <div className="row g-3">
                    <div className="col-md-8">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="vatShowOnReceipt" checked={vatShowOnReceipt} onChange={(e) => setVatShowOnReceipt(e.target.checked)} />
                        <label className="form-check-label" htmlFor="vatShowOnReceipt">Show the VAT breakdown on printed receipts <span className="text-muted small">(hide it and the slip simply omits the VAT lines — totals never change)</span></label>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 d-flex justify-content-end">
                    <button className="btn btn-primary" type="button" disabled={saving} onClick={saveReceipt}>{saving ? "Saving…" : "Save receipt settings"}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {section === "orders" && (
            <div>
              <div className="card mb-4">
                <div className="card-body">
                  <h6 className="card-title small fw-bold">Order settings</h6>
                  <div className="row g-3">
                    <div className="col-md-4">
                      <label className="form-label small">Delivery fee (₱)</label>
                      <input className="form-control" type="number" step="0.01" min="0" value={deliveryFeePesos} onChange={(e) => setDeliveryFeePesos(e.target.value)} />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label small">Min order (₱)</label>
                      <input className="form-control" type="number" step="0.01" min="0" value={minOrderPesos} onChange={(e) => setMinOrderPesos(e.target.value)} />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label small">Order cutoff (HH:MM)</label>
                      <input className="form-control" type="time" value={orderCutoff} onChange={(e) => setOrderCutoff(e.target.value)} />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label small">Max open orders / customer</label>
                      <input className="form-control" type="number" min="1" value={maxOpenOrders} onChange={(e) => setMaxOpenOrders(e.target.value)} />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label small">Default utang credit limit (₱)</label>
                      <input className="form-control" type="number" step="0.01" min="0" value={creditLimitPesos} onChange={(e) => setCreditLimitPesos(e.target.value)} placeholder="0 = credit disabled" />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label small">Credit term (days)</label>
                      <input className="form-control" type="number" min="1" value={creditTermDays} onChange={(e) => setCreditTermDays(e.target.value)} />
                    </div>
                    <div className="col-md-8">
                      <label className="form-label small">Closed-store message</label>
                      <input className="form-control" value={closedStoreMessage} onChange={(e) => setClosedStoreMessage(e.target.value)} placeholder="We're taking a break — back soon!" />
                    </div>
                  </div>
                  <div className="mt-3 d-flex justify-content-end">
                    <button className="btn btn-primary" type="button" disabled={saving} onClick={saveOrders}>{saving ? "Saving…" : "Save order settings"}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {section === "taxes" && (
            <div>
              <div className="card mb-4">
                <div className="card-body">
                  <h6 className="card-title small fw-bold">Tax / VAT (BIR)</h6>
                  <div className="row g-3">
                    <div className="col-md-3">
                      <label className="form-label small">VAT rate (%)</label>
                      <input id="vatRate" className="form-control" type="number" step="0.01" min="0" max="100" value={vatRatePct} onChange={(e) => setVatRatePct(e.target.value)} />
                    </div>
                    <div className="col-md-9">
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="vatEnabled" checked={vatEnabled} onChange={(e) => setVatEnabled(e.target.checked)} />
                        <label className="form-check-label" htmlFor="vatEnabled">Compute VAT on sales <span className="text-muted small">(off = no VAT anywhere; totals are unchanged)</span></label>
                      </div>
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="pricesIncludeVat" checked={pricesIncludeVat} onChange={(e) => setPricesIncludeVat(e.target.checked)} />
                        <label className="form-check-label" htmlFor="pricesIncludeVat">Catalogue prices already include VAT <span className="text-muted small">(PH retail default — the VAT is extracted, not added)</span></label>
                      </div>
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="vatShowOnReceipt" checked={vatShowOnReceipt} onChange={(e) => setVatShowOnReceipt(e.target.checked)} />
                        <label className="form-check-label" htmlFor="vatShowOnReceipt">Show the VAT breakdown on printed receipts <span className="text-muted small">(hide it and the slip simply omits the VAT lines — totals never change)</span></label>
                      </div>
                      <div className="form-check form-switch">
                        <input className="form-check-input" type="checkbox" id="seniorPwd" checked={seniorPwdDiscountEnabled} onChange={(e) => setSeniorPwdDiscountEnabled(e.target.checked)} />
                        <label className="form-check-label" htmlFor="seniorPwd">Accept the statutory <strong>20% Senior Citizen / PWD discount</strong> <span className="text-muted small">(customers claim it at checkout; ID + name captured on the order)</span></label>
                      </div>
                      <div className="mt-2">
                        <label className="form-label small">TIN (printed on the slip)</label>
                        <input id="tin" className="form-control" value={tin} onChange={(e) => setTin(e.target.value)} placeholder="e.g. 123-456-789-000" />
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 d-flex justify-content-end">
                    <button className="btn btn-primary" type="button" disabled={saving} onClick={saveTaxes}>{saving ? "Saving…" : "Save tax settings"}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {section === "invoices" && (
            <div>
              <div className="card mb-4">
                <div className="card-body">
                  <h6 className="card-title small fw-bold">Invoice settings</h6>
                  <p className="text-muted small">Invoice configuration will be available in a future update. For now, use the Receipt and Taxes sections to configure VAT display and receipt formatting.</p>
                  <div className="mt-3 d-flex justify-content-end">
                    <button className="btn btn-primary" type="button" disabled={saving} onClick={saveInvoices}>{saving ? "Saving…" : "Save invoice settings"}</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Account: edit profile + change password */}
          <AccountSection />
        </>
      )}
    </div>
  );
}

function AccountSection() {
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [profName, setProfName] = useState("");
  const [profEmail, setProfEmail] = useState(typeof sessionStorage !== "undefined" ? (sessionStorage.getItem("samstore.admin.email") ?? "") : "");
  const [profMsg, setProfMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [profBusy, setProfBusy] = useState(false);

  const changePw = async () => {
    if (newPw.length < 8) { setPwMsg({ ok: false, text: "New password must be at least 8 characters." }); return; }
    setPwBusy(true); setPwMsg(null);
    try {
      const res = await fetch(`${API_URL}/auth/change-password`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ email: profEmail, currentPassword: curPw, newPassword: newPw }),
      });
      const d = await res.json();
      if (!res.ok) { setPwMsg({ ok: false, text: d?.message ?? "Change failed" }); return; }
      setPwMsg({ ok: true, text: "Password changed successfully." });
      setCurPw(""); setNewPw("");
      if (typeof d?.token === "string") sessionStorage.setItem("samstore.admin.token", d.token);
    } catch {
      setPwMsg({ ok: false, text: "Network error — could not change password." });
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
      if (!res.ok) { setProfMsg({ ok: false, text: d?.message ?? d?.errors?.join(", ") ?? "Save failed" }); return; }
      setProfMsg({ ok: true, text: "Profile updated." });
      sessionStorage.setItem("samstore.admin.email", d.email);
    } catch {
      setProfMsg({ ok: false, text: "Network error — could not save profile." });
    } finally { setProfBusy(false); }
  };

  return (
    <>
      <div className="card mb-4">
        <div className="card-body">
          <h6 className="fw-bold"><i className="bi bi-person me-2"></i>My profile</h6>
          <label className="form-label small">Name</label>
          <input className="form-control" value={profName} onChange={(e) => setProfName(e.target.value)} placeholder="Your name" />
          <label className="form-label small mt-2">Email</label>
          <input className="form-control" type="email" value={profEmail} onChange={(e) => setProfEmail(e.target.value)} placeholder="you@store.com" />
          {profMsg && <div className={`alert ${profMsg.ok ? "alert-success" : "alert-danger"} py-2 small mt-2`}>{profMsg.text}</div>}
          <button className="btn btn-outline-primary mt-2" disabled={profBusy} onClick={saveProfile}>{profBusy ? "Saving…" : "Save profile"}</button>
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-body">
          <h6 className="fw-bold"><i className="bi bi-shield-lock me-2"></i>Change password</h6>
          <label className="form-label small">Current password</label>
          <input className="form-control" type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} />
          <label className="form-label small mt-2">New password (min 8 characters)</label>
          <input className="form-control" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          {pwMsg && <div className={`alert ${pwMsg.ok ? "alert-success" : "alert-danger"} py-2 small mt-2`}>{pwMsg.text}</div>}
          <button className="btn btn-outline-secondary mt-2" disabled={pwBusy} onClick={changePw}>{pwBusy ? "Changing…" : "Change password"}</button>
        </div>
      </div>
    </>
  );
}