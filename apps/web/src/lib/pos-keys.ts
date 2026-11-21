// POS keyboard shortcuts for a PC (2026-11-21).
//
// On a PC with a keyboard the cashier can run the whole sale from the keys: F1 search, F2 Cash in,
// F3 Expense, F4 Hold, F8 next step (Pay → Correct → Finish sale) and so on. The tablet is not
// touched: the key hints show only where a mouse is (desktop.css gate), and the keys do nothing
// without a keyboard anyway. The owner can switch them off or choose other keys in Settings →
// Keyboard shortcuts; the choice is kept on that PC only (localStorage), like the Text size.
//
// The POS buttons carry `data-pos-key="<action>"`; a key press clicks the visible, enabled button
// with that action, so each shortcut does exactly what the button does (no second code path).

import { useEffect, useState } from "react";

export type PosAction =
  | "search" | "cashIn" | "expense" | "hold" | "held" | "openSacks" | "next" | "xread"
  | "cash" | "gcash" | "credit" | "exact" | "toDrawer" | "toOwner" | "print" | "newSale" | "more" | "less" | "removeLast" | "help";

export interface PosKeyDef { id: PosAction; label: string; when: string; key: string }

/** Every shortcut, in the order of the sale, with its default key. */
export const POS_KEY_DEFS: PosKeyDef[] = [
  { id: "search", label: "Search the price list", when: "Pick items", key: "F1" },
  { id: "cashIn", label: "Cash in", when: "Pick items", key: "F2" },
  { id: "expense", label: "Expense", when: "Pick items", key: "F3" },
  { id: "hold", label: "Hold this sale", when: "Pick items", key: "F4" },
  { id: "held", label: "Held sales", when: "Pick items", key: "F9" },
  { id: "openSacks", label: "Open sacks", when: "Pick items", key: "Ctrl+O" },
  { id: "more", label: "One more of the last line", when: "Pick items", key: "+" },
  { id: "less", label: "One less of the last line", when: "Pick items", key: "-" },
  { id: "removeLast", label: "Take out the last line", when: "Pick items", key: "Delete" },
  { id: "next", label: "Next step: Pay · Correct · Finish sale", when: "Every step", key: "F8" },
  { id: "xread", label: "X-read", when: "Day open", key: "F10" },
  { id: "cash", label: "Pay with Cash", when: "Pay", key: "C" },
  { id: "gcash", label: "Pay with GCash", when: "Pay", key: "G" },
  { id: "credit", label: "Pay on Credit", when: "Pay", key: "U" },
  { id: "exact", label: "Exact cash", when: "Pay", key: "X" },
  { id: "toDrawer", label: "Cash goes in the store drawer", when: "Pay (owner)", key: "D" },
  { id: "toOwner", label: "I keep the cash (owner)", when: "Pay (owner)", key: "O" },
  { id: "print", label: "Print receipt", when: "Sold", key: "P" },
  { id: "newSale", label: "New sale", when: "Sold", key: "N" },
  { id: "help", label: "Show this list", when: "Any time", key: "?" },
];

/** Keys that always work the same way and cannot be given to a shortcut. */
export const FIXED_KEYS: { key: string; label: string }[] = [
  { key: "Enter", label: "Same as the green button (Pay, Correct, Finish sale, Save, New sale). In the search box: add the first item found." },
  { key: "Esc", label: "Back / close (the price card, Check, Pay, Held sales). In the search box: clear it." },
  { key: "0-9 . ⌫", label: "Type on the number pad that is open (price, kilos, cash received)." },
  { key: "A-Z", label: "Start typing a rice name: it goes into the search box." },
];
const RESERVED = new Set(["Enter", "Escape", "Backspace", "Tab", " ", "F5", "F6", "F11", "F12", ".", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

export interface PosKeys { on: boolean; keys: Record<PosAction, string> }
const STORE_KEY = "sam.posKeys";
const EVENT = "sam-pos-keys";
const defaults = (): Record<PosAction, string> => Object.fromEntries(POS_KEY_DEFS.map((d) => [d.id, d.key])) as Record<PosAction, string>;

export function readPosKeys(): PosKeys {
  const keys = defaults();
  try {
    const v = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "null") as { on?: unknown; keys?: Record<string, unknown> } | null;
    if (v?.keys) for (const d of POS_KEY_DEFS) { const k = v.keys[d.id]; if (typeof k === "string" && k) keys[d.id] = k; }
    return { on: v?.on !== false, keys };
  } catch { return { on: true, keys }; }
}

export function savePosKeys(v: PosKeys): void {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* per-PC convenience only */ }
  window.dispatchEvent(new Event(EVENT));
}

export function resetPosKeys(): void {
  try { window.localStorage.removeItem(STORE_KEY); } catch { /* per-PC convenience only */ }
  window.dispatchEvent(new Event(EVENT));
}

/** The shortcuts on this PC; follows changes made in Settings (also from another tab). */
export function usePosKeys(): PosKeys {
  const [v, setV] = useState<PosKeys>(() => ({ on: true, keys: defaults() }));
  useEffect(() => {
    const load = () => setV(readPosKeys());
    load();
    const onStorage = (e: StorageEvent) => { if (e.key === STORE_KEY) load(); };
    window.addEventListener(EVENT, load);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(EVENT, load); window.removeEventListener("storage", onStorage); };
  }, []);
  return v;
}

/** One name per key press: "F2", "C", "+", "Delete", "Ctrl+S". Letters are upper case, so C and c are one key. */
export function keyName(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey">): string {
  let k = e.key;
  if (k === "Esc") k = "Escape";
  if (k === "Add") k = "+";
  if (k === "Subtract") k = "-";
  if (k.length === 1) k = k.toUpperCase();
  const mods = `${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.metaKey ? "Meta+" : ""}`;
  return `${mods}${k}`;
}

/** Why a key cannot be used for a shortcut (null = it can). */
export function keyProblem(k: string, action: PosAction, keys: Record<PosAction, string>): string | null {
  if (["Control", "Alt", "Shift", "Meta", "CapsLock"].some((m) => k.endsWith(m))) return null; // still choosing
  if (RESERVED.has(k)) return /^F(5|6|11|12)$/.test(k) ? `${k} belongs to the browser.` : `${k === " " ? "Space" : k} is kept for typing and the green button.`;
  if (/^(Ctrl|Meta)\+[CVXAZPRWTN]$/.test(k)) return `${k} belongs to the browser.`;
  const taken = POS_KEY_DEFS.find((d) => d.id !== action && keys[d.id] === k);
  return taken ? `${k} is already used for “${taken.label}”.` : null;
}

/** Shown on a key cap: "Delete" → "Del". */
export const keyCap = (k: string) => (k === "Delete" ? "Del" : k === "Escape" ? "Esc" : k === " " ? "Space" : k);
