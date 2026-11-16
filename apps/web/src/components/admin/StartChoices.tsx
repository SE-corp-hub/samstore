"use client";

// "Start a sale" / "Start a pre-order": the owner answers two questions before the price list shows —
// which store (its own prices and shelf) and who is buying. Nothing is chosen for them, so a sale can
// never go to the wrong store or the wrong customer by accident. Shared by POS and Pre-order, so both
// screens ask the same way. It sits where the price list goes (its own scroll box), so the screen still
// fits the tablet with no page scroll.

import type { ReactNode } from "react";
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
