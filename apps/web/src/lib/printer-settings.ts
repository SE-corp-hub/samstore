// Printer settings are kept on THIS phone (each phone has its own printer), not on the server.
// The slip itself is built in slip-print.ts; these settings only say how it is printed.

export interface PrinterSettings {
  widthMm: 58 | 80;      // roll width
  autoPrint: boolean;    // print the receipt right after a sale
  copies: 1 | 2;         // 2 = a copy for the customer and one for the store
  header: string;        // a line under the store name (address, phone)
  footer: string;        // replaces "Salamat po!" when filled in
  bluetooth: boolean;    // print straight to a Bluetooth (BLE) printer, no print window
}

export const DEFAULT_PRINTER: PrinterSettings = { widthMm: 58, autoPrint: false, copies: 1, header: "", footer: "", bluetooth: false };

const KEY = "samstore-printer";

/** Anything stored or typed is cleaned: a bad value falls back to the default. */
export function cleanPrinterSettings(raw: unknown): PrinterSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim().slice(0, 80) : "");
  return {
    widthMm: r.widthMm === 80 ? 80 : 58,
    autoPrint: r.autoPrint === true,
    copies: r.copies === 2 ? 2 : 1,
    header: text(r.header),
    footer: text(r.footer),
    bluetooth: r.bluetooth === true,
  };
}

export function getPrinterSettings(): PrinterSettings {
  try { return cleanPrinterSettings(JSON.parse(window.localStorage.getItem(KEY) ?? "null")); } catch { return DEFAULT_PRINTER; }
}

export function savePrinterSettings(p: PrinterSettings): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(cleanPrinterSettings(p))); } catch { /* the setting just will not be remembered */ }
}
