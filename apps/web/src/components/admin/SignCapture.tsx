"use client";

// Rice Ops M2 — one signing step. Reads the action back in a full sentence, then asks
// each required person to sign, one screen per person ("Pirma ni …"). The kargador
// signs on this same phone; they never need a device. Returns the signatures for the
// request that performs the step — the server refuses the step if any are missing.

import { useState } from "react";
import SignaturePad from "./SignaturePad";

export interface SignatureOut {
  signerKind: "STAFF" | "KARGADOR" | "CUSTOMER";
  kargadorId?: string;
  signerName?: string;
  imagePng: string;
}

export interface KargadorOption { id: string; name: string }

export default function SignCapture({
  sentence,
  staffName,
  needKargador = false,
  kargadors = [],
  busy = false,
  onDone,
  onCancel,
}: {
  sentence: string;
  staffName: string;
  needKargador?: boolean;
  kargadors?: KargadorOption[];
  busy?: boolean;
  onDone: (signatures: SignatureOut[]) => void;
  onCancel: () => void;
}) {
  // step 0 = read-back, then one screen per signer
  const signers: ("STAFF" | "KARGADOR")[] = needKargador ? ["STAFF", "KARGADOR"] : ["STAFF"];
  const [step, setStep] = useState(0);
  const [ink, setInk] = useState<string | null>(null);
  const [done, setDone] = useState<SignatureOut[]>([]);
  const [kargadorId, setKargadorId] = useState("");
  const current = step > 0 ? signers[step - 1] : null;
  const total = signers.length + 1;
  const who = current === "KARGADOR" ? (kargadors.find((k) => k.id === kargadorId)?.name ?? "kargador") : staffName;

  const next = () => {
    if (!current || !ink) return;
    const sig: SignatureOut = current === "KARGADOR" ? { signerKind: "KARGADOR", kargadorId, imagePng: ink } : { signerKind: "STAFF", imagePng: ink };
    const all = [...done, sig];
    setDone(all);
    setInk(null);
    if (step >= signers.length) onDone(all);
    else setStep(step + 1);
  };

  return (
    <div className="card border-success mb-3" role="dialog" aria-label="Pirmahan">
      <div className="card-body" style={{ fontSize: 18 }}>
        <div className="small text-muted mb-2">Hakbang {step + 1} sa {total}</div>
        {step === 0 ? (
          <>
            <p className="fw-semibold mb-3" style={{ fontSize: 20 }}>{sentence}</p>
            <p className="mb-3">Tama ba? Pipirma {needKargador ? "ang staff at ang kargador" : "ang staff"} sa phone na ito.</p>
          </>
        ) : (
          <>
            {current === "KARGADOR" && (
              <div className="mb-3">
                <label className="form-label" htmlFor="sc-kargador">Sinong kargador?</label>
                <select id="sc-kargador" className="form-select form-select-lg" value={kargadorId} onChange={(e) => setKargadorId(e.target.value)}>
                  <option value="">Pumili…</option>
                  {kargadors.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
              </div>
            )}
            <h2 className="h5">Pirma ni {who}</h2>
            <SignaturePad key={step} onSignature={setInk} />
          </>
        )}
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy}
            onClick={() => { if (step === 0) onCancel(); else { setStep(step - 1); setDone(done.slice(0, -1)); setInk(null); } }}>
            Bumalik
          </button>
          {step === 0 ? (
            <button type="button" className="btn btn-success btn-lg" onClick={() => setStep(1)}>Oo, pipirma</button>
          ) : (
            <button type="button" className="btn btn-success btn-lg" disabled={busy || !ink || (current === "KARGADOR" && !kargadorId)} onClick={next}>
              {busy ? "Sandali…" : "Tapos"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
