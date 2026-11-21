"use client";

// POS keyboard shortcuts on a PC (lib/pos-keys.ts has the list and the saved choice).
//   <KeyHint action="hold" />  the key cap on a button; shown only on a PC with a mouse (desktop.css), never on the tablet.
//   usePosKeyboard(...)        one keydown listener for the POS screen: a shortcut clicks the button marked
//                              data-pos-key="<action>", Enter the one marked data-pos-enter, Esc data-pos-esc,
//                              digits press the open number pad, letters go into the search box.
//   <PosKeysHelp />            the "?" list of every key.
// Nothing fires while someone types in a field (only the F keys, Enter/Esc in the search box).

import { createContext, useContext, useEffect, useRef, type RefObject } from "react";
import { FIXED_KEYS, keyCap, keyName, POS_KEY_DEFS, type PosAction, type PosKeys } from "../../lib/pos-keys";

export const PosKeysContext = createContext<PosKeys | null>(null);

/** The key for an action, as a small key cap on its button (PC only; empty when shortcuts are off or outside POS). */
export function KeyHint({ action, text, corner = false, below = false }: { action?: PosAction; text?: string; /** In the button's top-right corner (big buttons whose words fill the width). */ corner?: boolean; /** On its own line under the words (narrow buttons side by side). */ below?: boolean }) {
  const cfg = useContext(PosKeysContext);
  if (!cfg?.on) return null;
  const k = text ?? (action ? cfg.keys[action] : "");
  if (!k) return null;
  return <kbd className={`pos-key${corner ? " pos-key-corner" : ""}${below ? " pos-key-below" : ""}`} aria-hidden="true">{keyCap(k)}</kbd>;
}

const TYPING = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
const MODAL = "[aria-modal='true'], .lock-screen";
const shown = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0 && !(el as HTMLButtonElement).disabled;
function firstShown(scope: ParentNode, sel: string): HTMLElement | null {
  for (const el of Array.from(scope.querySelectorAll(sel))) if (shown(el)) return el as HTMLElement;
  return null;
}
/** Types into a React-controlled input (the search box) as if the person typed it there. */
function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
/** A key for the number pad that is open in `scope`: its button carries data-numkey. */
function padKey(scope: ParentNode, key: string): HTMLElement | null {
  const k = key === "Backspace" ? "⌫" : key === "," ? "." : key;
  if (!/^[0-9.⌫]$/.test(k)) return null;
  return firstShown(scope, `[data-numkey="${k}"]`);
}

export function usePosKeyboard(root: RefObject<HTMLElement | null>, cfg: PosKeys, opts: {
  /** The sale step now: letters go to the search box only while picking. */
  step: "pick" | "check" | "pay" | "done";
  more: () => void; less: () => void; removeLast: () => void;
  /** Esc with no Back button on screen (e.g. closes the held sales list). */
  escape: () => void;
  help: () => void;
}) {
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    // A PC only: the tablet (touch, no mouse) keeps its own keyboard's Enter in the search box exactly as before.
    if (!cfg.on || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const byKey = new Map<string, PosAction>(POS_KEY_DEFS.map((d) => [cfg.keys[d.id], d.id]));
    const onKey = (e: KeyboardEvent) => {
      const box = root.current;
      if (!box || e.defaultPrevented || e.isComposing || (e.repeat && !/^([0-9+-]|Backspace)$/.test(e.key))) return;
      const k = keyName(e);
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!t?.closest(TYPING);
      const modal = document.querySelector(MODAL);
      // A pop-up (Cash in, Expense, X-read, below cost…): it has its own Esc. Only the pad and Enter help there.
      if (modal) {
        if (modal.classList.contains("lock-screen") || modal.closest(".pos-keys-help") || typing) return;
        const pad = padKey(modal, e.key);
        if (pad && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); pad.click(); return; }
        if (k === "Enter" && (!t || t === document.body || t.classList.contains("btn-close"))) {
          const go = firstShown(modal, "[data-pos-enter]");
          if (go) { e.preventDefault(); go.click(); }
        }
        return;
      }
      const action = byKey.get(k);
      const special = /^F\d+$/.test(e.key) || e.ctrlKey || e.altKey || e.metaKey;
      if (typing) {
        const search = t?.closest<HTMLInputElement>("[data-pos-key='search']");
        if (search) {
          if (k === "Enter") {
            const first = search.value.trim() ? firstShown(box, ".finder-results .pick-row, .finder-results .pick-tile") : null;
            if (first) { e.preventDefault(); first.click(); search.blur(); } // + / − / F8 work on next; a letter starts a new search
            return;
          }
          if (k === "Escape") { e.preventDefault(); if (search.value) typeInto(search, ""); else search.blur(); return; }
          if (k === "ArrowDown") { const first = firstShown(box, ".finder-results .pick-row, .finder-results .pick-tile"); if (first) { e.preventDefault(); first.focus(); } return; }
        }
        if (k === "Escape") { (t as HTMLElement).blur(); return; }
        if (!special || !action) return; // typing in a field: only the F keys (and Ctrl/Alt ones) are shortcuts
      }
      if (action === "help") { e.preventDefault(); o.current.help(); return; }
      if (action === "more" || action === "less" || action === "removeLast") {
        if (o.current.step !== "pick" || !box.querySelector(".sale-lines")) return;
        e.preventDefault();
        (action === "more" ? o.current.more : action === "less" ? o.current.less : o.current.removeLast)();
        return;
      }
      if (action) {
        const btn = firstShown(box, `[data-pos-key="${action}"]`);
        if (btn) {
          e.preventDefault();
          if (btn instanceof HTMLInputElement) { btn.focus(); btn.select(); } else btn.click();
          return;
        }
        if (special) { e.preventDefault(); return; } // F3 / F1 do nothing here instead of the browser's Find / Help
      }
      const onButton = !!t?.closest("button, a, [role='button']") && t !== box;
      if (k === "Enter" && !onButton) {
        const go = firstShown(box, "[data-pos-enter]");
        if (go) { e.preventDefault(); go.click(); }
        return;
      }
      if (k === "Escape") {
        const back = firstShown(box, "[data-pos-esc]");
        e.preventDefault();
        if (back) back.click(); else o.current.escape();
        return;
      }
      if (special) return;
      const pad = padKey(box, e.key);
      if (pad) { e.preventDefault(); pad.click(); return; }
      // A letter while picking: it starts the search ("din" for Dinorado), no click on the box needed.
      if (o.current.step === "pick" && e.key.length === 1 && /[a-z0-9ñ]/i.test(e.key)) {
        const search = firstShown(box, "input[data-pos-key='search']") as HTMLInputElement | null;
        if (search) { e.preventDefault(); search.focus(); typeInto(search, search.value + e.key); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cfg, root]);
}

/** The "?" list: every shortcut and the fixed keys. Changing them is in Settings → Keyboard shortcuts. */
export function PosKeysHelp({ cfg, onClose }: { cfg: PosKeys; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="pos-keys-help">
      <div className="modal d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="pk-title" style={{ zIndex: 1080 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
          <div className="modal-content rice-ui">
            <div className="modal-header py-2">
              <h2 id="pk-title" className="h5 mb-0"><i className="bi bi-keyboard me-2" aria-hidden="true"></i>Keyboard shortcuts</h2>
              <button ref={closeRef} type="button" className="btn-close" aria-label="Close" onClick={onClose} />
            </div>
            <div className="modal-body">
              <table className="table table-sm align-middle mb-3 pos-keys-table">
                <tbody>
                  {POS_KEY_DEFS.map((d) => (
                    <tr key={d.id}><td className="text-nowrap"><kbd>{keyCap(cfg.keys[d.id])}</kbd></td><td>{d.label}</td><td className="text-muted text-nowrap">{d.when}</td></tr>
                  ))}
                  {FIXED_KEYS.map((f) => (
                    <tr key={f.key}><td className="text-nowrap"><kbd>{f.key}</kbd></td><td colSpan={2}>{f.label}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="mb-0 text-muted">Keys do nothing while you type in a box, except the F keys. Change the keys or switch them off in Menu → Settings → Keyboard shortcuts.</p>
            </div>
            <div className="modal-footer py-2">
              <button type="button" className="btn btn-dark btn-lg" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" style={{ zIndex: 1070 }}></div>
    </div>
  );
}
