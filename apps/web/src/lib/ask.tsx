"use client";

// In-app replacements for the browser's confirm() and prompt(). The native popups freeze
// the page, look different on every phone, and some in-app browsers block them outright —
// so a staff member taps "Start" and nothing happens. These draw a Bootstrap 5.3 modal
// in the page instead and resolve a promise:
//
//   if (!(await askConfirm("Cancel CNT-000001?"))) return;
//   const reason = await askText("Why decline?");   // null when cancelled
//
// Text people typed (names, notes) is rendered by React, so it is never parsed as HTML.

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface Options {
  /** Label for the main button. Default "Yes, continue". */
  ok?: string;
  /** Label for the cancel button. Default "No". */
  cancel?: string;
  /** Red main button for something that removes or undoes. */
  danger?: boolean;
}

interface TextOptions extends Options {
  placeholder?: string;
  /** Default true: the main button stays off until something is typed. */
  required?: boolean;
}

const words = () => ({ ok: "Yes, continue", cancel: "No", send: "OK", typeHere: "Type here" });

function open<T>(render: (done: (v: T) => void) => React.ReactNode): Promise<T> {
  return new Promise<T>((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const before = document.activeElement as HTMLElement | null;
    const done = (v: T) => {
      root.unmount();
      host.remove();
      before?.focus?.();
      resolve(v);
    };
    root.render(<>{render(done)}</>);
  });
}

function Dialog({ message, options, input, onDone }: {
  message: string;
  options: TextOptions;
  input: boolean;
  onDone: (v: string | null) => void;
}) {
  const w = words();
  const [text, setText] = useState("");
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const required = input && options.required !== false;
  const blocked = required && text.trim() === "";

  useEffect(() => {
    (input ? inputRef.current : okRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input, onDone]);

  const submit = () => { if (!blocked) onDone(input ? text.trim() : "yes"); };

  return (
    <>
      <div className="modal d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="ask-msg" style={{ zIndex: 1080 }}>
        <div className="modal-dialog modal-dialog-centered">
          <form className="modal-content rice-ui" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="modal-body">
              <p id="ask-msg" className="fs-5 mb-0" style={{ whiteSpace: "pre-wrap" }}>{message}</p>
              {input && (
                <textarea
                  ref={inputRef}
                  className="form-control form-control-lg mt-3"
                  rows={2}
                  maxLength={500}
                  placeholder={options.placeholder ?? w.typeHere}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
                />
              )}
            </div>
            <div className="modal-footer d-flex gap-2">
              <button type="button" className="btn btn-lg btn-outline-secondary flex-fill" onClick={() => onDone(null)}>
                {options.cancel ?? w.cancel}
              </button>
              <button ref={okRef} type="submit" className={`btn btn-lg flex-fill ${options.danger ? "btn-danger" : "btn-primary"}`} disabled={blocked}>
                {options.ok ?? (input ? w.send : w.ok)}
              </button>
            </div>
          </form>
        </div>
      </div>
      <div className="modal-backdrop show" style={{ zIndex: 1070 }} onClick={() => onDone(null)}></div>
    </>
  );
}

/** Yes/no question drawn in the page. Resolves true only on the main button. */
export function askConfirm(message: string, options: Options = {}): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return open<string | null>((done) => <Dialog message={message} options={options} input={false} onDone={done} />)
    .then((v) => v !== null);
}

/** Asks for a short text (a reason, a note). Resolves the trimmed text, or null if cancelled. */
export function askText(message: string, options: TextOptions = {}): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  return open<string | null>((done) => <Dialog message={message} options={options} input onDone={done} />);
}
