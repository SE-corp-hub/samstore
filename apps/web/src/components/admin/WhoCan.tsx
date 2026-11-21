"use client";

// The two small pieces every editing screen shows (2026-11-21, owner: "it isn't clear which store or
// setting is being changed, or who can change what"):
// - ScopeTag: at the top of a form, where the change lands ("Whole business: every store",
//   "Only Bogs and Lucy", "Only this tablet", "Only you").
// - LockNote: under a form a login cannot change, one line saying who can.
// The words come from lib/who-can.ts, the one table the server test checks too.

import { SCOPE_LABEL, type Scope } from "../../lib/who-can";

const ICON: Record<Scope, string> = { business: "bi-buildings", store: "bi-shop", tablet: "bi-tablet", me: "bi-person" };

/** `storeName` for a one-store form. */
export function ScopeTag({ scope, storeName }: { scope: Scope; storeName?: string | null }) {
  const text =
    scope === "store" ? (storeName ? `Only ${storeName}` : SCOPE_LABEL.store)
    : scope === "business" ? "Whole business: every store"
    : SCOPE_LABEL[scope];
  return (
    <p className={`scope-tag scope-${scope}`}>
      <i className={`bi ${ICON[scope]}`} aria-hidden="true"></i>
      <span><span className="visually-hidden">Changes here apply to: </span>{text}</span>
    </p>
  );
}

/** One line under a locked form: who may change it. */
export function LockNote({ text }: { text: string }) {
  return (
    <p className="lock-note" role="note">
      <i className="bi bi-lock-fill" aria-hidden="true"></i>
      <span>{text} You can look but not change it.</span>
    </p>
  );
}
