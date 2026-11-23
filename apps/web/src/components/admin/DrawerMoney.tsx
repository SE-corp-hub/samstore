"use client";

// "Cash in" and "Expense" on POS: money that goes into or out of the store's drawer and is not a sale.
//   Cash in   more change put in, the owner adds money       → raises the cash the drawer should have
//   Expense   bought something with drawer money             → lowers it
// Both are on the Z-read (Cash should be = change fund + cash from customers + cash in − expenses …),
// so the count at Close day balances. With no signal the step waits on the tablet and is sent later
// with the time it was tapped.

import { useEffect, useRef, useState } from "react";
import { sendStep } from "../../lib/offlineQueue";
import { peso } from "../../lib/number-format";
import { toast } from "../../lib/toast";
import NumPad from "./NumPad";
import { KeyHint } from "./PosKeys";

export type DrawerKind = "in" | "expense";

const IN_REASONS = ["More change (panukli)", "Owner added money", "Other"];
const EXPENSE_KINDS: { id: string; label: string; icon: string }[] = [
  { id: "food", label: "Food", icon: "bi-cup-hot" },
  { id: "supplies", label: "Supplies", icon: "bi-bag" },
  { id: "transport", label: "Transport", icon: "bi-truck" },
  { id: "wages", label: "Wages", icon: "bi-people" },
  { id: "utilities", label: "Light and water", icon: "bi-lightbulb" },
  { id: "rent", label: "Rent", icon: "bi-house" },
  { id: "other", label: "Other", icon: "bi-three-dots" },
];
const toMinor = (s: string) => Math.round(Number(s.replace(/,/g, "") || "0") * 100);
const errText = (d: { message?: string; errors?: string[] } | null, fallback: string) => d?.errors?.join(", ") || d?.message || fallback;

/** The two buttons. They sit in the POS top row, so they cost no extra line. */
export function DrawerMoneyButtons({ onOpen }: { onOpen: (k: DrawerKind) => void }) {
  return (
    <>
      <button type="button" className="btn btn-outline-success drawer-btn" data-pos-key="cashIn" onClick={() => onOpen("in")}>
        <i className="bi bi-box-arrow-in-down me-1" aria-hidden="true"></i>Cash in<KeyHint action="cashIn" />
      </button>
      <button type="button" className="btn btn-outline-danger drawer-btn" data-pos-key="expense" onClick={() => onOpen("expense")}>
        <i className="bi bi-box-arrow-up me-1" aria-hidden="true"></i>Expense<KeyHint action="expense" />
      </button>
    </>
  );
}

/** The pop-up: amount on the number pad, what it is for, Save. */
export default function DrawerMoney({ kind, locationId, placeName, onClose, onSaved }: {
  kind: DrawerKind; locationId: string; placeName: string; onClose: () => void; onSaved?: () => void;
}) {
  const isIn = kind === "in";
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState(isIn ? IN_REASONS[0]! : "");
  const [category, setCategory] = useState("supplies");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const minor = toMinor(amount);
  const typed = note.trim();
  const needsNote = isIn ? reason === "Other" : true;
  const noteOk = !needsNote || typed.length >= 3;
  const canSave = minor > 0 && noteOk && !busy;
  const title = isIn ? "Cash in" : "Expense";

  const save = async () => {
    if (!canSave) { setError(minor <= 0 ? "Type the amount first." : "Write what the money was for."); return; }
    setBusy(true); setError(null);
    const at = new Date().toISOString();
    const sent = isIn
      ? await sendStep("/admin/rice/cash/in", { locationId, amountMinor: minor, note: reason === "Other" ? typed : typed ? `${reason}: ${typed}` : reason, at }, `Cash in ${peso(minor)} · ${placeName}`)
      : await sendStep("/admin/expenses", { locationId, category, amountMinor: minor, note: typed, paidFromDrawer: true, spentAt: at, fromPos: true }, `Expense ${peso(minor)} · ${placeName}`);
    setBusy(false);
    if (sent.status === "queued") {
      toast(`${title} ${peso(minor)} saved on this tablet. It sends when there is internet.`);
    } else if (!sent.ok) {
      setError(errText(sent.data, "Could not save. Try again."));
      return;
    } else {
      toast(isIn ? `Cash in ${peso(minor)} saved. The drawer should have ${peso(minor)} more.` : `Expense ${peso(minor)} saved. The drawer should have ${peso(minor)} less.`);
    }
    onSaved?.();
    onClose();
  };

  return (
    <>
      <div className="modal d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="drawer-title" style={{ zIndex: 1080 }}>
        <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-fit drawer-modal">
          <div className="modal-content rice-ui">
            <div className="modal-header py-2">
              <h2 id="drawer-title" className="h5 mb-0">
                <i className={`bi ${isIn ? "bi-box-arrow-in-down text-success" : "bi-box-arrow-up text-danger"} me-2`} aria-hidden="true"></i>
                {isIn ? "Cash in: money put into the drawer" : "Expense: money taken from the drawer"} · {placeName}
              </h2>
              <button ref={closeRef} type="button" className="btn-close" aria-label="Close" onClick={onClose} />
            </div>
            <div className="modal-body">
              <div className="drawer-grid">
                <div className="drawer-pad">
                  <NumPad value={amount} onChange={(v) => { setAmount(v); setError(null); }} decimals={2} label={isIn ? "How much went in" : "How much was spent"} unit="₱" />
                </div>
                <div className="drawer-what">
                  <div className="fw-semibold mb-1" id="drawer-what-label">{isIn ? "What is the money?" : "What was it for?"}</div>
                  <div className="drawer-chips mb-2" role="group" aria-labelledby="drawer-what-label">
                    {isIn
                      ? IN_REASONS.map((r) => (
                        <button key={r} type="button" className={`btn ${reason === r ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={reason === r} onClick={() => { setReason(r); setError(null); }}>{r}</button>
                      ))
                      : EXPENSE_KINDS.map((c) => (
                        <button key={c.id} type="button" className={`btn ${category === c.id ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                          <i className={`bi ${c.icon} me-1`} aria-hidden="true"></i>{c.label}
                        </button>
                      ))}
                  </div>
                  <label className="form-label fw-semibold mb-1" htmlFor="drawer-note">{needsNote ? "Write what it is" : "Note (if any)"}</label>
                  <input id="drawer-note" className="form-control form-control-lg" value={note} maxLength={120} autoComplete="off"
                    placeholder={isIn ? "e.g. coins from the bank" : "e.g. plastic bags, fare, ice"}
                    aria-describedby="drawer-hint" onChange={(e) => { setNote(e.target.value); setError(null); }} />
                  <p id="drawer-hint" className="small text-muted mt-2 mb-0">
                    {isIn
                      ? "This is not a sale. The cash the drawer should have goes up by this amount, so the Z-read balances."
                      : "The cash the drawer should have goes down by this amount, so the Z-read balances."}
                  </p>
                  {error && <div className="alert alert-danger py-2 mt-2 mb-0" role="alert">{error}</div>}
                </div>
              </div>
            </div>
            <div className="modal-footer py-2">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-success btn-lg flex-grow-1" data-pos-enter disabled={busy} aria-disabled={!canSave} onClick={() => void save()}>
                {busy ? "Saving…" : minor > 0 ? `Save ${title.toLowerCase()} ${peso(minor)}` : `Save ${title.toLowerCase()}`}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" style={{ zIndex: 1070 }}></div>
    </>
  );
}
