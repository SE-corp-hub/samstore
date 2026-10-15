"use client";

// Rice Ops M8 — the zero check: "May natira pa ba?" Count one item now; the difference
// posts at once (signed), so the counter can keep selling what is really there.

import { useState } from "react";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import NumPad from "./NumPad";
import SignaturePad from "./SignaturePad";
import { useLang } from "../../lib/lang";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

export default function QuickCount({ productId, name, loose, locationId, onDone, onCancel }: {
  productId: string; name: string; loose: boolean; locationId?: string | null; onDone: () => void | Promise<void>; onCancel: () => void;
}) {
  const { t } = useLang();
  const [value, setValue] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    const r = await sendStep("/admin/counts/quick", { productId, locationId: locationId ?? undefined, counted: loose ? (value || "0") : Number(value || "0"), signatures: [{ signerKind: "STAFF", imagePng: sig }] }, `Bilang: ${name}`);
    setBusy(false);
    if (r.status === "queued") { toast(t("queue.queuedToast")); await onDone(); return; }
    const d = r.data as ApiBody | null;
    if (!r.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Hindi na-save"); return; }
    toast(d?.verdict === "TAMA" ? "Tama ang bilang" : d?.verdict === "SOBRA" ? "Naitala: may sobra" : "Naitala: may kulang");
    await onDone();
  };
  return (
    <div className="card border-warning mb-3" style={{ maxWidth: 520, fontSize: 18 }}>
      <div className="card-body">
        <h2 className="h5">{t("count.question")} — {name}</h2>
        <p className="mb-2">Bilangin ang nasa estante ngayon{loose ? " (sa kilo)" : ""}.</p>
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <NumPad value={value} onChange={setValue} decimals={loose ? 3 : 0} label="Nabilang" unit={loose ? "kg" : "sako"} />
        <div className="fw-semibold mt-2">Pirma mo (staff)</div>
        <SignaturePad onSignature={setSig} />
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>{t("count.none")}</button>
          <button type="button" className="btn btn-success btn-lg" disabled={busy || !sig} onClick={() => void save()}>{busy ? t("btn.wait") : t("count.save")}</button>
        </div>
      </div>
    </div>
  );
}
