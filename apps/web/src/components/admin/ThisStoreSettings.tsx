"use client";

// "This store" (2026-11-20). The owner asked that each store has its own settings: Open day and
// Z-read on or off, the drawer rule, pre-order prices, its target, and its own receipt details.
// Who can change them: the owner and managers (every store), the head of a store (that store only).
// The server decides (GET/PATCH /admin/store-settings); this screen only lists the stores it allows.
// A store that never chose a switch follows the business's old setting, so nothing changed on day one.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { cachedGet, saveCopy, savedCopy, useOffline } from "../../lib/offlineCache";
import { PesoInput } from "../NumberBoxes";
import { kg } from "../../lib/number-format";
import { askConfirm } from "../../lib/ask";
import { ScopeTag } from "./WhoCan";

const PATH = "/admin/store-settings";

interface Place {
  id: string; name: string; code: string | null; type: string; sells: boolean;
  dayOpenClose: boolean; requireOpenShift: boolean; hidePricePreOrder: boolean;
  /** Sells rice per kilo as well as per sack (off = sacks only). Older servers leave it out. */
  sellPerKilo?: boolean; kiloGramsLeft?: number;
  address: string | null; facebookPageUrl: string | null; receiptName: string | null; receiptHeader: string | null;
  receiptFooter: string | null; receiptContact: string | null; dailySalesTargetMinor: number | null;
  /** The start of this store's receipt numbers (e.g. BL). Older servers leave it out. */
  orderPrefix?: string | null;
}
/** businessPrefix / slugPrefix: what numbers start with when a store has no own start. */
interface Answer { places: Place[]; businessPrefix?: string | null; slugPrefix?: string }

interface Form {
  dayOpenClose: boolean; requireOpenShift: boolean; hidePricePreOrder: boolean; sellPerKilo: boolean; target: string;
  receiptName: string; address: string; receiptContact: string; receiptHeader: string; receiptFooter: string; facebookPageUrl: string; orderPrefix: string;
}

const pesos = (minor: number | null | undefined) => (minor ? String(minor / 100) : "");
const toMinor = (v: string) => { const n = Number(v.replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
const toForm = (p: Place): Form => ({
  dayOpenClose: p.dayOpenClose, requireOpenShift: p.requireOpenShift, hidePricePreOrder: p.hidePricePreOrder, sellPerKilo: !!p.sellPerKilo, target: pesos(p.dailySalesTargetMinor),
  receiptName: p.receiptName ?? "", address: p.address ?? "", receiptContact: p.receiptContact ?? "",
  receiptHeader: p.receiptHeader ?? "", receiptFooter: p.receiptFooter ?? "", facebookPageUrl: p.facebookPageUrl ?? "",
  orderPrefix: p.orderPrefix ?? "",
});
const orNull = (v: string) => v.trim() || null;
const payload = (f: Form, sells: boolean) => ({
  ...(sells ? { dayOpenClose: f.dayOpenClose, requireOpenShift: f.requireOpenShift, hidePricePreOrder: f.hidePricePreOrder, sellPerKilo: f.sellPerKilo, dailySalesTargetMinor: toMinor(f.target), orderPrefix: orNull(f.orderPrefix) } : {}),
  receiptName: orNull(f.receiptName), address: orNull(f.address), receiptContact: orNull(f.receiptContact),
  receiptHeader: orNull(f.receiptHeader), receiptFooter: orNull(f.receiptFooter), facebookPageUrl: orNull(f.facebookPageUrl),
});

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

function Box({ id, label, help, value, onChange, placeholder }: { id: string; label: string; help?: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="mb-3">
      <label className="form-label fw-semibold mb-1" htmlFor={id}>{label}</label>
      <input id={id} className="form-control form-control-lg" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {help && <div className="small text-muted mt-1">{help}</div>}
    </div>
  );
}

/** `standalone`: the store head's own screen (with its title); inside Settings it has none. */
export default function ThisStoreSettings({ standalone = false, onSaved }: { standalone?: boolean; onSaved?: () => void }) {
  const offline = useOffline();
  const [answer, setAnswer] = useState<Answer | null>(() => savedCopy<Answer>(PATH));
  const [placeId, setPlaceId] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await cachedGet<Answer>(PATH);
    if (d) { setAnswer(d); setLoadError(null); } else if (!savedCopy<Answer>(PATH)) setLoadError("Could not load the stores. Connect to the internet and try again.");
  }, []);
  useEffect(() => { void load(); }, [load]);

  const places = useMemo(() => answer?.places ?? [], [answer]);
  const place = places.find((p) => p.id === placeId) ?? null;
  // The first store is chosen at the start (a store head has only its own).
  useEffect(() => { if (!places.some((p) => p.id === placeId)) setPlaceId(places[0]?.id ?? ""); }, [places, placeId]);
  useEffect(() => { setForm(place ? toForm(place) : null); setProblem(null); }, [place]);

  if (!answer) {
    return (
      <div className={standalone ? "settings-screen" : ""}>
        {standalone && <h1 className="h4 mb-3">This store</h1>}
        {loadError
          ? <div className="alert alert-danger py-2" role="alert">{loadError} <button type="button" className="btn btn-outline-dark btn-lg ms-2" onClick={() => void load()}>Try again</button></div>
          : <p className="text-muted">Loading…</p>}
      </div>
    );
  }
  if (!place || !form) return <div className="alert alert-secondary py-2" role="note">No store to set. Only the owner, a manager or the head of a store can change a store&apos;s settings.</div>;

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const dirty = JSON.stringify(payload(form, place.sells)) !== JSON.stringify(payload(toForm(place), place.sells));

  // Another store's button while this one has changes: ask first, so nothing is lost or saved to the wrong store.
  const pick = async (id: string) => {
    if (id === placeId) return;
    if (dirty && !(await askConfirm(`${place.name} has changes that are not saved. Leave them?`, { ok: "Leave", cancel: "Stay", danger: true }))) return;
    setPlaceId(id);
  };

  const save = async () => {
    setBusy(true); setProblem(null);
    try {
      const res = await fetch(`${API_URL}${PATH}/${encodeURIComponent(place.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(payload(form, place.sells)),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setProblem(d?.message ?? d?.errors?.join(", ") ?? "Did not save. Try again."); return; }
      const fresh = await cachedGet<Answer>(PATH);
      if (fresh) { setAnswer(fresh); saveCopy(PATH, fresh); }
      // POS, Pre-order and the reports read the switches from these saved answers: get them again.
      void cachedGet("/admin/settings"); void cachedGet("/admin/rice/day");
      // The price list of this store (kilo rice shows or hides with "Sell per kilo here").
      void cachedGet(`/admin/benta/catalog?locationId=${encodeURIComponent(place.id)}`);
      toast(`${place.name} saved`, "success");
      onSaved?.();
    } catch {
      setProblem("No internet. Nothing was saved. Try again when the tablet is online.");
    } finally { setBusy(false); }
  };

  return (
    <div className={standalone ? "settings-screen" : ""}>
      {standalone && <h1 className="h4 mb-3">This store · {place.name}</h1>}
      {places.length > 1 && (
        <div className="mb-3">
          <div className="fw-semibold mb-2" id="ts-which">Which store?</div>
          <div className="d-flex flex-wrap gap-2" role="group" aria-labelledby="ts-which">
            {places.map((p) => (
              <button key={p.id} type="button" className={`btn btn-lg ${placeId === p.id ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={placeId === p.id}
                disabled={busy} onClick={() => void pick(p.id)}>
                {p.name}
                {p.sells && <span className={`badge ms-2 ${p.dayOpenClose ? "text-bg-success" : "text-bg-light"}`}>{p.dayOpenClose ? "Z-read on" : "Z-read off"}</span>}
                {p.sells && p.sellPerKilo && <span className="badge ms-1 text-bg-success">Per kilo</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <ScopeTag scope="store" storeName={place.name} />

      {offline && (
        <div className="alert alert-secondary d-flex align-items-center gap-2 py-2" role="status">
          <i className="bi bi-wifi-off fs-4" aria-hidden="true"></i>
          <div>These settings are kept on the server, so they can be changed only when the tablet is online.</div>
        </div>
      )}

      <fieldset disabled={offline || busy} className="border-0 p-0 m-0" style={{ minWidth: 0 }}>
        <div className="settings-group">
          {place.sells ? (
            <>
              <h3 className="h5 mb-2">Selling at {place.name}</h3>
              <SwitchRow id="ts-day" label="Open and close the day on POS" checked={form.dayOpenClose} onChange={(v) => set({ dayOpenClose: v })}
                help={`On: ${place.name} taps Open day (change fund) before selling, and Close day at night: count the cash and GCash and print the Z-read. No sale while the day is not open. Other stores are not changed.`} />
              {!form.dayOpenClose && (
                <SwitchRow id="ts-shift" label="Open the cash drawer before taking cash" checked={form.requireOpenShift} onChange={(v) => set({ requireOpenShift: v })}
                  help="On: each day starts by counting the drawer. Off: staff can sell any time." />
              )}
              <SwitchRow id="ts-kilo" label="Sell per kilo here" checked={form.sellPerKilo} onChange={(v) => set({ sellPerKilo: v })}
                help={form.sellPerKilo
                  ? `On: ${place.name} sells rice by the sack AND by the kilo. Kilo rice shows on POS and Pre-order. Choose which rice in Products: Also sell per kilo.`
                  : `Off: ${place.name} sells by the sack only. Kilo rice does not show on POS or Pre-order here.`} />
              {place.sellPerKilo && !form.sellPerKilo && (place.kiloGramsLeft ?? 0) > 0 && (
                <div className="alert alert-warning py-2" role="alert">
                  <i className="bi bi-exclamation-triangle-fill me-1" aria-hidden="true"></i>
                  {kg(place.kiloGramsLeft ?? 0)} of kilo rice is still at {place.name}. It stays in stock and shows in the count, but it cannot be sold here until you turn this back on.
                </div>
              )}
              <SwitchRow id="ts-hideprice" label="Hide item prices on pre-orders" checked={form.hidePricePreOrder} onChange={(v) => set({ hidePricePreOrder: v })}
                help="The Pre-order screen shows only the total, not the price of each item." />
              <div className="mb-3">
                <label className="form-label fw-semibold mb-1" htmlFor="ts-target">Daily sales target (₱)</label>
                <PesoInput id="ts-target" className="form-control form-control-lg" value={form.target} onChange={(v) => set({ target: v })} placeholder="No target" style={{ maxWidth: 260 }} />
                <div className="small text-muted mt-1">Shown on Overview for this store. Leave empty for none.</div>
              </div>
            </>
          ) : (
            <p className="text-muted mb-3">{place.name} does not sell, so it has no Open day or drawer switches.</p>
          )}

          {place.sells && (() => {
            // Receipt numbers: the store's own start, else the business's, else the hidden business code.
            const own = form.orderPrefix.trim();
            const fallback = answer?.businessPrefix || "";
            const year = new Date().getFullYear();
            const example = own ? `${own}-${year}-000123` : fallback ? `${fallback}-${year}-000123` : `${answer?.slugPrefix || "TESTBI"}-000123`;
            const short = own.length === 1;
            return (
              <div className="mb-3">
                <label className="form-label fw-semibold mb-1" htmlFor="ts-prefix">Receipt numbers start with</label>
                <input id="ts-prefix" className="form-control form-control-lg text-uppercase" style={{ maxWidth: 260 }} maxLength={6} autoCapitalize="characters"
                  value={form.orderPrefix} placeholder="BL" aria-describedby="ts-prefix-help"
                  onChange={(e) => set({ orderPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} />
                <div id="ts-prefix-help" className="small text-muted mt-1">
                  New sales and orders here will look like <strong>{example}</strong>. 2 to 6 letters or numbers, like BL or LIPA. Old receipts keep their numbers.
                  {!own && <> Leave empty to use {fallback ? <>the business&apos;s <strong>{fallback}</strong></> : "the business code"}.</>}
                </div>
                {short && <div className="small text-danger mt-1" role="alert">Use at least 2 letters.</div>}
              </div>
            );
          })()}

          <h3 className="h5 mt-4 mb-2">{place.name} details</h3>
          <Box id="ts-name" label="Store name on receipts" value={form.receiptName} onChange={(v) => set({ receiptName: v })} help="Leave empty to print the business name." />
          <Box id="ts-address" label="Address" value={form.address} onChange={(v) => set({ address: v })} />
          <Box id="ts-contact" label="Contact number" value={form.receiptContact} onChange={(v) => set({ receiptContact: v })} />
          <Box id="ts-head" label="Top line of the receipt" value={form.receiptHeader} onChange={(v) => set({ receiptHeader: v })} help="Leave empty to use the business's own." />
          <Box id="ts-foot" label="Last line of the receipt" value={form.receiptFooter} onChange={(v) => set({ receiptFooter: v })} placeholder="Salamat po!" help="Leave empty to use the business's own." />
          {place.sells && <Box id="ts-page" label="Facebook Page link" value={form.facebookPageUrl} onChange={(v) => set({ facebookPageUrl: v })} placeholder="facebook.com/…" />}

          {problem && <div className="alert alert-danger py-2" role="alert">{problem}</div>}
          <div className="settings-savebar position-sticky bottom-0 sticky-above-bar">
            <span className="me-auto" role="status">
              {busy ? <>Saving…</>
                : dirty ? <><i className="bi bi-pencil-fill me-1" style={{ color: "#8A5A00" }} aria-hidden="true"></i>Not saved yet</>
                : <><i className="bi bi-check-circle-fill text-success me-1" aria-hidden="true"></i>All saved</>}
            </span>
            {dirty && !busy && <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setForm(toForm(place))}>Undo</button>}
            <button type="button" className="btn btn-success btn-lg px-4" disabled={!dirty || busy || offline} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
