// A small printable slip (receipt) for a 58 mm or 80 mm roll printer, or a plain A4 PDF.
// Used by Resack, Stock in and anything else that needs "print what happened".
// The HTML builder is pure so its escaping and layout are unit-tested.

import { placeIdentity } from "./store-identity";
import { getPrinterSettings, receiptName } from "./printer-settings";
import { savedCopy } from "./offlineCache";
import { printViaBluetooth } from "./bt-print";
import { showPrinterPrompt } from "./print-prompt";

/** `strong` = the one line read first (the TOTAL): printed in tall letters. */
export interface SlipLine { label: string; value: string; strong?: boolean }
/**
 * An item. A sale line gives `detail` ("2 x ₱1,250.00", "1.785 kg x ₱52.00/kg") and `amount`: the name prints
 * in bold with the detail and amount under it. Other slips (resack, stock in) give only `qty`.
 */
export interface SlipRow { name: string; qty: string; note?: string; detail?: string; amount?: string }
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
  locationId?: string | null;    // the store this slip is from (left out: the login's own store)
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only a PNG/JPEG data URL is allowed as a signature image; anything else is dropped. */
export function safeImage(src: string | null | undefined): string | null {
  return src && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null;
}

export function slipHtml(s: Slip): string {
  const w = s.a4 ? 190 : s.widthMm ?? 58;
  const kv = (l: SlipLine) => `<div class="kv"><span>${esc(l.label)}</span><b>${esc(l.value)}</b></div>`;
  const info = [
    ...(s.reference ? [{ label: "No.", value: s.reference }] : []),
    ...(s.when ? [{ label: "Date", value: s.when }] : []),
    ...(s.lines ?? []),
  ].map(kv).join("");
  const rowList = s.rows ?? [];
  const rows = rowList.map((r) => {
    const name = `${esc(r.name)}${r.note ? ` <small>${esc(r.note)}</small>` : ""}`;
    return r.amount !== undefined || r.detail !== undefined
      ? `<div class="item"><div class="name">${name}</div><div class="kv sub"><span>${esc(r.detail ?? "")}</span><b>${esc(r.amount ?? "")}</b></div></div>`
      : `<div class="kv row"><span>${name}</span><b>${esc(r.qty)}</b></div>`;
  }).join("");
  const count = rowList.some((r) => r.amount !== undefined) ? `<div class="count">${rowList.length} ${rowList.length === 1 ? "item" : "items"}</div>` : "";
  const totalList = s.totals ?? [];
  // The TOTAL in big letters, with a double line under it when payment lines (cash, change) follow.
  const totals = totalList.map((l, i) => (l.strong
    ? `<div class="kv total"><span>${esc(l.label)}</span><b>${esc(l.value)}</b></div>${i < totalList.length - 1 ? '<hr class="double">' : ""}`
    : kv(l))).join("");
  const sigs = (s.signatures ?? []).map((g) => {
    const img = safeImage(g.imageData);
    return `<div class="sig">${img ? `<img src="${img}" alt="">` : '<div class="blank"></div>'}<div>${esc(g.name)} — ${esc(g.role)}</div>${g.at ? `<small>${esc(g.at)}</small>` : ""}</div>`;
  }).join("");
  const base = s.a4 ? 14 : 12; // px; everything below is sized from it
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.title)}</title><style>
@page { size: ${s.a4 ? "A4" : `${w}mm auto`}; margin: ${s.a4 ? "12mm" : "2mm"}; }
* { box-sizing: border-box; }
body { font: ${base}px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-variant-numeric: tabular-nums; width: ${s.a4 ? "100%" : `${w - 4}mm`}; margin: 0 auto; color: #000; }
.head { text-align: center; }
h1 { font-size: ${Math.round(base * 1.5)}px; font-weight: 800; line-height: 1.2; margin: 2px 0 3px; overflow-wrap: anywhere; }
.c { text-align: center; } .title { font-weight: 700; letter-spacing: .1em; margin-top: 8px; }
hr { border: 0; border-top: 1px dashed #000; margin: 8px 0; } hr.double { border-top: 3px double #000; margin: 4px 0 6px; }
.kv { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 1px 0; }
.kv span { min-width: 0; overflow-wrap: anywhere; } .kv b { text-align: right; white-space: nowrap; }
.item { margin: 0 0 6px; } .item:last-of-type { margin-bottom: 0; } .item .name { font-weight: 700; overflow-wrap: anywhere; } .item .sub { padding-left: 8px; }
.item .sub b { font-weight: 600; }
.count { font-size: ${base - 1}px; margin-top: 4px; }
.total { font-size: ${Math.round(base * 1.4)}px; font-weight: 800; margin: 2px 0; } .total b { font-weight: 800; }
.foot { text-align: center; font-weight: 700; margin-top: 10px; }
small { font-size: ${base - 2}px; font-weight: 400; } .sig { margin-top: 10px; text-align: center; } .sig img { max-width: 100%; max-height: 40px; }
.blank { height: 28px; border-bottom: 1px solid #000; }
.cut { page-break-after: always; break-after: page; }
</style></head><body>
${Array.from({ length: Math.min(2, Math.max(1, Math.floor(s.copies ?? 1))) }, (_, i) => `${i > 0 ? '<div class="cut"></div>' : ""}<section>
<div class="head"><h1>${esc(s.storeName)}</h1>${s.header ? `<div>${esc(s.header)}</div>` : ""}${s.contact ? `<div>${esc(s.contact)}</div>` : ""}<div class="title">${esc(s.title)}</div></div>
<hr>${info}${info ? "<hr>" : ""}${rows}${count}${rows ? "<hr>" : ""}${totals}${totals ? "<hr>" : ""}${sigs}
${s.footer ? `<div class="foot">${esc(s.footer)}</div>` : ""}
</section>`).join("")}
</body></html>`;
}

/** Print the slip through a hidden frame (works on phones and desktops; "Save as PDF" is in the print dialog). */
export function printSlip(s: Slip): void {
  const cfg = getPrinterSettings();
  // Step 9: a store's own receipt name and text (Menu, Locations) come before this tablet's printer text.
  const place = placeIdentity(s.locationId);
  s = {
    ...s, storeName: receiptName(s.storeName, place?.receiptName || cfg.name, registeredStoreName()),
    widthMm: s.widthMm ?? cfg.widthMm, header: s.header ?? (place?.receiptHeader || cfg.header || null), contact: s.contact ?? (place?.receiptContact || cfg.contact || null),
    footer: place?.receiptFooter || cfg.footer || s.footer, copies: s.copies ?? cfg.copies,
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
