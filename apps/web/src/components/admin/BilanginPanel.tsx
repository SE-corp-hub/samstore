"use client";

// Rice Ops M8 — Bilangin (counts), Manual na bawas (write-offs) and the Balance.
//   Bilangin:  anyone searches for an item and counts it, or starts a list count (everything,
//              one kind of rice, not counted lately, or picked items). They count WITHOUT seeing
//              the system's numbers, then sign; the differences post at once (no owner approval).
//              Closing: a quick count of the top 5 (posts at once).
//   Bawas:     spilled, wet, bukbok, sample, giveaway… with a photo; over 1% → the owner.
//   Balance:   per item — last count + what came in/out since = expected; Kulang in red.

import { useCallback, useEffect, useState } from "react";
import { formatKg, groupKg, sheetGroups, titleCase } from "../../lib/count-view";
import CountCheck from "./CountCheck";
import CountHome from "./CountHome";
import { API_URL } from "../../config";
import { adminHeaders, isOwnerRole } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import { photoToJpeg } from "../../lib/photo";
import SignaturePad from "./SignaturePad";
import { askConfirm } from "../../lib/ask";
import { printSlip } from "../../lib/slip-print";
import { getPrinterSettings } from "../../lib/printer-settings";

interface Loc { id: string; name: string; code: string | null; isActive: boolean }
export interface CountRow { id: string; docNumber: string; kind: string; status: string; location: string; locationId: string; lines: number; startedAt: string; kulangValueMinor: number; sobraValueMinor: number; mine?: boolean }
interface CountLine { productId: string; name: string; loose: boolean; variety?: string; unitGrams?: number | null; systemQty?: number; reasonLabel?: string | null; note?: string | null; firstCountedQty?: number | null; countedQty: number | null; expectedQty?: number | null; varianceQty?: number | null; varianceValueMinor?: number | null; verdict?: string | null }
export interface CountDetail { id: string; docNumber: string; kind: string; status: string; location: string; locationId: string; blindHidden: boolean; mine?: boolean; kulangValueMinor: number; sobraValueMinor: number; lines: CountLine[] }
interface Product { id: string; name: string; stockBaseUnit: string | null; stockBaseQuantity: number | null; isActive?: boolean }
interface BalanceItem { productId: string; name: string; loose: boolean; lastCount: { docNumber: string; countedQty: number; countedAt: string } | null; buckets: Record<string, number>; expected: number; onHand: number; reserved: number; matches: boolean; valueMinor: number }
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const peso = (m: number) => `₱${(m / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const kg = (g: number) => `${(g / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg`;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const qty = (loose: boolean, n: number) => (loose ? kg(n) : `${n}`);
const isLoose = (p?: Product) => !!p && p.stockBaseUnit === "g" && p.stockBaseQuantity === 1;
const VERDICT: Record<string, { label: string; cls: string }> = { KULANG: { label: "Short", cls: "text-bg-danger" }, SOBRA: { label: "Over", cls: "text-bg-warning" }, TAMA: { label: "Correct", cls: "text-bg-success" } };
const REASONS: [string, string][] = [["TAPON", "Spilled"], ["BASA", "Got wet"], ["BUKBOK", "Weevils"], ["SAMPLE", "Sample"], ["BIGAY", "Given away"], ["IBA", "Other"]];
const BUCKET_LABEL: Record<string, string> = { pumasok: "Stock in", lipat_papasok: "Transfer in", ibinalik: "Returned", resack_lumabas: "Resack (out)", nabenta: "Sold", lipat_palabas: "Transfer out", resack_pumasok: "Resack (in)", bawas: "Write-off", bilang: "Count", iba: "Other" };

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
}

export default function BilanginPanel({ role }: { role?: string; onNavigate?: (tab: string) => void }) {
  const owner = !!role && (isOwnerRole(role) || role === "MANAGER");
  const [tab, setTab] = useState<"counts" | "bawas" | "balance">("counts");
  const [locations, setLocations] = useState<Loc[]>([]);
  const [homeLocationId, setHomeLocationId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [open, setOpen] = useState<CountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(false); // store picked first

  useEffect(() => {
    (async () => {
      const [me, locs, ps] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      const active = ((locs?.warehouses ?? []) as Loc[]).filter((l) => l.isActive);
      setLocations(active);
      setHomeLocationId(me?.homeLocationId ?? null);
      setLocationId(me?.homeLocationId ?? "");
      setChosen(!!me?.homeLocationId);
      setProducts(((ps?.products ?? []) as Product[]).filter((p) => p.isActive !== false));
    })().catch(() => setError("Could not load"));
  }, []);

  const loadCounts = useCallback(async () => {
    if (!locationId) return;
    const res = await fetch(`${API_URL}/admin/counts?locationId=${encodeURIComponent(locationId)}`, { headers: adminHeaders() });
    if (res.ok) setCounts((await res.json()).counts as CountRow[]);
  }, [locationId]);
  useEffect(() => { void loadCounts(); }, [loadCounts]);

  const openCount = async (id: string) => {
    const res = await fetch(`${API_URL}/admin/counts/${id}`, { headers: adminHeaders() });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok) { setError(errText(d, "Could not open")); return; }
    setOpen(d as unknown as CountDetail);
  };
  const startClosing = async () => {
    const r = await post("/admin/counts/closing", { locationId });
    if (!r.ok) { setError(errText(r.data, "Could not start")); return; }
    await loadCounts();
    await openCount(String(r.data?.id));
  };

  const here = locations.find((l) => l.id === locationId);
  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
        <h1 className="h4 mb-0">Count</h1>
        {chosen && here && (homeLocationId ? <span className="badge text-bg-light border fs-6">{here.name}</span> : (
          <button type="button" className="btn btn-outline-secondary" onClick={() => { setChosen(false); setLocationId(""); setOpen(null); setCounts([]); }}>Store: {here.name} · change</button>
        ))}
      </div>
      {!chosen && (
        <>
          <h2 className="h5">Which store?</h2>
          <div className="d-grid gap-2 mb-4" style={{ maxWidth: 420 }}>
            {locations.map((l) => <button key={l.id} type="button" className="btn btn-outline-success btn-lg" onClick={() => { setLocationId(l.id); setChosen(true); }}>{l.code ? `${l.code} · ` : ""}{l.name}</button>)}
          </div>
        </>
      )}
      {chosen && <ul className="nav nav-tabs mb-3">
        <li className="nav-item"><button className={`nav-link ${tab === "counts" ? "active" : ""}`} onClick={() => setTab("counts")}>Counts</button></li>
        <li className="nav-item"><button className={`nav-link ${tab === "bawas" ? "active" : ""}`} onClick={() => setTab("bawas")}>Write-off</button></li>
        {owner && <li className="nav-item"><button className={`nav-link ${tab === "balance" ? "active" : ""}`} onClick={() => setTab("balance")}>Balance</button></li>}
      </ul>}
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {chosen && tab === "counts" && !open && (
        <CountHome locationId={locationId} owner={owner} onOpen={openCount} onChanged={loadCounts} onError={setError} onClosing={() => void startClosing()}>
          <h2 className="h6">Counts here</h2>
          <div className="list-group">
            {counts.map((c) => (
              <button key={c.id} type="button" className="list-group-item list-group-item-action d-flex justify-content-between" onClick={() => void openCount(c.id)}>
                <span><span className="fw-semibold">{c.docNumber}</span> · {c.kind === "FULL" ? "Full" : c.kind === "PARTIAL" ? "List" : c.kind === "CLOSING" ? "Closing" : "Quick"} · {c.lines} items{c.mine && c.status === "OPEN" && <span className="badge text-bg-light border ms-2">Yours</span>}<span className="d-block small text-muted">{new Date(c.startedAt).toLocaleString("en-PH")}</span></span>
                <span className="text-end">
                  <span className={`badge ${c.status === "OPEN" ? "text-bg-primary" : c.status === "SUBMITTED" ? "text-bg-warning" : c.status === "APPROVED" ? "text-bg-success" : "text-bg-secondary"}`}>{c.status === "OPEN" ? "Open" : c.status === "SUBMITTED" ? "With the owner" : c.status === "APPROVED" ? "Posted" : "Cancelled"}</span>
                  {c.status !== "OPEN" && c.kulangValueMinor > 0 && <span className="d-block small text-danger">Short {peso(c.kulangValueMinor)}</span>}
                </span>
              </button>
            ))}
            {counts.length === 0 && <p className="text-muted">No counts here yet.</p>}
          </div>
        </CountHome>
      )}

      {chosen && tab === "counts" && open && <CountSheet count={open} owner={owner} onClose={async () => { setOpen(null); await loadCounts(); }} onReload={() => void openCount(open.id)} />}
      {chosen && tab === "bawas" && <WriteOffForm locationId={locationId} products={products} />}
      {chosen && tab === "balance" && owner && <BalanceView locationId={locationId} />}
    </div>
  );
}

export function CountSheet({ count, owner, onClose, onReload }: { count: CountDetail; owner: boolean; onClose: () => void; onReload: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(count.lines.filter((l) => l.countedQty !== null).map((l) => [l.productId, l.loose ? String((l.countedQty ?? 0) / 1000) : String(l.countedQty)])));
  const [checking, setChecking] = useState(false); // the check step: differences, count again, reasons, signature
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = count.status === "OPEN";
  const done = count.lines.filter((l) => (values[l.productId] ?? "") !== "").length;
  const [find, setFind] = useState("");
  const [onlyLeft, setOnlyLeft] = useState(false);
  const [result, setResult] = useState<string | null>(null); // shown after submitting
  const [storeName, setStoreName] = useState("");
  const [printNow, setPrintNow] = useState(false);
  // A list count may leave items uncounted; the quick and closing counts must be counted in full.
  const wholeListOnly = count.kind === "QUICK" || count.kind === "CLOSING";
  const canCancel = owner || !!count.mine;
  useEffect(() => { void fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => setStoreName(d?.store?.name ?? "")).catch(() => {}); }, []);
  const shown = count.lines.filter((l) => (!find.trim() || l.name.toLowerCase().includes(find.trim().toLowerCase())) && (!onlyLeft || (values[l.productId] ?? "") === ""));
  const printSheet = () => printSlip({
    storeName: storeName || "SAM STORE", title: result ? "COUNT SUBMITTED" : editable ? "COUNT SHEET" : "COUNT RESULT", reference: count.docNumber, when: new Date().toLocaleString("en-PH"),
    lines: [{ label: "Store", value: count.location }],
    rows: count.lines.map((l) => ({
      name: l.name,
      qty: editable ? (values[l.productId] ? `${values[l.productId]} ${l.loose ? "kg" : ""}`.trim() : "______") : (l.countedQty !== null ? qty(l.loose, l.countedQty) : "—"),
      note: !editable && l.verdict ? `${VERDICT[l.verdict]?.label ?? ""}${l.varianceQty ? ` ${l.varianceQty > 0 ? "+" : ""}${qty(l.loose, l.varianceQty)}` : ""}${l.reasonLabel ? ` - ${l.reasonLabel}` : ""}${l.note ? ` (${l.note})` : ""}` : undefined,
    })),
    totals: editable ? [] : [{ label: "Short", value: peso(count.kulangValueMinor) }, { label: "Over", value: peso(count.sobraValueMinor) }],
    signatures: [{ role: "Counted by", name: "" }], widthMm: 58,
  });

  useEffect(() => { if (printNow && result) { setPrintNow(false); if (getPrinterSettings().autoPrint) printSheet(); } }); // eslint-disable-line react-hooks/exhaustive-deps

  /** Save what is typed, 40 lines at a time (a long sheet stays quick on a slow connection). */
  const saveLines = async (): Promise<boolean> => {
    const lines = count.lines.filter((l) => (values[l.productId] ?? "") !== "").map((l) => ({ productId: l.productId, counted: l.loose ? values[l.productId] : Number(values[l.productId]) }));
    for (let i = 0; i < lines.length; i += 40) {
      const r = await post(`/admin/counts/${count.id}/lines`, { lines: lines.slice(i, i + 40) });
      if (!r.ok) { setError(errText(r.data, "Could not save")); return false; }
    }
    return true;
  };
  /** Save what is typed. "Check the count" saves, then shows the differences before anything is submitted. */
  const save = async (andCheck: boolean) => {
    setError(null);
    setBusy(true);
    if (!(await saveLines())) { setBusy(false); return; }
    setBusy(false);
    if (andCheck) { setChecking(true); return; }
    toast("Saved");
    onReload();
  };
  const submitted = (data: { status?: unknown; skipped?: unknown }) => {
    toast(data.status === "APPROVED" ? "Count posted" : "Submitted — waiting for the owner");
    const skipped = Number(data.skipped ?? 0);
    setChecking(false);
    setResult(data.status === "APPROVED" ? `Count posted. The stock now matches what you counted.${skipped ? ` ${skipped} item${skipped === 1 ? " was" : "s were"} not counted and stay${skipped === 1 ? "s" : ""} as ${skipped === 1 ? "it is" : "they are"}.` : ""}` : "Submitted. The owner will check it, then the differences are posted.");
    setPrintNow(true);
  };
  const cancel = async () => {
    if (!(await askConfirm(`Cancel ${count.docNumber}?`, { ok: `Cancel ${count.docNumber}`, danger: true }))) return;
    const r = await post(`/admin/counts/${count.id}/cancel`, {});
    if (!r.ok) { setError(errText(r.data, "Could not cancel")); return; }
    onClose();
  };

  if (result) {
    return (
      <div style={{ maxWidth: 720 }}>
        <div className="alert alert-success"><strong>{count.docNumber}</strong> — {result}<div className="mt-1">You counted {done} of {count.lines.length} items.</div></div>
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-dark btn-lg" onClick={printSheet}><i className="bi bi-printer me-1"></i>Print count slip</button>
          <button type="button" className="btn btn-outline-secondary btn-lg" onClick={onClose}>← Counts</button>
        </div>
      </div>
    );
  }
  if (checking) return <CountCheck countId={count.id} docNumber={count.docNumber} onBack={() => setChecking(false)} onSubmitted={submitted} />;
  const groups = sheetGroups(shown);
  const showHeadings = groups.length > 1 || (groups[0]?.variety ?? "") !== "";
  return (
    <div style={{ maxWidth: 720 }}>
      <button type="button" className="btn btn-link px-0 mb-2" onClick={onClose}>← Counts</button>
      <h2 className="h5">{count.docNumber} · {count.location}</h2>
      {editable && (
        <>
          <p className="mb-2">Count <strong>what is on the shelf</strong>. {count.blindHidden ? "The system's numbers are hidden." : ""}{!wholeListOnly && " You can leave items you did not count."}</p>
          <div className="progress mb-1" style={{ height: 10 }} role="progressbar" aria-label="Counted so far" aria-valuenow={done} aria-valuemin={0} aria-valuemax={count.lines.length}>
            <div className="progress-bar bg-success" style={{ width: `${count.lines.length ? (done * 100) / count.lines.length : 0}%` }} />
          </div>
          <div className="small mb-2">{done} of {count.lines.length} counted{done === count.lines.length ? " — ready to sign" : ""}</div>
          <div className="d-flex flex-wrap gap-2 mb-2">
            <input className="form-control" style={{ maxWidth: 260 }} placeholder="Find an item…" aria-label="Find an item" value={find} onChange={(e) => setFind(e.target.value.slice(0, 40))} />
            <div className="form-check form-switch align-self-center mb-0">
              <input className="form-check-input" type="checkbox" id="ct-left" checked={onlyLeft} onChange={(e) => setOnlyLeft(e.target.checked)} />
              <label className="form-check-label" htmlFor="ct-left">Only not counted yet</label>
            </div>
            <button type="button" className="btn btn-outline-secondary ms-auto" onClick={printSheet}>Print count sheet</button>
          </div>
        </>
      )}
      {!editable && count.status !== "CANCELLED" && <p>Short <strong className="text-danger">{peso(count.kulangValueMinor)}</strong> · Over <strong>{peso(count.sobraValueMinor)}</strong></p>}
      {error && <div className="alert alert-danger py-2">{error}</div>}
      {shown.length === 0 && <p className="text-muted">{onlyLeft && !find.trim() ? "Everything is counted." : "No item matches."}</p>}
      {groups.map((g) => {
        const kgNow = editable ? groupKg(g.lines, values) : null;
        return (
          <div key={g.variety || "other"} className="mb-3">
            {showHeadings && (
              <div className="d-flex justify-content-between align-items-baseline px-1 mb-1">
                <h3 className="h6 mb-0">{g.variety ? titleCase(g.variety) : "Other items"}</h3>
                {kgNow !== null && <span className="small text-muted">Counted so far: {formatKg(kgNow)}</span>}
              </div>
            )}
            <ul className="list-group" style={{ fontVariantNumeric: "tabular-nums" }}>
              {g.lines.map((l) => (
                <li key={l.productId} className="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                  <span>{l.name}{editable && l.systemQty !== undefined && <span className="text-muted small"> (system {qty(l.loose, l.systemQty)})</span>}</span>
                  {editable ? (
                    <div className="input-group" style={{ maxWidth: 200 }}>
                      <input className="form-control form-control-lg text-end" inputMode="decimal" aria-label={`Count of ${l.name}`} value={values[l.productId] ?? ""}
                        onChange={(e) => setValues({ ...values, [l.productId]: e.target.value.replace(l.loose ? /[^\d.]/g : /\D/g, "").slice(0, 10) })} />
                      <span className="input-group-text">{l.loose ? "kg" : "sacks"}</span>
                    </div>
                  ) : (
                    <span>
                      {l.countedQty !== null && qty(l.loose, l.countedQty)}
                      {l.expectedQty !== undefined && l.expectedQty !== null && <span className="text-muted small"> (system {qty(l.loose, l.expectedQty)})</span>}
                      {l.verdict && <span className={`badge ms-2 ${VERDICT[l.verdict]?.cls}`}>{VERDICT[l.verdict]?.label}{l.varianceQty ? ` ${l.varianceQty > 0 ? "+" : ""}${qty(l.loose, l.varianceQty)}` : ""}</span>}
                      {!!l.varianceValueMinor && <span className="small ms-1">{peso(l.varianceValueMinor)}</span>}
                      {l.reasonLabel && <span className="d-block small text-muted">{l.reasonLabel}{l.note ? ` · ${l.note}` : ""}</span>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {editable && (
        <>
          <div className="d-flex flex-wrap justify-content-between gap-2 mt-2">
            <button type="button" className="btn btn-outline-dark btn-lg" disabled={busy} onClick={() => void save(false)}>Save for now</button>
            <button type="button" className="btn btn-success btn-lg" disabled={busy || done === 0 || (wholeListOnly && done < count.lines.length)} onClick={() => void save(true)}>{busy ? "Please wait…" : "Check the count"}</button>
          </div>
          {canCancel && <div className="mt-3"><button type="button" className="btn btn-link text-secondary px-0" disabled={busy} onClick={() => void cancel()}>Cancel {count.docNumber}</button></div>}
        </>
      )}
    </div>
  );
}

function WriteOffForm({ locationId, products }: { locationId: string; products: Product[] }) {
  const [productId, setProductId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [sigKey, setSigKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = products.find((x) => x.id === productId);
  const ready = !!p && Number(amount) > 0 && !!reason && (reason !== "IBA" || note.trim().length >= 3) && !!sig && !busy;
  const save = async () => {
    setBusy(true); setError(null);
    const signatures = [{ signerKind: "STAFF", imagePng: sig }, ...(photo ? [{ signerKind: "SLIP_PHOTO", imagePng: photo }] : [])];
    const sent = await sendStep("/admin/write-offs", { locationId, productId, ...(isLoose(p) ? { kilos: amount } : { quantity: Number(amount) }), reason, note: note.trim() || undefined, signatures }, `Write-off: ${p?.name ?? ""}`);
    setBusy(false);
    if (sent.status === "queued") { toast("No signal — saved on this phone, will be sent when the signal is back"); setProductId(""); setAmount(""); setReason(""); setNote(""); setPhoto(null); setSig(null); setSigKey((k) => k + 1); return; }
    const r = { ok: sent.ok, data: sent.data as ApiBody | null };
    if (!r.ok) { setError(errText(r.data, "Could not write off")); return; }
    toast(r.data?.needsApproval ? `Written off (${String(r.data?.docNumber)}) — over 1%, the owner was told` : `Written off: ${String(r.data?.docNumber)}`);
    setProductId(""); setAmount(""); setReason(""); setNote(""); setPhoto(null); setSig(null); setSigKey((k) => k + 1);
  };
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div className="card-body">
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <label className="form-label" htmlFor="wo-p">Product</label>
        <select id="wo-p" className="form-select form-select-lg mb-2" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">Choose…</option>
          {products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <label className="form-label" htmlFor="wo-q">How much to write off ({isLoose(p) ? "kilos" : "sacks/pieces"})</label>
        <input id="wo-q" className="form-control form-control-lg mb-2" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(isLoose(p) ? /[^\d.]/g : /\D/g, "").slice(0, 10))} />
        <div className="d-grid gap-2 mb-2" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          {REASONS.map(([k, label]) => <button key={k} type="button" className={`btn ${reason === k ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setReason(k)}>{label}</button>)}
        </div>
        {reason === "IBA" && <input className="form-control form-control-lg mb-2" placeholder="Reason" aria-label="Reason" value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} />}
        <label className="form-label" htmlFor="wo-photo">Photo (if any)</label>
        <input id="wo-photo" type="file" accept="image/*" capture="environment" className="form-control mb-2"
          onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setPhoto(await photoToJpeg(f)); } catch (err) { setError(err instanceof Error ? err.message : "Could not read the photo"); } }} />
        <div className="fw-semibold">Your signature (staff)</div>
        <SignaturePad key={sigKey} onSignature={setSig} />
        <button type="button" className="btn btn-success btn-lg w-100 mt-3" disabled={!ready} onClick={() => void save()}>{busy ? "Please wait…" : "Write off"}</button>
      </div>
    </div>
  );
}

function BalanceView({ locationId }: { locationId: string }) {
  const [items, setItems] = useState<BalanceItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!locationId) return;
    void fetch(`${API_URL}/admin/counts/balance?locationId=${encodeURIComponent(locationId)}`, { headers: adminHeaders() })
      .then(async (r) => { const d = await r.json().catch(() => null); if (!r.ok) setError(errText(d, "Could not load")); else setItems(d.items as BalanceItem[]); });
  }, [locationId]);
  return (
    <div className="table-responsive">
      {error && <div className="alert alert-danger py-2">{error}</div>}
      <table className="table table-sm align-middle" style={{ fontVariantNumeric: "tabular-nums" }}>
        <thead><tr><th>Item</th><th>Last count</th><th>Moves since then</th><th className="text-end">Should have</th><th className="text-end">In the system</th><th className="text-end">Value</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.productId}>
              <td>{i.name}{!i.matches && <span className="badge text-bg-danger ms-1">Does not match</span>}</td>
              <td className="small">{i.lastCount ? `${qty(i.loose, i.lastCount.countedQty)} (${i.lastCount.docNumber})` : "none yet"}</td>
              <td className="small">{Object.entries(i.buckets).filter(([, v]) => v !== 0).map(([k, v]) => `${BUCKET_LABEL[k] ?? k} ${v > 0 ? "+" : ""}${qty(i.loose, v)}`).join(" · ") || "—"}</td>
              <td className="text-end">{qty(i.loose, i.expected)}</td>
              <td className="text-end">{qty(i.loose, i.onHand)}{i.reserved > 0 && <span className="d-block small text-muted">reserved {qty(i.loose, i.reserved)}</span>}</td>
              <td className="text-end">{peso(i.valueMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small text-muted">A “short” shows up when you count. “Does not match” is a system problem — report it right away.</p>
    </div>
  );
}
