"use client";

// The "printer not connected" box. Whenever a Bluetooth print cannot reach the printer (Bluetooth off,
// printer off or far away, never picked, the link broke mid-receipt), this box shows instead of an error,
// with Connect printer right there. The receipt is kept and printed as soon as the printer answers.
// Built with DOM nodes + textContent like toast.ts: printSlip is called from plain code, not only React.

import { bluetoothOn, btErrorText, connectPrinter, printerPickedBefore } from "./bt-print";
import { toast } from "./toast";

export interface PromptActions {
  print: () => Promise<void>;   // send the kept receipt to the (re)connected printer
  printWindow: () => void;      // the normal print window instead
  dismiss: () => void;          // Close (no receipt): the person gave up on this receipt
}

let open: { close: () => void } | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function showPrinterPrompt(error: unknown, act: PromptActions): void {
  if (typeof window === "undefined") return;
  open?.close(); // one box at a time; the newest receipt wins

  const backdrop = el("div", "modal-backdrop fade show");
  const modal = el("div", "modal d-block");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "printer-prompt-title");
  const dialog = el("div", "modal-dialog modal-dialog-centered");
  const content = el("div", "modal-content");
  const body = el("div", "modal-body");
  const title = el("h2", "h5 mb-2", "Printer not connected");
  title.id = "printer-prompt-title";
  const msg = el("p", "mb-3");
  msg.setAttribute("aria-live", "polite");
  const setMsg = (t: string, bad = true) => { msg.textContent = t; msg.className = `mb-3 ${bad ? "text-danger" : "text-success"}`; };
  // Chrome can tell when Bluetooth is switched off: say that plainly instead of the general reason.
  const explain = (e: unknown) => {
    setMsg(btErrorText(e));
    void bluetoothOn().then((on) => { if (on === false) setMsg("Bluetooth is off. Turn Bluetooth on, then tap Try again or Connect printer."); });
  };
  explain(error);

  const buttons = el("div", "d-grid gap-2");
  const connect = el("button", "btn btn-dark btn-lg");
  connect.type = "button";
  connect.append(el("i", "bi bi-bluetooth me-1"), document.createTextNode("Connect printer"));
  const again = el("button", "btn btn-outline-dark btn-lg", "Try again");
  again.type = "button";
  const windowBtn = el("button", "btn btn-outline-secondary", "Use the print window instead");
  windowBtn.type = "button";
  const cancel = el("button", "btn btn-link", "Close (no receipt)");
  cancel.type = "button";
  buttons.append(connect, ...(printerPickedBefore() ? [again] : []), windowBtn, cancel);
  body.append(title, msg, buttons);
  content.append(body);
  dialog.append(content);
  modal.append(dialog);
  document.body.append(backdrop, modal);

  const close = () => { backdrop.remove(); modal.remove(); if (open === handle) open = null; };
  const handle = { close };
  open = handle;

  const all = [connect, again, windowBtn, cancel];
  const busy = (on: boolean) => all.forEach((b) => { b.disabled = on; });
  // Connect printer: Chrome's list must open straight from the tap, so nothing slow runs before it.
  const run = async (step: () => Promise<unknown>, waitText: string) => {
    busy(true);
    setMsg(waitText, false);
    try {
      await step();
      setMsg("Printing…", false);
      await act.print();
      close();
      toast("Receipt printed");
    } catch (e) {
      explain(e);
      if (printerPickedBefore() && !again.isConnected) buttons.insertBefore(again, windowBtn);
      busy(false);
    }
  };
  connect.addEventListener("click", () => { void run(connectPrinter, "Choose your printer in the list…"); });
  again.addEventListener("click", () => { void run(async () => {}, "Connecting to the printer…"); });
  windowBtn.addEventListener("click", () => { close(); act.printWindow(); });
  cancel.addEventListener("click", () => { close(); act.dismiss(); });
  connect.focus();
}
