"use client";

// "Start a sale" / "Start a pre-order": the owner answers two questions before the price list shows —
// which store (its own prices and shelf) and who is buying. Nothing is chosen for them, so a sale can
// never go to the wrong store or the wrong customer by accident. Shared by POS and Pre-order, so both
// screens ask the same way. It sits where the price list goes (its own scroll box), so the screen still
// fits the tablet with no page scroll.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StoreOption } from "./StoreBar";

const Num = ({ n, done }: { n: number; done: boolean }) => (
  <span className={`start-num${done ? " done" : ""}`} aria-hidden="true">{done ? <i className="bi bi-check-lg"></i> : n}</span>
);

export default function StartChoices({ title, storeQuestion, locations, storeId, onStore, whoQuestion, whoDone, children, ready, goLabel, onGo }: {
  title: string;
  storeQuestion: string;
  locations: StoreOption[];
  /** The store chosen so far ("" = none yet). */
  storeId: string;
  onStore: (id: string) => void;
  whoQuestion: string;
  whoDone: boolean;
  /** The ways to answer "who": Walk-in and the customer list on POS; the list or a new name on Pre-order. */
  children: ReactNode;
  /** Both answered: the green button goes to the price list. */
  ready: boolean;
  goLabel: string;
  onGo: () => void;
}) {
  return (
    <div className="fit-scroll">
      <section className="start-card" aria-labelledby="start-title">
        <h2 id="start-title" className="h4 fw-bold mb-1">{title}</h2>
        <p className="text-muted mb-3">Answer both, then tap the rice.</p>

        <div className="start-q" role="group" aria-labelledby="start-where">
          <h3 id="start-where" className="h5 start-q-title"><Num n={1} done={!!storeId} />{storeQuestion}</h3>
          <div className="start-choices">
            {locations.map((l) => {
              const on = l.id === storeId;
              return (
                <button key={l.id} type="button" className={`btn btn-lg start-choice ${on ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={on} onClick={() => onStore(l.id)}>
                  {on && <i className="bi bi-check-circle-fill me-2" aria-hidden="true"></i>}
                  {l.code && <span className="start-code">{l.code}</span>}{l.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="start-q" role="group" aria-labelledby="start-who">
          <h3 id="start-who" className="h5 start-q-title"><Num n={2} done={whoDone} />{whoQuestion}</h3>
          {children}
        </div>

        <button type="button" className="btn btn-success btn-lg w-100 fw-bold start-go" disabled={!ready} onClick={onGo}>
          {ready
            ? <>{goLabel}<i className="bi bi-arrow-right ms-2" aria-hidden="true"></i></>
            : !storeId && !whoDone ? "Choose the store and the customer" : !storeId ? "Choose the store (1)" : "Choose who is buying (2)"}
        </button>
      </section>
    </div>
  );
}

/** After both are chosen: one short line that says where and who, with Change while nothing is in the sale yet. */
export function ChosenRow({ store, who, onChange, compact = false }: {
  store: StoreOption | undefined;
  who: string;
  /** Left out once the sale has items (the store and the customer are fixed then). */
  onChange?: () => void;
  /** Upright: only the store's code, so the row stays one line beside the steps. */
  compact?: boolean;
}) {
  const storeText = store ? (compact && store.code ? store.code : `${store.code ? `${store.code} · ` : ""}${store.name}`) : "—";
  return (
    <div className="chosen-row" aria-label="This sale is for">
      <span className="chosen-chip" title={store?.name}><i className="bi bi-shop" aria-hidden="true"></i><span className="visually-hidden">Store: </span>{storeText}</span>
      <span className="chosen-chip chosen-who"><i className="bi bi-person-fill" aria-hidden="true"></i><span className="visually-hidden">Customer: </span>{who}</span>
      {onChange && <button type="button" className="btn btn-outline-dark chosen-change" onClick={onChange}><i className="bi bi-pencil me-1" aria-hidden="true"></i>Change</button>}
    </div>
  );
}

/** Same name, any spacing or capitals: "  maria  SANTOS" matches "Maria Santos". */
export const sameName = (a: string | null | undefined, b: string) => (a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * "Not on the list? New customer": one big button in the "Who is buying?" choices. Tapped, it opens a name box
 * (mobile optional) right there; "Add and choose" puts the name on the sale. The screen decides how the name is
 * saved (at once when online, or with the sale when there is no internet), so this only asks.
 */
export function NewCustomerChoice({ chosenName, onAdd }: {
  /** The new customer already chosen for this sale (the button then shows their name with a tick). */
  chosenName?: string;
  /** Saves the name; returns an error to show under the box, or null when done. */
  onAdd: (name: string, phone: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  // Opened: the whole box (with "Add and choose") scrolls into view inside the card, and the name box gets the keyboard.
  useEffect(() => {
    if (!open) return;
    nameRef.current?.focus({ preventScroll: true });
    formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  const tooShort = name.trim().length < 2;
  const add = async () => {
    if (tooShort || busy) return;
    setBusy(true); setError(null);
    const err = await onAdd(name.trim().replace(/\s+/g, " "), phone.trim()).catch(() => "Could not add. Try again.");
    setBusy(false);
    if (err) { setError(err); return; }
    setOpen(false); setName(""); setPhone("");
  };

  if (!open) {
    const on = !!chosenName;
    return (
      <button type="button" className={`btn btn-lg start-choice new-cust ${on ? "btn-dark" : "btn-outline-success"}`} aria-pressed={on}
        onClick={() => { setName(chosenName ?? ""); setOpen(true); }}>
        <i className={`bi ${on ? "bi-check-circle-fill" : "bi-person-plus-fill"} me-2`} aria-hidden="true"></i>
        {on ? <span>{chosenName}<small>New customer · tap to change the name</small></span>
          : <span>New customer<small>Not on the list? Type the name</small></span>}
      </button>
    );
  }

  return (
    <div ref={formRef} className="new-cust-form" role="group" aria-labelledby="new-cust-title">
      <div id="new-cust-title" className="fw-bold mb-2"><i className="bi bi-person-plus-fill me-2" aria-hidden="true"></i>New customer</div>
      <label htmlFor="new-cust-name" className="form-label fw-semibold mb-1">Name</label>
      <input id="new-cust-name" ref={nameRef} className="form-control form-control-lg" autoComplete="off" autoCapitalize="words" enterKeyHint="done"
        placeholder="e.g. Aling Rosa" value={name} maxLength={80} aria-invalid={!!error} aria-describedby={error ? "new-cust-error" : undefined}
        onChange={(e) => { setName(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} />
      <label htmlFor="new-cust-phone" className="form-label fw-semibold mb-1 mt-2">Mobile <span className="fw-normal text-muted">(if they have one)</span></label>
      <input id="new-cust-phone" className="form-control form-control-lg" inputMode="tel" autoComplete="off" enterKeyHint="done"
        placeholder="09xx xxx xxxx" value={phone} maxLength={16}
        onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} />
      {error && <div id="new-cust-error" className="text-danger fw-semibold mt-2" role="alert">{error}</div>}
      <div className="new-cust-actions">
        <button type="button" className="btn btn-outline-dark btn-lg" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
        <button type="button" className="btn btn-success btn-lg fw-bold" disabled={tooShort || busy} onClick={() => void add()}>
          {busy ? "Adding…" : tooShort ? "Type the name" : "Add and choose"}
        </button>
      </div>
    </div>
  );
}
