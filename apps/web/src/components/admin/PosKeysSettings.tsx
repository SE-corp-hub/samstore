"use client";

// Settings → Keyboard shortcuts: switch the POS keys on or off and choose another key for any of them.
// Kept on this PC only (like Text size and the printer): each computer can have its own keys.

import { useEffect, useState } from "react";
import { FIXED_KEYS, keyCap, keyName, keyProblem, POS_KEY_DEFS, readPosKeys, resetPosKeys, savePosKeys, type PosAction, type PosKeys } from "../../lib/pos-keys";
import { toast } from "../../lib/toast";

export default function PosKeysSettings({ onSaved }: { onSaved?: () => void }) {
  const [cfg, setCfg] = useState<PosKeys | null>(null);
  const [listening, setListening] = useState<PosAction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { setCfg(readPosKeys()); }, []);

  const save = (v: PosKeys) => { setCfg(v); savePosKeys(v); onSaved?.(); };

  // "Change": the next key pressed becomes the key for that shortcut (Esc = keep the old one).
  useEffect(() => {
    if (!listening || !cfg) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setListening(null); setProblem(null); return; }
      const k = keyName(e);
      if (/(Control|Alt|Shift|Meta|CapsLock)$/.test(k)) return; // wait for the real key
      const bad = keyProblem(k, listening, cfg.keys);
      if (bad) { setProblem(bad); return; }
      save({ ...cfg, keys: { ...cfg.keys, [listening]: k } });
      const label = POS_KEY_DEFS.find((d) => d.id === listening)?.label ?? "";
      toast(`${label}: ${keyCap(k)}`, "success");
      setListening(null); setProblem(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, cfg]);

  if (!cfg) return null;
  return (
    <div className="pos-keys-settings">
      <p className="text-muted mb-3">For POS on a computer with a keyboard. The tablet does not change. Saved on this computer only.</p>
      <div className="settings-switch form-check form-switch mb-3">
        <input className="form-check-input" type="checkbox" role="switch" id="pk-on" checked={cfg.on} onChange={(e) => save({ ...cfg, on: e.target.checked })} />
        <label className="form-check-label fw-semibold" htmlFor="pk-on">Use keyboard shortcuts on POS</label>
        <div className="small text-muted">On: the keys work on POS and show on the buttons. Press ? on POS to see the list.</div>
      </div>
      {cfg.on && (
        <>
          {problem && <div className="alert alert-warning py-2" role="alert">{problem} Press another key, or Esc to keep the old one.</div>}
          <div className="table-responsive">
            <table className="table align-middle mb-2">
              <thead><tr><th scope="col">What it does</th><th scope="col">Key</th><th scope="col"><span className="visually-hidden">Change</span></th></tr></thead>
              <tbody>
                {POS_KEY_DEFS.map((d) => {
                  const on = listening === d.id;
                  return (
                    <tr key={d.id}>
                      <td>{d.label}<span className="d-block small text-muted">{d.when}</span></td>
                      <td className="text-nowrap" aria-live="polite">{on ? <span className="fw-semibold" style={{ color: "#0B4F8A" }}>Press a key…</span> : <kbd>{keyCap(cfg.keys[d.id])}</kbd>}</td>
                      <td className="text-end">
                        <button type="button" className={`btn ${on ? "btn-dark" : "btn-outline-primary"}`} style={{ minHeight: 44 }} aria-pressed={on}
                          aria-label={on ? `Waiting for the new key for ${d.label}. Esc keeps the old one.` : `Change the key for ${d.label}`}
                          onClick={() => { setProblem(null); setListening(on ? null : d.id); }}>
                          {on ? "Cancel" : "Change"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-outline-dark mb-3" style={{ minHeight: 44 }}
            onClick={() => { resetPosKeys(); setCfg(readPosKeys()); setListening(null); setProblem(null); onSaved?.(); toast("Keys back to the usual ones", "success"); }}>
            <i className="bi bi-arrow-counterclockwise me-1" aria-hidden="true"></i>Back to the usual keys
          </button>
          <h3 className="h6 mb-2">These keys always work the same</h3>
          <ul className="list-unstyled mb-0">
            {FIXED_KEYS.map((f) => <li key={f.key} className="mb-2"><kbd>{f.key}</kbd> <span className="ms-1">{f.label}</span></li>)}
          </ul>
        </>
      )}
    </div>
  );
}
