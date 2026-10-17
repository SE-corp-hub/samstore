// Rice Ops M12 — go-live import: reading the owner's lists (pure; no database).
//
// Four CSV files, made in Excel/Google Sheets ("Save as CSV"), one row per item:
//   products.csv   sku, name, variety, sold_as (SACK|KILO|PIECE), kg_per_sack, cost, price,
//                  price_S1, price_S2, … (optional per-location price; blank = main price)
//   customers.csv  name, phone, limit, utang, utang_since (YYYY-MM-DD), note
//   staff.csv      name, phone, role (MANAGER|STAFF|SALES_AGENT|DELIVERY), home (S1…), pin
//   kargadors.csv  name, phone, home, photo_url
// Money is in pesos ("1,250" or "1250.50"; a ₱ or P in front is fine). Every row is
// checked before anything is written; a file with any bad row is not imported at all.
// Stock is NOT imported: the go-live blind count (M8) becomes the opening stock.

import { pinProblem } from "./people.js";
import { toE164 } from "./phone.js";

export type ImportError = { file: string; row: number; message: string };

export type ProductRow = {
  row: number; sku: string; name: string; variety: string | null; soldAs: "SACK" | "KILO" | "PIECE";
  gramsPerSack: number | null; costMinor: number; priceMinor: number; locationPrices: Record<string, number>;
};
export type CustomerRow = { row: number; name: string; phone: string; limitMinor: number; utangMinor: number; utangSince: string | null; note: string | null };
export type StaffRow = { row: number; name: string; phone: string; role: "MANAGER" | "STAFF" | "SALES_AGENT" | "DELIVERY"; home: string | null; pin: string | null };
export type KargadorRow = { row: number; name: string; phone: string | null; home: string | null; photoUrl: string | null };

export type Parsed<T> = { rows: T[]; errors: ImportError[] };

const MAX_PRICE_MINOR = 10_000_000; // ₱100,000 per sack/kilo/piece
const MAX_LIMIT_MINOR = 100_000_000; // ₱1,000,000 — same cap as the Utang screen
const MAX_ROWS = 5_000;

/** RFC 4180-style CSV: quotes, doubled quotes, commas and newlines inside quotes, BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      out.push(row); row = [];
    } else cell += ch;
  }
  if (quoted) throw new Error("A quoted cell is never closed");
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Header → value rows. Header names are matched without case, spaces or dashes. Row numbers are spreadsheet rows (header = 1). */
export function readTable(text: string): { headers: string[]; rows: { row: number; get: (h: string) => string }[] } {
  const all = parseCsv(text);
  const head = (all[0] ?? []).map(normHeader);
  const rows = all.slice(1).map((cells, i) => ({
    row: i + 2,
    get: (h: string) => {
      const idx = head.indexOf(normHeader(h));
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    },
  }));
  return { headers: head, rows };
}

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** "₱1,250.50" → 125050. Null for blank. Throws for anything that is not a peso amount ≥ 0. */
export function pesoToMinor(raw: string): number | null {
  const s = raw.trim().replace(/^(₱|php|p)\s*/i, "").replace(/,/g, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`"${raw}" is not a peso amount`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

const cleanName = (s: string) => s.trim().replace(/\s+/g, " ");

function collect<T>(file: string, text: string, required: string[], each: (r: { row: number; get: (h: string) => string }) => T): Parsed<T> {
  const errors: ImportError[] = [];
  const rows: T[] = [];
  let table: ReturnType<typeof readTable>;
  try {
    table = readTable(text);
  } catch (e) {
    return { rows, errors: [{ file, row: 0, message: (e as Error).message }] };
  }
  const missing = required.filter((h) => !table.headers.includes(normHeader(h)));
  if (missing.length) return { rows, errors: [{ file, row: 1, message: `Missing column(s): ${missing.join(", ")}` }] };
  if (table.rows.length > MAX_ROWS) return { rows, errors: [{ file, row: 0, message: `Too many rows (max ${MAX_ROWS})` }] };
  for (const r of table.rows) {
    try {
      rows.push(each(r));
    } catch (e) {
      errors.push({ file, row: r.row, message: (e as Error).message });
    }
  }
  return { rows, errors };
}

function dupes<T>(file: string, rows: T[], key: (r: T) => string, label: string, rowOf: (r: T) => number): ImportError[] {
  const seen = new Map<string, number>();
  const out: ImportError[] = [];
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const first = seen.get(k);
    if (first !== undefined) out.push({ file, row: rowOf(r), message: `Same ${label} as row ${first}` });
    else seen.set(k, rowOf(r));
  }
  return out;
}

function locationCode(raw: string, codes: string[]): string | null {
  const v = raw.trim().toUpperCase();
  if (!v) return null;
  if (!codes.includes(v)) throw new Error(`Unknown location "${raw}" (use ${codes.join(", ")})`);
  return v;
}

export function parseProducts(text: string, codes: string[]): Parsed<ProductRow> {
  const file = "products.csv";
  const p = collect<ProductRow>(file, text, ["sku", "name", "sold_as", "price"], (r) => {
    const sku = r.get("sku").toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(sku)) throw new Error("SKU: letters, numbers, dot, dash (max 40)");
    const name = cleanName(r.get("name"));
    if (name.length < 2 || name.length > 80) throw new Error("Name: 2–80 letters");
    const soldAs = r.get("sold_as").toUpperCase();
    if (soldAs !== "SACK" && soldAs !== "KILO" && soldAs !== "PIECE") throw new Error("sold_as must be SACK, KILO or PIECE");
    let gramsPerSack: number | null = null;
    if (soldAs === "SACK") {
      const kg = Number(r.get("kg_per_sack") || "x");
      const grams = Math.round(kg * 1000);
      if (!Number.isFinite(kg) || grams < 100 || grams > 100_000 || Math.abs(grams - kg * 1000) > 1e-6) throw new Error("kg_per_sack: the sack's weight in kilos (e.g. 25)");
      gramsPerSack = grams;
    }
    const price = pesoToMinor(r.get("price"));
    if (price === null || price <= 0 || price > MAX_PRICE_MINOR) throw new Error("price: the main selling price (per sack, per kilo, or per piece)");
    const cost = pesoToMinor(r.get("cost")) ?? 0;
    if (cost > MAX_PRICE_MINOR) throw new Error("cost is too high");
    const locationPrices: Record<string, number> = {};
    for (const code of codes) {
      const v = pesoToMinor(r.get(`price_${code}`));
      if (v === null) continue;
      if (v <= 0 || v > MAX_PRICE_MINOR) throw new Error(`price_${code} is not a valid price`);
      locationPrices[code] = v;
    }
    const variety = cleanName(r.get("variety")) || null;
    return { row: r.row, sku, name, variety, soldAs, gramsPerSack, costMinor: cost, priceMinor: price, locationPrices };
  });
  p.errors.push(...dupes(file, p.rows, (x) => x.sku, "SKU", (x) => x.row));
  p.errors.push(...dupes(file, p.rows, (x) => x.name.toLowerCase(), "name", (x) => x.row));
  return p;
}

/** YYYY-MM-DD, a real date, not in the future. */
function pastDate(raw: string, today: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.toISOString().slice(0, 10) !== v) throw new Error(`utang_since: write the date as YYYY-MM-DD (got "${raw}")`);
  if (v > today) throw new Error("utang_since is in the future");
  return v;
}

export function parseCustomers(text: string, today: string): Parsed<CustomerRow> {
  const file = "customers.csv";
  const p = collect<CustomerRow>(file, text, ["name", "phone"], (r) => {
    const name = cleanName(r.get("name"));
    if (name.length < 2 || name.length > 80) throw new Error("Name: 2–80 letters");
    const phone = toE164(r.get("phone"));
    if (!phone) throw new Error(`phone: a PH mobile number (09xx xxx xxxx), got "${r.get("phone")}"`);
    const limit = pesoToMinor(r.get("limit")) ?? 0;
    if (limit > MAX_LIMIT_MINOR) throw new Error("limit is above ₱1,000,000");
    const utang = pesoToMinor(r.get("utang")) ?? 0;
    if (utang > MAX_LIMIT_MINOR) throw new Error("utang is above ₱1,000,000 — check the number");
    const utangSince = pastDate(r.get("utang_since"), today);
    if (utang > 0 && !utangSince) throw new Error("utang_since: when did this credit start? (YYYY-MM-DD; for the reminder texts)");
    const note = cleanName(r.get("note")).slice(0, 200) || null;
    return { row: r.row, name, phone, limitMinor: limit, utangMinor: utang, utangSince: utang > 0 ? utangSince : null, note };
  });
  p.errors.push(...dupes(file, p.rows, (x) => x.phone, "phone", (x) => x.row));
  return p;
}

const STAFF_ROLES = ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"] as const;

export function parseStaff(text: string, codes: string[]): Parsed<StaffRow> {
  const file = "staff.csv";
  const p = collect<StaffRow>(file, text, ["name", "phone", "role"], (r) => {
    const name = cleanName(r.get("name"));
    if (name.length < 2 || name.length > 80) throw new Error("Name: 2–80 letters");
    const phone = toE164(r.get("phone"));
    if (!phone) throw new Error(`phone: a PH mobile number (09xx xxx xxxx), got "${r.get("phone")}"`);
    const role = r.get("role").toUpperCase().replace(/\s+/g, "_") as StaffRow["role"];
    if (!STAFF_ROLES.includes(role)) throw new Error(`role must be ${STAFF_ROLES.join(", ")} (the owner is not imported)`);
    const home = locationCode(r.get("home"), codes);
    if ((role === "STAFF" || role === "SALES_AGENT") && !home) throw new Error("home: which location does this person work at? (e.g. S1)");
    const pinRaw = r.get("pin");
    const pin = pinRaw ? pinRaw.padStart(4, "0") : null; // Excel drops leading zeros
    if (pin) {
      const problem = pinProblem(pin);
      if (problem) throw new Error(`pin: ${problem}`);
    }
    return { row: r.row, name, phone, role, home, pin };
  });
  p.errors.push(...dupes(file, p.rows, (x) => x.phone, "phone", (x) => x.row));
  return p;
}

export function parseKargadors(text: string, codes: string[]): Parsed<KargadorRow> {
  const file = "kargadors.csv";
  const p = collect<KargadorRow>(file, text, ["name"], (r) => {
    const name = cleanName(r.get("name"));
    if (name.length < 2 || name.length > 80) throw new Error("Name: 2–80 letters");
    const rawPhone = r.get("phone");
    const phone = rawPhone ? toE164(rawPhone) : null;
    if (rawPhone && !phone) throw new Error(`phone: a PH mobile number, got "${rawPhone}"`);
    const home = locationCode(r.get("home"), codes);
    const photo = r.get("photo_url");
    if (photo && !/^https:\/\/\S{1,500}$/.test(photo)) throw new Error("photo_url must be an https link (or blank — take the photo in the app)");
    return { row: r.row, name, phone: phone || null, home, photoUrl: photo || null };
  });
  p.errors.push(...dupes(file, p.rows, (x) => x.name.toLowerCase(), "name", (x) => x.row));
  return p;
}

// ── Sign-off sheet ───────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const peso = (minor: number) => `₱${(minor / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type SignoffInput = {
  storeName: string;
  generatedAt: string;
  locations: { code: string; name: string }[];
  products: { sku: string; name: string; soldAs: string; priceMinor: number; costMinor: number; locationPrices: Record<string, number> }[];
  customers: { name: string; phone: string; limitMinor: number; utangMinor: number; utangSince: string | null }[];
  staffCount: number;
  kargadorCount: number;
};

/** A printable page the owner checks line by line and signs (M12 "done when"). */
export function signoffHtml(x: SignoffInput): string {
  const totalUtang = x.customers.reduce((a, c) => a + c.utangMinor, 0);
  const priceCells = (p: SignoffInput["products"][number]) =>
    x.locations.map((l) => `<td class="n">${p.locationPrices[l.code] !== undefined ? esc(peso(p.locationPrices[l.code]!)) : "—"}</td>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign before going live</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;color:#111;background:#fff}
h1{font-size:22px}h2{font-size:18px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #999;padding:4px 6px;text-align:left}td.n,th.n{text-align:right}
.sign{margin-top:40px;display:flex;gap:48px}.sign div{flex:1;border-top:1px solid #000;padding-top:4px}
@media print{body{margin:10mm}}
</style></head><body>
<h1>${esc(x.storeName)} — Sign before going live</h1>
<p>Made: ${esc(x.generatedAt)}. Check every line. If something is wrong, fix it in the CSV and import again.</p>
<h2>Products and prices (${x.products.length})</h2>
<table><thead><tr><th>SKU</th><th>Name</th><th>Sold as</th><th class="n">Cost</th><th class="n">Price</th>${x.locations.map((l) => `<th class="n">${esc(l.code)}</th>`).join("")}<th>Correct?</th></tr></thead><tbody>
${x.products.map((p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.soldAs)}</td><td class="n">${esc(peso(p.costMinor))}</td><td class="n">${esc(peso(p.priceMinor))}</td>${priceCells(p)}<td></td></tr>`).join("\n")}
</tbody></table>
<p>"—" = the main price is used at that location.</p>
<h2>Customer credit (${x.customers.filter((c) => c.utangMinor > 0).length} owe money · total ${esc(peso(totalUtang))})</h2>
<table><thead><tr><th>Name</th><th>Mobile</th><th class="n">Limit</th><th class="n">Owes now</th><th>Since</th><th>Correct?</th></tr></thead><tbody>
${x.customers.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td class="n">${c.limitMinor ? esc(peso(c.limitMinor)) : "—"}</td><td class="n">${esc(peso(c.utangMinor))}</td><td>${esc(c.utangSince ?? "")}</td><td></td></tr>`).join("\n")}
<tr><th colspan="3">Total</th><th class="n">${esc(peso(totalUtang))}</th><th colspan="2"></th></tr>
</tbody></table>
<p>Staff: ${x.staffCount} · Porters: ${x.kargadorCount}</p>
<div class="sign"><div>Owner signature and date</div><div>Signature of the person who typed it in, and date</div></div>
</body></html>
`;
}
