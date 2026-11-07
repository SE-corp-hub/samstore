// A small printable slip (receipt) for a 58 mm or 80 mm roll printer, or a plain A4 PDF.
// Used by Resack, Stock in and anything else that needs "print what happened".
// The HTML builder is pure so its escaping and layout are unit-tested.

import { getPrinterSettings, receiptName } from "./printer-settings";
import { savedCopy } from "./offlineCache";
import { printViaBluetooth } from "./bt-print";
import { showPrinterPrompt } from "./print-prompt";

export interface SlipLine { label: string; value: string }
export interface SlipRow { name: string; qty: string; note?: string }
export interface SlipSignature { role: string; name: string; imageData?: string | null; at?: string | null }

export interface Slip {
  storeName: string;
  title: string;                 // e.g. "RESACK RECEIPT"
  reference?: string | null;     // document number
  when?: string | null;          // already formatted
  lines?: SlipLine[];            // label/value pairs under the heading (store, from, to…)
  rows?: SlipRow[];              // the items
  totals?: SlipLine[];           // e.g. remaining balance
  signatures?: SlipSignature[];
  footer?: string | null;
  widthMm?: 58 | 80;
  header?: string | null;        // a line under the store name
  contact?: string | null;       // a second line under it (phone)
  copies?: number;               // 2 = one for the customer, one for the store
  a4?: boolean;                  // a full A4 page instead of a roll (statements)
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only a PNG/JPEG data URL is allowed as a signature image; anything else is dropped. */
export function safeImage(src: string | null | undefined): string | null {
  return src && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null;
}

export function slipHtml(s: Slip): string {
  const w = s.a4 ? 190 : s.widthMm ?? 58;
  const lines = (s.lines ?? []).map((l) => `<div class="kv"><span>${esc(l.label)}</span><b>${esc(l.value)}</b></div>`).join("");
  const rows = (s.rows ?? []).map((r) => `<div class="row"><span>${esc(r.name)}${r.note ? `<small> ${esc(r.note)}</small>` : ""}</span><b>${esc(r.qty)}</b></div>`).join("");
  const totals = (s.totals ?? []).map((l) => `<div class="kv big"><span>${esc(l.label)}</span><b>${esc(l.value)}</b></div>`).join("");
  const sigs = (s.signatures ?? []).map((g) => {
    const img = safeImage(g.imageData);
    return `<div class="sig">${img ? `<img src="${img}" alt="">` : '<div class="blank"></div>'}<div>${esc(g.name)} — ${esc(g.role)}</div>${g.at ? `<small>${esc(g.at)}</small>` : ""}</div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.title)}</title><style>
@page { size: ${s.a4 ? "A4" : `${w}mm auto`}; margin: ${s.a4 ? "12mm" : "2mm"}; }
body { font: ${s.a4 ? "13px" : "11px"}/1.35 monospace; width: ${s.a4 ? "100%" : `${w - 4}mm`}; margin: 0 auto; color: #000; }
h1 { font-size: 13px; text-align: center; margin: 4px 0 0; } .c { text-align: center; }
hr { border: 0; border-top: 1px dashed #000; margin: 5px 0; }
.kv, .row { display: flex; justify-content: space-between; gap: 6px; } .big { font-size: 12px; }
small { font-size: 9px; } .sig { margin-top: 8px; text-align: center; } .sig img { max-width: 100%; max-height: 40px; }
.blank { height: 28px; border-bottom: 1px solid #000; }
.cut { page-break-after: always; break-after: page; }
</style></head><body>
${Array.from({ length: Math.min(2, Math.max(1, Math.floor(s.copies ?? 1))) }, (_, i) => `${i > 0 ? '<div class="cut"></div>' : ""}<section>
<h1>${esc(s.storeName)}</h1>${s.header ? `<div class="c">${esc(s.header)}</div>` : ""}${s.contact ? `<div class="c">${esc(s.contact)}</div>` : ""}<div class="c">${esc(s.title)}</div>
${s.reference ? `<div class="c">${esc(s.reference)}</div>` : ""}${s.when ? `<div class="c">${esc(s.when)}</div>` : ""}
<hr>${lines}${lines ? "<hr>" : ""}${rows}${rows ? "<hr>" : ""}${totals}${totals ? "<hr>" : ""}${sigs}
${s.footer ? `<hr><div class="c">${esc(s.footer)}</div>` : ""}
</section>`).join("")}
</body></html>`;
}

/** Print the slip through a hidden frame (works on phones and desktops; "Save as PDF" is in the print dialog). */
export function printSlip(s: Slip): void {
  const cfg = getPrinterSettings();
  s = {
    ...s, storeName: receiptName(s.storeName, cfg.name, registeredStoreName()),
    widthMm: s.widthMm ?? cfg.widthMm, header: s.header ?? (cfg.header || null), contact: s.contact ?? (cfg.contact || null),
    footer: cfg.footer || s.footer, copies: s.copies ?? cfg.copies,
  };
  if (cfg.bluetooth && !s.a4) {
    // Straight to the Bluetooth printer. If that fails, fall back to the normal print window so a receipt is never lost.
    const slip = s;
    // Whatever stops it (not connected, Bluetooth off, printer off), the receipt is kept and a box offers Connect printer.
    printViaBluetooth(slip, slip.widthMm ?? 58).catch((e) => { keepPending(slip); prompt(slip, e); });
    return;
  }
  browserPrint(s);
}

/** The store's registered name from the copy of Settings kept on this tablet, so it prints offline too. */
export function registeredStoreName(): string | null {
  return savedCopy<{ name?: string }>("/admin/settings")?.name?.trim() || null;
}

// A receipt that could not reach the printer is kept on this device until it prints or the person closes
// the box, so it survives closing the app (the fix for a dead Bluetooth link on the tablet).
const PENDING = "samstore-pending-receipt";
const KEEP_MS = 12 * 60 * 60 * 1000;
function keepPending(slip: Slip): void {
  try { window.localStorage.setItem(PENDING, JSON.stringify({ at: Date.now(), slip })); } catch { /* only kept for this session */ }
}
function dropPending(): void {
  try { window.localStorage.removeItem(PENDING); } catch { /* nothing kept */ }
}
function prompt(slip: Slip, e: unknown): void {
  showPrinterPrompt(e, {
    print: async () => { await printViaBluetooth(slip, slip.widthMm ?? 58); dropPending(); },
    printWindow: () => { dropPending(); browserPrint(slip); },
    dismiss: dropPending,
  });
}

/** When the app opens: offer the receipt that did not print before the app was closed. */
export function resumePendingReceipt(): void {
  if (typeof window === "undefined") return;
  let kept: { at?: number; slip?: Slip } | null = null;
  try { kept = JSON.parse(window.localStorage.getItem(PENDING) ?? "null") as { at?: number; slip?: Slip } | null; } catch { kept = null; }
  if (!kept?.slip || !kept.at || Date.now() - kept.at > KEEP_MS || !getPrinterSettings().bluetooth) { dropPending(); return; }
  prompt(kept.slip, Object.assign(new Error("Receipt not printed yet"), { name: "PendingReceipt" }));
}

function browserPrint(s: Slip): void {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentWindow?.document;
  if (!doc || !frame.contentWindow) { frame.remove(); return; }
  doc.open(); doc.write(slipHtml(s)); doc.close();
  const go = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 60_000); };
  setTimeout(go, 150);
}
