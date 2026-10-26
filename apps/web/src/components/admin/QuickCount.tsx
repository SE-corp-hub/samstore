"use client";

// Rice Ops M8 — the zero check: "Is there any left?" Count one item now; the difference
// posts at once (signed), so the counter can keep selling what is really there.

import { useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { differenceText, pesoText } from "../../lib/count-view";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import NumPad from "./NumPad";
import SignaturePad from "./SignaturePad";
import { useLang } from "../../lib/lang";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

export default function QuickCount({ productId, name, loose, locationId, onDone, onCancel, title, cancelLabel }: {
  productId: string; name: string; loose: boolean; locationId?: string | null; onDone: () => void | Promise<void>; onCancel: () => void;
  /** Heading; the POS uses the default question. */
  title?: string;
  /** Label of the left button; the POS uses "None left". */
  cancelLabel?: string;
}) {
  const { t } = useLang();
  const [value, setValue] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a difference posts, ask why (optional here: Skip is fine).
  const [saved, setSaved] = useState<{ id: string; varianceQty: number; varianceValueMinor: number; reasons: { code: string; label: string }[] } | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const finish = async (withReason: boolean) => {
    if (withReason && saved && reason) {
      setBusy(true);
      const res = await fetch(`${API_URL}/admin/counts/${saved.id}/reasons`, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ lines: [{ productId, reason, note: note.trim() || undefined }] }),
      }).catch(() => null);
      setBusy(false);
      if (!res || !res.ok) { toast("The count is saved, but the reason could not be saved"); }
    }
    toast(saved && saved.varianceQty > 0 ? "Recorded: over" : "Recorded: short");
    await onDone();
  };
  const save = async () => {
    setBusy(true); setError(null);
    const r = await sendStep("/admin/counts/quick", { productId, locationId: locationId ?? undefined, counted: loose ? (value || "0") : Number(value || "0"), signatures: [{ signerKind: "STAFF", imagePng: sig }] }, `Count: ${name}`);
    setBusy(false);
    if (r.status === "queued") { toast(t("queue.queuedToast")); await onDone(); return; }
    const d = r.data as ApiBody | null;
    if (!r.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Could not save"); return; }
    if (d?.verdict === "TAMA") { toast("The count is correct"); await onDone(); return; }
    const rawReasons = d?.reasons;
    const reasons = Array.isArray(rawReasons) ? (rawReasons as { code: string; label: string }[]) : [];
    if (!d?.id || reasons.length === 0) { toast(d?.verdict === "SOBRA" ? "Recorded: over" : "Recorded: short"); await onDone(); return; }
    setSaved({ id: String(d.id), varianceQty: Number(d.varianceQty ?? 0), varianceValueMinor: Number(d.varianceValueMinor ?? 0), reasons });
  };
  if (saved) {
    return (
      <div className="card border-warning mb-3" style={{ maxWidth: 520, fontSize: 18 }}>
        <div className="card-body">
          <h2 className="h5">{name}</h2>
          <p className="mb-2"><span className={`badge ${saved.varianceQty < 0 ? "text-bg-danger" : "text-bg-warning"}`}>{differenceText(loose, saved.varianceQty)}</span> <span className="small">{pesoText(saved.varianceValueMinor)}</span> — saved. Why?</p>
          <div className="d-flex flex-wrap gap-1 mb-2">
            {saved.reasons.map((r) => <button key={r.code} type="button" className={`btn btn-sm ${reason === r.code ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setReason(r.code)}>{r.label}</button>)}
          </div>
          {reason && <input className="form-control form-control-sm mb-2" placeholder="Add a note (optional)" aria-label="Note" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} />}
          <div className="d-flex justify-content-between mt-3">
            <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={() => void finish(false)}>Skip</button>
            <button type="button" className="btn btn-success btn-lg" disabled={busy || !reason} onClick={() => void finish(true)}>{busy ? t("btn.wait") : "Done"}</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="card border-warning mb-3" style={{ maxWidth: 520, fontSize: 18 }}>
      <div className="card-body">
        <h2 className="h5">{title ?? `${t("count.question")} — ${name}`}</h2>
        <p className="mb-2">Count what is on the shelf now{loose ? " (in kilos)" : ""}.</p>
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <NumPad value={value} onChange={setValue} decimals={loose ? 3 : 0} label="Counted" unit={loose ? "kg" : "sacks"} />
        <div className="fw-semibold mt-2">Your signature (staff)</div>
        <SignaturePad onSignature={setSig} />
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>{cancelLabel ?? t("count.none")}</button>
          <button type="button" className="btn btn-success btn-lg" disabled={busy || !sig} onClick={() => void save()}>{busy ? t("btn.wait") : t("count.save")}</button>
        </div>
      </div>
    </div>
  );
}
