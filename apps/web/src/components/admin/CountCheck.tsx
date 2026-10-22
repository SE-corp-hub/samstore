"use client";

// Rice Ops — the check step of a count, before it is submitted: only the items that differ, each with
// the difference, "Count again" (once is enough; the first number is kept) and the reason why.
// Reasons are labels recorded by hand: they never create a sale, a write-off or a charge.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { differenceText } from "../../lib/count-view";
import { photoToJpeg } from "../../lib/photo";
import { toast } from "../../lib/toast";
import SignaturePad from "./SignaturePad";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const peso = (m: number) => `₱${(Math.abs(m) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (loose: boolean, n: number) => (loose ? `${(n / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : `${n}`);

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...adminHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
}

interface DiffLine {
  productId: string; name: string; loose: boolean; countedQty: number; expectedQty: number; varianceQty: number; varianceValueMinor: number;
  firstCountedQty: number | null; reason: string | null; note: string | null; reasons: { code: string; label: string }[]; asksRecount: boolean;
}
interface Check { id: string; docNumber: string; counted: number; correct: number; notCounted: number; recountLimitMinor: number; lookLimitMinor: number; lines: DiffLine[] }

export default function CountCheck({ countId, docNumber, onBack, onSubmitted }: {
  countId: string; docNumber: string; onBack: () => void; onSubmitted: (data: ApiBody) => void;
}) {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState<{ productId: string; value: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sig, setSig] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call("GET", `/admin/counts/${countId}/check`);
    if (!r.ok) { setError(errText(r.data, "Could not check the count")); return; }
    const c = r.data as unknown as Check;
    setCheck(c);
    setNotes((cur) => ({ ...Object.fromEntries(c.lines.map((l) => [l.productId, l.note ?? ""])), ...cur }));
  }, [countId]);
  useEffect(() => { void load(); }, [load]);

  const setReason = async (l: DiffLine, reason: string) => {
    setError(null);
    setCheck((c) => c && { ...c, lines: c.lines.map((x) => (x.productId === l.productId ? { ...x, reason } : x)) });
    const r = await call("POST", `/admin/counts/${countId}/reasons`, { lines: [{ productId: l.productId, reason, note: notes[l.productId] || undefined }] });
    if (!r.ok) { setError(errText(r.data, "Could not save the reason")); await load(); }
  };
  const saveNote = async (l: DiffLine) => {
    if (!l.reason || (notes[l.productId] ?? "") === (l.note ?? "")) return;
    const r = await call("POST", `/admin/counts/${countId}/reasons`, { lines: [{ productId: l.productId, reason: l.reason, note: notes[l.productId] || undefined }] });
    if (!r.ok) setError(errText(r.data, "Could not save the note")); else await load();
  };
  const recount = async () => {
    if (!again) return;
    const l = check?.lines.find((x) => x.productId === again.productId);
    if (!l || again.value.trim() === "") return;
    setBusy(true); setError(null);
    const r = await call("POST", `/admin/counts/${countId}/lines`, { lines: [{ productId: l.productId, counted: l.loose ? again.value : Number(again.value) }] });
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "Could not save")); return; }
    setAgain(null);
    toast("Counted again");
    await load();
  };
  const takePhoto = async (file: File | undefined) => {
    if (!file) return;
    try { setPhoto(await photoToJpeg(file)); } catch (e) { setError(e instanceof Error ? e.message : "Could not read the photo"); }
  };
  const submit = async () => {
    setBusy(true); setError(null);
    const signatures: { signerKind: string; imagePng: string | null }[] = [{ signerKind: "STAFF", imagePng: sig }];
    if (photo) signatures.push({ signerKind: "SLIP_PHOTO", imagePng: photo });
    const r = await call("POST", `/admin/counts/${countId}/submit`, { signatures });
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "Could not submit")); return; }
    onSubmitted(r.data ?? {});
  };

  if (!check) return <div style={{ maxWidth: 720 }}>{error ? <div className="alert alert-danger">{error}</div> : <p className="text-muted">Checking the count…</p>}<button type="button" className="btn btn-outline-secondary" onClick={onBack}>← Back to counting</button></div>;
  const noReason = check.lines.filter((l) => !l.reason).length;
  const needPhoto = check.lines.some((l) => Math.abs(l.varianceValueMinor) >= check.lookLimitMinor && check.lookLimitMinor > 0);
  return (
    <div style={{ maxWidth: 720 }}>
      <button type="button" className="btn btn-link px-0 mb-2" onClick={onBack}>← Back to counting</button>
      <h2 className="h5">{docNumber} · Check the count</h2>
      <p className="mb-2">
        {check.counted} item{check.counted === 1 ? "" : "s"} counted · <strong className="text-success">{check.correct} correct</strong> · <strong className={check.lines.length ? "text-danger" : ""}>{check.lines.length} differ{check.lines.length === 1 ? "s" : ""}</strong>
        {check.notCounted > 0 && <> · {check.notCounted} not counted (they stay as they are)</>}
      </p>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      {check.lines.length === 0 && <div className="alert alert-success">Everything you counted matches the system.</div>}
      {check.lines.map((l) => (
        <div key={l.productId} className="card mb-3">
          <div className="card-body py-2">
            <div className="d-flex flex-wrap justify-content-between align-items-start gap-2">
              <div>
                <div className="fw-semibold">{l.name}</div>
                <div className="small text-muted">
                  You counted {qty(l.loose, l.countedQty)}; the system had {qty(l.loose, l.expectedQty)}.
                  {l.firstCountedQty !== null && <> First count: {qty(l.loose, l.firstCountedQty)}.</>}
                </div>
              </div>
              <div className="text-end">
                <span className={`badge ${l.varianceQty < 0 ? "text-bg-danger" : "text-bg-warning"}`}>{differenceText(l.loose, l.varianceQty)}</span>
                <div className="small">{peso(l.varianceValueMinor)}</div>
              </div>
            </div>
            {again?.productId === l.productId ? (
              <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
                <div className="input-group" style={{ maxWidth: 200 }}>
                  <input className="form-control form-control-lg text-end" inputMode="decimal" aria-label={`Count ${l.name} again`} autoFocus value={again.value}
                    onChange={(e) => setAgain({ productId: l.productId, value: e.target.value.replace(l.loose ? /[^\d.]/g : /\D/g, "").slice(0, 10) })} />
                  <span className="input-group-text">{l.loose ? "kg" : "sacks"}</span>
                </div>
                <button type="button" className="btn btn-success" disabled={busy || again.value.trim() === ""} onClick={() => void recount()}>Save</button>
                <button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={() => setAgain(null)}>Cancel</button>
              </div>
            ) : (
              <div className="mt-2 d-flex flex-wrap align-items-center gap-2">
                <button type="button" className={`btn btn-sm ${l.asksRecount ? "btn-warning" : "btn-outline-secondary"}`} onClick={() => setAgain({ productId: l.productId, value: "" })}>Count again</button>
                {l.asksRecount && <span className="small text-danger">Big difference. Count it again to be sure.</span>}
              </div>
            )}
            <div className="fw-semibold small mt-2 mb-1">Why? {l.reason ? "" : <span className="text-danger">Choose one</span>}</div>
            <div className="d-flex flex-wrap gap-1">
              {l.reasons.map((r) => (
                <button key={r.code} type="button" className={`btn btn-sm ${l.reason === r.code ? "btn-dark" : "btn-outline-dark"}`} onClick={() => void setReason(l, r.code)}>{r.label}</button>
              ))}
            </div>
            {l.reason && (
              <input className="form-control form-control-sm mt-2" placeholder="Add a note (optional)" aria-label={`Note for ${l.name}`} maxLength={120}
                value={notes[l.productId] ?? ""} onChange={(e) => setNotes({ ...notes, [l.productId]: e.target.value })} onBlur={() => void saveNote(l)} />
            )}
          </div>
        </div>
      ))}
      {needPhoto && (
        <div className="mb-3">
          <label className="form-label fw-semibold" htmlFor="count-photo">A photo of the shelf (optional)</label>
          <input id="count-photo" className="form-control" type="file" accept="image/*" capture="environment" onChange={(e) => void takePhoto(e.target.files?.[0])} />
          {photo && <div className="small text-success mt-1">Photo added.</div>}
        </div>
      )}
      <div className="fw-semibold">Your signature (staff) — to submit</div>
      <SignaturePad onSignature={setSig} />
      <div className="d-flex justify-content-between align-items-center mt-3">
        <span className="small text-muted">{noReason > 0 ? `Choose a reason for ${noReason} item${noReason === 1 ? "" : "s"}.` : ""}</span>
        <button type="button" className="btn btn-success btn-lg" disabled={busy || !sig || noReason > 0} onClick={() => void submit()}>{busy ? "Please wait…" : "Submit the count"}</button>
      </div>
    </div>
  );
}
