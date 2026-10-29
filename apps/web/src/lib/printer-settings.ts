// Printer settings are kept on THIS phone (each phone has its own printer), not on the server.
// The slip itself is built in slip-print.ts; these settings only say how it is printed.

export interface PrinterSettings {
  widthMm: 58 | 80;      // roll width
  autoPrint: boolean;    // print the receipt right after a sale
  copies: 1 | 2;         // 2 = a copy for the customer and one for the store
  name: string;          // the name printed at the top; empty = the store's registered name
  header: string;        // a line under the store name (address)
  contact: string;       // a second line under it (phone, Facebook page)
  footer: string;        // replaces "Salamat po!" when filled in
  bluetooth: boolean;    // print straight to a Bluetooth (BLE) printer, no print window
}

export const DEFAULT_PRINTER: PrinterSettings = { widthMm: 58, autoPrint: false, copies: 1, name: "", header: "", contact: "", footer: "", bluetooth: false };

const KEY = "samstore-printer";

/** Anything stored or typed is cleaned: a bad value falls back to the default. */
export function cleanPrinterSettings(raw: unknown): PrinterSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim().slice(0, 80) : "");
  return {
    widthMm: r.widthMm === 80 ? 80 : 58,
    autoPrint: r.autoPrint === true,
    copies: r.copies === 2 ? 2 : 1,
    name: text(r.name).slice(0, 40),
    header: text(r.header),
    contact: text(r.contact),
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

/** What every receipt opened with before the store's own name was known. */
export const PLACEHOLDER_NAME = "SAM STORE";

/**
 * The name at the top of a slip. A store receipt (the screen passed the store's registered name,
 * or the placeholder because it was offline) gets the name typed in Printer settings, else the
 * registered name. Reports and statements that print their own title ("Weekly summary") keep it.
 */
export function receiptName(given: string, typed: string, registered: string | null): string {
  const isStore = given === PLACEHOLDER_NAME || (!!registered && given === registered);
  if (!isStore) return given;
  return typed || registered || given;
}
