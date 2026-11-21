"use client";
// Where a customer or an item was made: a small line under its name ("Made at Lipa · POS · Juan"), and the
// "Made at" filter for Customers and Products. See lib/added-where.ts.
import { addedWords, type AddedTag } from "../../lib/added-where";

export function AddedLine({ tag }: { tag: AddedTag }) {
  const words = addedWords(tag);
  const unknown = words === "Unknown";
  return (
    <span className={`added-line${unknown ? " added-unknown" : ""}`} title={unknown ? "Made before the app kept where" : `Made at ${words}`}>
      <i className={`bi ${unknown ? "bi-question-circle" : tag.addedAt ? "bi-shop" : "bi-person"} me-1`} aria-hidden="true"></i>
      <span className="visually-hidden">Made at: </span>{words}
    </span>
  );
}

/** "Made at" choices: every store, then not at a store, then made before (Unknown). */
export function AddedAtFilter({ value, onChange, stores, id }: { value: string; onChange: (v: string) => void; stores: { id: string; name: string }[]; id: string }) {
  return (
    <select id={id} className="form-select form-select-sm" aria-label="Made at" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Made at: every store</option>
      {stores.map((s) => <option key={s.id} value={s.id}>Made at {s.name}</option>)}
      <option value="none">Not at a store (owner, Excel, online)</option>
      <option value="unknown">Unknown (made before)</option>
    </select>
  );
}
