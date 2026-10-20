// Print a slip straight to a Bluetooth Low Energy (BLE) receipt printer from Chrome — no print window.
// Chrome (Android and desktop) can talk to a BLE printer with Web Bluetooth. Printers that only speak
// "classic" Bluetooth cannot be reached this way; then the normal print window is used instead.
// The ESC/POS text builder is pure so the layout is unit-tested.

import type { Slip } from "./slip-print";

const ASCII_FIX: Record<string, string> = { "₱": "P", "×": "x", "—": "-", "–": "-", "·": "-", "…": "...", "“": '"', "”": '"', "‘": "'", "’": "'" };

/** Printers only know plain characters: swap the few we use, drop accents, and show anything else as "?". */
export function plain(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFD")) {
    const code = ch.charCodeAt(0);
    if (ASCII_FIX[ch] !== undefined) out += ASCII_FIX[ch];
    else if (code >= 0x300 && code <= 0x36f) continue; // accent marks
    else if (code >= 32 && code < 127) out += ch;
    else if (ch === "\n") out += " ";
    else out += "?";
  }
  return out;
}

const wrap = (text: string, w: number): string[] => {
  const words = plain(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    let wd = word;
    while (wd.length > w) { if (cur) { lines.push(cur); cur = ""; } lines.push(wd.slice(0, w)); wd = wd.slice(w); }
    if (!cur) cur = wd;
    else if (cur.length + 1 + wd.length <= w) cur += ` ${wd}`;
    else { lines.push(cur); cur = wd; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
};
const center = (t: string, w: number) => wrap(t, w).map((l) => " ".repeat(Math.max(0, Math.floor((w - l.length) / 2))) + l);
const pair = (left: string, right: string, w: number): string[] => {
  const l = plain(left), r = plain(right);
  if (l.length + 1 + r.length <= w) return [l + " ".repeat(w - l.length - r.length) + r];
  return [...wrap(l, w), " ".repeat(Math.max(0, w - r.length)) + r];
};

/** The slip as plain text lines for a roll of `w` characters (58 mm = 32, 80 mm = 48). */
export function slipLines(s: Slip, w: number): string[] {
  const out: string[] = [];
  const rule = "-".repeat(w);
  const copies = Math.min(2, Math.max(1, Math.floor(s.copies ?? 1)));
  for (let c = 0; c < copies; c++) {
    if (c > 0) out.push("", "", "- - - - - - cut here - - - - - -", "", "");
    out.push(...center(s.storeName, w));
    if (s.header) out.push(...center(s.header, w));
    out.push(...center(s.title, w));
    if (s.reference) out.push(...center(s.reference, w));
    if (s.when) out.push(...center(s.when, w));
    out.push(rule);
    for (const l of s.lines ?? []) out.push(...pair(`${l.label}:`, l.value, w));
    if ((s.lines ?? []).length) out.push(rule);
    for (const r of s.rows ?? []) {
      out.push(...wrap(r.note ? `${r.name} ${r.note}` : r.name, w));
      out.push(" ".repeat(Math.max(0, w - plain(r.qty).length)) + plain(r.qty).slice(-w));
    }
    if ((s.rows ?? []).length) out.push(rule);
    for (const t of s.totals ?? []) out.push(...pair(t.label, t.value, w));
    if ((s.totals ?? []).length) out.push(rule);
    for (const g of s.signatures ?? []) out.push("", "", "_".repeat(Math.min(w, 24)), `${plain(g.name)}${g.name ? " - " : ""}${plain(g.role)}`.slice(0, w));
    if (s.footer) out.push("", ...center(s.footer, w));
  }
  return out;
}

/** ESC/POS bytes: reset, the text, then a few blank lines so the paper clears the tear bar. */
export function slipToEscPos(s: Slip, w: number): Uint8Array {
  const bytes: number[] = [0x1b, 0x40]; // initialise
  for (const line of slipLines(s, w)) {
    for (const ch of line) bytes.push(ch.charCodeAt(0));
    bytes.push(0x0a);
  }
  bytes.push(0x0a, 0x0a, 0x0a, 0x0a);
  return new Uint8Array(bytes);
}

// ───────────────────────── browser side (Web Bluetooth) ─────────────────────────

/* The parts of Web Bluetooth we use (TypeScript's DOM types do not include it). */
interface BtChar { properties: { write: boolean; writeWithoutResponse: boolean }; writeValue(v: BufferSource): Promise<void>; writeValueWithoutResponse?(v: BufferSource): Promise<void> }
interface BtService { getCharacteristics(): Promise<BtChar[]> }
interface BtServer { connected: boolean; getPrimaryServices(): Promise<BtService[]> }
interface BtDevice { name?: string; gatt?: { connected: boolean; connect(): Promise<BtServer> }; addEventListener(t: string, f: () => void): void }
interface BtApi { requestDevice(o: unknown): Promise<BtDevice>; getDevices?: () => Promise<BtDevice[]> }

// Services that common BLE receipt printers use for printing (Chrome only lets a page use the ones it lists here).
const short = (n: number) => `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
const SERVICES = [
  ...[0x18f0, 0xfee7, 0xae30, 0xae00, 0x1101, 0x1800, 0x1801, 0x180a, 0x180f].map(short),
  ...Array.from({ length: 16 }, (_, i) => short(0xff00 + i)),
  ...Array.from({ length: 8 }, (_, i) => short(0xfff0 + i)),
  ...Array.from({ length: 8 }, (_, i) => short(0xffe0 + i)),
  ...Array.from({ length: 8 }, (_, i) => short(0xfe00 + i)),
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", "e7810a71-73ae-499d-8c15-faa9aef0c3f2", "00001101-0000-1000-8000-00805f9b34fb",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", "0000ffff-0000-1000-8000-00805f9b34fb",
];

const api = (): BtApi | null => (typeof navigator !== "undefined" ? ((navigator as unknown as { bluetooth?: BtApi }).bluetooth ?? null) : null);
export const bluetoothSupported = () => api() !== null;

let device: BtDevice | null = null;
let writer: BtChar | null = null;

async function findWriter(d: BtDevice): Promise<BtChar> {
  const server = await d.gatt!.connect();
  for (const svc of await server.getPrimaryServices()) {
    for (const ch of await svc.getCharacteristics()) {
      if (ch.properties.write || ch.properties.writeWithoutResponse) return ch;
    }
  }
  throw new Error("This printer is not a Bluetooth Low Energy printer");
}

/** Pick the printer once (Chrome asks), remember it for this session. Needs a tap (a user gesture). */
export async function connectPrinter(): Promise<string> {
  const bt = api();
  if (!bt) throw new Error("This browser cannot use Bluetooth printing");
  device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
  device.addEventListener("gattserverdisconnected", () => { writer = null; });
  writer = await findWriter(device);
  return device.name || "Bluetooth printer";
}

export const connectedPrinterName = (): string | null => (writer && device ? device.name || "Bluetooth printer" : null);

async function ready(): Promise<BtChar> {
  if (writer && device?.gatt?.connected) return writer;
  if (device) { writer = await findWriter(device); return writer; }
  const known = await api()?.getDevices?.().catch(() => []);
  if (known && known.length > 0) { device = known[0]!; writer = await findWriter(device); return writer; }
  // First print of the session: Chrome asks which printer (this works because Print was just tapped).
  await connectPrinter();
  return writer!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send the slip to the connected printer in small pieces (a BLE write is only about 20 bytes safely). */
export async function printViaBluetooth(s: Slip, widthMm: 58 | 80): Promise<void> {
  const ch = await ready();
  const data = slipToEscPos(s, widthMm === 80 ? 48 : 32);
  for (let i = 0; i < data.length; i += 20) {
    const part = data.slice(i, i + 20);
    if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(part);
    else await ch.writeValue(part);
    await sleep(15);
  }
}

/** Look at a printer and say what it is: name, services and what each can do. Used by "Check my printer". */
export async function diagnosePrinter(): Promise<string> {
  const bt = api();
  if (!bt) return "This browser cannot use Bluetooth. Use Chrome.";
  const out: string[] = [`Checked ${new Date().toLocaleString("en-PH")}`];
  let d: BtDevice;
  try {
    d = await bt.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
  } catch (e) {
    return `${out[0]}\nNo printer was chosen, or none showed in the list: ${e instanceof Error ? e.message : e}\n` +
      "If your printer never appears in Chrome's list while it is on and close, it is probably the older kind of Bluetooth (classic) that Chrome cannot use.";
  }
  out.push(`Device name: ${d.name || "(no name)"}`);
  try {
    const server = await d.gatt!.connect();
    const services = await server.getPrimaryServices();
    out.push(`Connected. Services found: ${services.length}`);
    let writable = 0;
    for (const svc of services) {
      out.push(`- service ${(svc as unknown as { uuid?: string }).uuid ?? "?"}`);
      for (const ch of await svc.getCharacteristics()) {
        const c = ch as unknown as { uuid?: string; properties: Record<string, boolean> };
        const flags = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k).join(", ");
        if (c.properties.write || c.properties.writeWithoutResponse) writable++;
        out.push(`    characteristic ${c.uuid ?? "?"}: ${flags}`);
      }
    }
    out.push(writable > 0 ? `RESULT: usable — ${writable} writable characteristic(s). Direct printing should work.` : "RESULT: connected, but nothing to write to was found. Send this report to Claude.");
    device = d;
    writer = await findWriter(d).catch(() => null);
  } catch (e) {
    out.push(`Could not read the printer: ${e instanceof Error ? e.message : e}`);
    out.push("RESULT: not usable directly. Send this report to Claude.");
  }
  return out.join("\n");
}

/** One short line, to prove the printer answers. */
export async function printTestLine(widthMm: 58 | 80): Promise<void> {
  await printViaBluetooth({ storeName: "SAM STORE", title: "PRINTER TEST", rows: [{ name: "If you can read this", qty: "OK" }], footer: "Direct print works" }, widthMm);
}
