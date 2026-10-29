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
    if (s.contact) out.push(...center(s.contact, w));
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
interface BtChar { uuid?: string; properties: { write: boolean; writeWithoutResponse: boolean }; writeValue(v: BufferSource): Promise<void>; writeValueWithoutResponse?(v: BufferSource): Promise<void> }
interface BtService { uuid?: string; getCharacteristics(): Promise<BtChar[]> }
interface BtServer { connected: boolean; getPrimaryServices(): Promise<BtService[]> }
interface BtDevice { id?: string; name?: string; gatt?: { connected: boolean; connect(): Promise<BtServer>; disconnect(): void }; forget?: () => Promise<void>; addEventListener(t: string, f: () => void): void }
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

// When Bluetooth is switched off, the printer link is gone: drop it so the next print reconnects cleanly.
if (typeof navigator !== "undefined") {
  (navigator as unknown as { bluetooth?: EventTarget }).bluetooth?.addEventListener?.("availabilitychanged", (ev) => {
    if (!(ev as Event & { value?: boolean }).value) { writer = null; try { device?.gatt?.disconnect(); } catch { /* already closed */ } }
  });
}

// Every Bluetooth device has these (name, battery, maker info). Some let you write the device name, which
// the old code picked by mistake: the receipt went there and nothing printed. They are never the print channel.
const STANDARD = new Set([0x1800, 0x1801, 0x180a, 0x180f].map(short));
// Where well-known printers take the receipt bytes: service → characteristic.
const KNOWN_PRINT: Record<string, string> = {
  [short(0x18f0)]: short(0x2af1),
  [short(0xff00)]: short(0xff02),
  [short(0xae30)]: short(0xae01),
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2": "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455": "49535343-8841-43f4-a8d4-ecbe34729bb3",
};

export interface CharInfo { service: string; uuid: string; write: boolean; writeWithoutResponse: boolean }

/** Which characteristic takes the receipt: a known print channel first, then any writable one outside the standard services. -1 = none. */
export function pickWriter(chars: CharInfo[]): number {
  let best = -1, bestScore = 0;
  chars.forEach((c, i) => {
    const service = c.service.toLowerCase(), uuid = c.uuid.toLowerCase();
    if (STANDARD.has(service) || !(c.write || c.writeWithoutResponse)) return;
    const score = (KNOWN_PRINT[service] === uuid ? 10 : 1) + (c.writeWithoutResponse ? 1 : 0);
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

/** A plain-words reason for a Bluetooth error, with what to do next. */
export function btErrorText(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "NeedsTapError" || /gesture/i.test(msg)) return "The printer is not connected yet. Tap Connect printer.";
  if (name === "NotFoundError" && (/cancel/i.test(msg) || !msg)) return "No printer was chosen";
  // Chrome found the printer but none of its print channels is one this app may use.
  if (/service/i.test(msg)) return `The printer was found, but the app cannot use its print channel. In Printer settings tap "Check my printer" and send the report to Claude.${msg ? ` (${msg})` : ""}`;
  // Chrome's own words go at the end so a screenshot tells Claude exactly what happened.
  const raw = msg ? ` (${msg})` : "";
  // "Bluetooth adapter not available" also shows when Bluetooth is on but Chrome lacks the Nearby devices permission.
  if (name === "NotFoundError" || name === "SecurityError" || name === "NotAllowedError") return `Bluetooth is off, or Chrome is not allowed to use it. Turn Bluetooth on. If it is already on, open the phone's Settings, Apps, Chrome, Permissions and allow "Nearby devices" and "Location".${raw}`;
  if (name === "PendingReceipt") return "This receipt was not printed yet. Tap Connect printer to print it now.";
  // On the tablet, after Bluetooth is turned off and on, Chrome keeps a dead link that only closing the app clears.
  if (name === "TimeoutError") return `The printer did not answer. Check that it is on and close by, then tap Connect printer and pick it again. If it still does not answer, close this app completely (swipe it away from recent apps) and open it again: this receipt is kept and offered again.${raw}`;
  if (name === "NetworkError" || /gatt|connect/i.test(msg)) return `The printer did not answer. Check that Bluetooth is on, the printer is on and close by, and RawBT or another app is not using it.${raw}`;
  return msg || "error";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Bluetooth step that never answers (printer gone, Bluetooth switched off) fails after `ms` instead of hanging. */
const timeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([
  p, new Promise<never>((_, no) => setTimeout(() => no(Object.assign(new Error("No answer from the printer"), { name: "TimeoutError" })), ms)),
]);

/** Android often fails the first Bluetooth connection, so try up to 3 times before giving up. */
async function connectGatt(d: BtDevice): Promise<BtServer> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    // Clear any half-open link first: after Bluetooth is switched off and on, Chrome keeps a dead one
    // and a new connect on top of it never answers.
    if (!d.gatt!.connected) { try { d.gatt!.disconnect(); } catch { /* nothing to close */ } }
    // Some printers take 10+ seconds to accept the first connection, so give it 15 seconds before giving up.
    try { return await timeout(d.gatt!.connect(), 15000); }
    catch (e) {
      last = e;
      try { d.gatt!.disconnect(); } catch { /* already closed */ }
      if (e instanceof Error && e.name === "TimeoutError") break; // no answer at all: the link is dead, stop making staff wait
      await sleep(600);
    }
  }
  throw last;
}

async function listChars(server: BtServer): Promise<{ info: CharInfo[]; chars: BtChar[] }> {
  const info: CharInfo[] = [], chars: BtChar[] = [];
  for (const svc of await server.getPrimaryServices()) {
    for (const ch of await svc.getCharacteristics().catch(() => [] as BtChar[])) {
      info.push({ service: svc.uuid ?? "", uuid: ch.uuid ?? "", write: ch.properties.write, writeWithoutResponse: ch.properties.writeWithoutResponse });
      chars.push(ch);
    }
  }
  return { info, chars };
}

async function findWriter(d: BtDevice): Promise<BtChar> {
  const { info, chars } = await listChars(await connectGatt(d));
  const i = pickWriter(info);
  if (i < 0) throw new Error("This printer has no print channel Chrome can use. Tap \"Check my printer\" and send the report to Claude.");
  return chars[i]!;
}

/** Pick the printer once (Chrome asks), remember it for this session. Needs a tap (a user gesture). */
export async function connectPrinter(): Promise<string> {
  const bt = api();
  if (!bt) throw new Error("This browser cannot use Bluetooth printing. Open the app in Chrome, or use the print window.");
  device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
  device.addEventListener("gattserverdisconnected", () => { writer = null; });
  writer = await findWriter(device);
  idleLater();
  try { window.localStorage.setItem(SAVED, JSON.stringify({ id: device.id ?? "", name: device.name ?? "" })); } catch { /* just not remembered */ }
  return device.name || "Bluetooth printer";
}

// The printer picked last time, so Chrome's remembered devices can be matched after the app restarts.
const SAVED = "samstore-bt-printer";
const saved = (): { id: string; name: string } | null => {
  try { return JSON.parse(window.localStorage.getItem(SAVED) ?? "null") as { id: string; name: string } | null; } catch { return null; }
};

/** A printer was picked on this device before (this session, or saved), so "Try again" can reconnect it without Chrome's list. */
export const printerPickedBefore = (): boolean => device !== null || saved() !== null;

/** false when Chrome says Bluetooth is off; null when it cannot tell. */
export async function bluetoothOn(): Promise<boolean | null> {
  const bt = api() as (BtApi & { getAvailability?: () => Promise<boolean> }) | null;
  try { return bt?.getAvailability ? await bt.getAvailability() : null; } catch { return null; }
}

// The picked printer, even while the link is let go between prints.
export const connectedPrinterName = (): string | null => (device ? device.name || "Bluetooth printer" : null);

async function ready(): Promise<BtChar> {
  if (writer && device?.gatt?.connected) return writer;
  if (device) {
    try { writer = await findWriter(device); return writer; }
    catch (e) {
      // This printer link is dead (for example Bluetooth was switched off and on while connected). Chrome keeps
      // such a link until the app is closed, so ask Chrome to forget the printer: the next tap on Try again or
      // Connect printer then picks it fresh from Chrome's list with a clean, new link.
      const dead = device;
      device = null; writer = null;
      if (e instanceof Error && e.name === "TimeoutError") await dead.forget?.().catch(() => {});
      throw e;
    }
  }
  // After the app restarts the picked printer is gone from memory. Chrome can hand it back without asking
  // (when its remembered-devices feature is on); prefer the one picked last time.
  const known = (await api()?.getDevices?.().catch(() => [])) ?? [];
  const last = saved();
  const match = known.find((d) => last && d.id === last.id) ?? known.find((d) => last?.name && d.name === last.name) ?? known[0];
  if (match) {
    device = match;
    device.addEventListener("gattserverdisconnected", () => { writer = null; });
    writer = await findWriter(device);
    return writer;
  }
  // Chrome shows its printer list only right after a tap. An automatic print (after a sale) has no tap,
  // so say so plainly instead of failing with a confusing error.
  const activation = (navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation;
  if (activation && !activation.isActive) throw Object.assign(new Error("Printer not connected yet"), { name: "NeedsTapError" });
  // First print of the session: Chrome asks which printer (this works because Print was just tapped).
  await connectPrinter();
  return writer!;
}

/** Send the slip to the connected printer in small pieces (a BLE write is only about 20 bytes safely). */
// Let go of the printer a few seconds after the last print. Bluetooth switched off while the link is open leaves
// a dead link in Chrome; with no link open there is nothing to go dead. Reconnecting takes a second or two.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function idleLater(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; writer = null; try { device?.gatt?.disconnect(); } catch { /* already closed */ } }, 4000);
}

export async function printViaBluetooth(s: Slip, widthMm: 58 | 80): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const ch = await ready();
  const data = slipToEscPos(s, widthMm === 80 ? 48 : 32);
  try {
    for (let i = 0; i < data.length; i += 20) {
      const part = data.slice(i, i + 20);
      if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) await timeout(ch.writeValueWithoutResponse(part), 5000);
      else await timeout(ch.writeValue(part), 5000);
      await sleep(15);
    }
  } catch (e) {
    writer = null; // the link broke mid-receipt: reconnect on the next try
    throw e;
  }
  idleLater();
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
    const { info, chars } = await listChars(await connectGatt(d));
    out.push(`Connected. Characteristics found: ${info.length}`);
    for (const c of info) out.push(`- ${c.service} / ${c.uuid}: ${[c.write && "write", c.writeWithoutResponse && "writeWithoutResponse"].filter(Boolean).join(", ") || "read only"}`);
    const i = pickWriter(info);
    if (i >= 0) {
      out.push(`Print channel: ${info[i]!.uuid}`, "RESULT: usable. Direct printing should work.");
      device = d;
      writer = chars[i]!;
      d.addEventListener("gattserverdisconnected", () => { writer = null; });
    } else out.push("RESULT: connected, but no print channel was found. Send this report to Claude.");
  } catch (e) {
    out.push(`Could not read the printer: ${btErrorText(e)} (${e instanceof Error ? `${e.name}: ${e.message}` : e})`);
    out.push("RESULT: not usable directly. Send this report to Claude.");
  }
  return out.join("\n");
}

/** One short line, to prove the printer answers. */
export async function printTestLine(widthMm: 58 | 80): Promise<void> {
  await printViaBluetooth({ storeName: "SAM STORE", title: "PRINTER TEST", rows: [{ name: "If you can read this", qty: "OK" }], footer: "Direct print works" }, widthMm);
}
