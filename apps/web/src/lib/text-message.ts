// Texting a customer from the staff phone.
//
// The app opens the phone's own SMS app with the message already typed (an `sms:` link).
// The person presses Send. We log "text opened" — never "sent", because only the phone knows.
// Pure builders (no browser) so the wording and the link are unit-tested.

import { API_URL } from "../config";
import { adminHeaders } from "./admin";
import { peso } from "./number-format";

/** Philippine mobile → "+639XXXXXXXXX" for the link; "" when it is not a valid mobile. */
export function phoneForLink(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/[\s\-().]/g, "");
  const m = digits.match(/^(?:\+?63|0)?(9\d{9})$/);
  return m ? `+63${m[1]}` : "";
}

/** The sms: link. iPhone separates the body with "&", Android with "?"; "?&body=" works on both. */
export function smsLink(phone: string, body: string): string {
  return `sms:${phone}?&body=${encodeURIComponent(body)}`;
}

export type TextKind = "credit_sale" | "balance" | "preorder_credit" | "payment_received";

export interface TextFacts {
  storeName: string;
  customerName?: string | null;
  /** The sale or pre-order number, when there is one. */
  reference?: string | null;
  /** This transaction's total in centavos. */
  totalMinor?: number;
  /** What was just paid in centavos (payment texts). */
  paidMinor?: number;
  /** What the customer still owes in centavos. */
  balanceMinor: number;
  items?: { name: string; qty: string }[];
}

/** The message body for each kind of text. Short on purpose: one SMS is about 160 characters. */
export function buildText(kind: TextKind, f: TextFacts): string {
  const hi = f.customerName ? `Hi ${f.customerName.split(" ")[0]}, ` : "Hi, ";
  const ref = f.reference ? ` (${f.reference})` : "";
  const items = f.items && f.items.length > 0 ? ` ${f.items.slice(0, 3).map((i) => `${i.qty} ${i.name}`).join(", ")}${f.items.length > 3 ? " …" : ""}.` : "";
  switch (kind) {
    case "credit_sale":
      return `${hi}utang${ref} ${peso(f.totalMinor ?? 0)} sa ${f.storeName}.${items} Kabuuang balanse: ${peso(f.balanceMinor)}. Salamat!`;
    case "preorder_credit":
      return `${hi}na-finalize na ang pre-order${ref}: ${peso(f.totalMinor ?? 0)} sa utang.${items} Kabuuang balanse: ${peso(f.balanceMinor)}. Salamat! — ${f.storeName}`;
    case "payment_received":
      return `${hi}natanggap namin ang bayad na ${peso(f.paidMinor ?? 0)}. ${f.balanceMinor > 0 ? `Natitirang balanse: ${peso(f.balanceMinor)}.` : "Bayad na po lahat."} Salamat! — ${f.storeName}`;
    case "balance":
      return f.balanceMinor > 0
        ? `${hi}paalala lang po: ang natitirang utang ninyo sa ${f.storeName} ay ${peso(f.balanceMinor)}. Salamat!`
        : `${hi}wala na po kayong utang sa ${f.storeName}. Salamat!`;
  }
}

/**
 * Open the phone's SMS app with the text ready, and log "text opened". Call it straight from a
 * button press so the browser lets the link open. Returns false when there is no usable number.
 */
export function openTextApp(opts: { phone: string | null | undefined; text: string; template: TextKind; storeCustomerId?: string | null; documentType?: string | null; documentId?: string | null }): boolean {
  const phone = phoneForLink(opts.phone);
  if (!phone) return false;
  void fetch(`${API_URL}/admin/sms/opened`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify({ storeCustomerId: opts.storeCustomerId ?? undefined, phone, template: opts.template, text: opts.text, documentType: opts.documentType ?? undefined, documentId: opts.documentId ?? undefined }),
  }).catch(() => { /* logging never blocks the text */ });
  window.location.href = smsLink(phone, opts.text);
  return true;
}
