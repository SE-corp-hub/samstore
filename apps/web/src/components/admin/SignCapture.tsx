"use client";

// Rice Ops M2/M3 — one signing step. Reads the action back in a full sentence, then asks
// each required person to sign, one screen per person ("Pirma ni …"). The kargador
// signs on this same phone; they never need a device. A customer signature can be
// optional (Naihatid): that screen has "Walang pirma ng customer". Returns the
// signatures for the request that performs the step — the server refuses the step if
// any required one is missing.

import { useState } from "react";
import SignaturePad from "./SignaturePad";
import { useLang } from "../../lib/lang";

export interface SignatureOut {
  signerKind: "STAFF" | "KARGADOR" | "CUSTOMER";
  kargadorId?: string;
  signerName?: string;
  imagePng: string;
}

export interface KargadorOption { id: string; name: string }

type Signer = "STAFF" | "KARGADOR" | "CUSTOMER";

export default function SignCapture({
  sentence,
  staffName,
  needKargador = false,
  kargadors = [],
  presetKargadorId,
  customer,
  busy = false,
  onDone,
  onCancel,
}: {
  sentence: string;
  staffName: string;
  needKargador?: boolean;
  kargadors?: KargadorOption[];
  /** The trip's kargador (already chosen): shown, not picked again. */
  presetKargadorId?: string | null;
  /** Ask the customer to sign too; `optional` lets staff skip when the customer is not there. */
  customer?: { name?: string | null; optional?: boolean };
  busy?: boolean;
  onDone: (signatures: SignatureOut[]) => void;
  onCancel: () => void;
}) {
  const { t } = useLang();
  const signers: Signer[] = ["STAFF", ...(needKargador ? (["KARGADOR"] as Signer[]) : []), ...(customer ? (["CUSTOMER"] as Signer[]) : [])];
  const [step, setStep] = useState(0); // 0 = read-back, then one screen per signer
  const [ink, setInk] = useState<string | null>(null);
  const [done, setDone] = useState<SignatureOut[]>([]);
  const [kargadorId, setKargadorId] = useState(presetKargadorId ?? "");
  const [customerName, setCustomerName] = useState(customer?.name ?? "");
  const current = step > 0 ? signers[step - 1] : null;
  const total = signers.length + 1;
  const kargadorName = kargadors.find((k) => k.id === kargadorId)?.name ?? "porter";
  const who = current === "KARGADOR" ? kargadorName : current === "CUSTOMER" ? (customerName || "customer") : staffName;

  const advance = (all: SignatureOut[]) => {
    setDone(all);
    setInk(null);
    if (step >= signers.length) onDone(all);
    else setStep(step + 1);
  };

  const next = () => {
    if (!current || !ink) return;
    const sig: SignatureOut =
      current === "KARGADOR" ? { signerKind: "KARGADOR", kargadorId, imagePng: ink }
      : current === "CUSTOMER" ? { signerKind: "CUSTOMER", signerName: customerName.trim(), imagePng: ink }
      : { signerKind: "STAFF", imagePng: ink };
    advance([...done, sig]);
  };

  const canFinish = !!ink && !busy
    && !(current === "KARGADOR" && !kargadorId)
    && !(current === "CUSTOMER" && customerName.trim().length < 2);

  return (
    <div className="card border-success mb-3" role="dialog" aria-label="Sign">
      <div className="card-body" style={{ fontSize: 18 }}>
        <div className="small text-muted mb-2">{t("step.of", { n: step + 1, total })}</div>
        {step === 0 ? (
          <>
            <p className="fw-semibold mb-3" style={{ fontSize: 20 }}>{sentence}</p>
            <p className="mb-3">{t("sign.readBack", { who: ((w) => w.charAt(0).toUpperCase() + w.slice(1))(signers.map((s) => (s === "STAFF" ? "staff" : s === "KARGADOR" ? "the porter" : "the customer")).join(", ")) })}</p>
          </>
        ) : (
          <>
            {current === "KARGADOR" && !presetKargadorId && (
              <div className="mb-3">
                <label className="form-label" htmlFor="sc-kargador">Which porter?</label>
                <select id="sc-kargador" className="form-select form-select-lg" value={kargadorId} onChange={(e) => setKargadorId(e.target.value)}>
                  <option value="">Choose…</option>
                  {kargadors.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
              </div>
            )}
            {current === "CUSTOMER" && (
              <div className="mb-3">
                <label className="form-label" htmlFor="sc-customer">Customer name</label>
                <input id="sc-customer" className="form-control form-control-lg" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </div>
            )}
            <h2 className="h5">{current === "STAFF" ? "Your signature (staff)" : t("sign.of", { who })}</h2>
            <SignaturePad key={step} onSignature={setInk} />
            {current === "CUSTOMER" && customer?.optional && (
              <button type="button" className="btn btn-link px-0 mt-2" disabled={busy} onClick={() => advance(done)}>
                {t("sign.noCustomer")}
              </button>
            )}
          </>
        )}
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy}
            onClick={() => { if (step === 0) onCancel(); else { setStep(step - 1); setDone(done.slice(0, Math.max(0, step - 2))); setInk(null); } }}>
            {t("btn.back")}
          </button>
          {step === 0 ? (
            <button type="button" className="btn btn-success btn-lg" onClick={() => setStep(1)}>{t("btn.yesSign")}</button>
          ) : (
            <button type="button" className="btn btn-success btn-lg" disabled={!canFinish} onClick={next}>
              {busy ? t("btn.wait") : t("btn.done")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
