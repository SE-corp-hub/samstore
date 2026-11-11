// Turns plain tables into an Excel workbook (.xlsx), a zip of CSV files, or JSON.
// No library: an .xlsx is a zip of a few XML files, and node:zlib does the zipping.

import { deflateRawSync } from "node:zlib";

export type ColumnType = "text" | "number" | "money" | "date" | "datetime";
export interface Column { header: string; type: ColumnType; width?: number }
export type Cell = string | number | boolean | Date | null | undefined;
export interface Table { name: string; columns: Column[]; rows: Cell[][] }

const MANILA_MS = 8 * 3_600_000;

/** "2026-10-31 14:05" in Manila time (the store's clock), or "2026-10-31" for a date column. */
export function manilaText(d: Date, withTime: boolean): string {
  const iso = new Date(d.getTime() + MANILA_MS).toISOString();
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

function plain(v: Cell, type: ColumnType): string | number | boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return manilaText(v, type !== "date");
  return v;
}

// ─────────────────────────────── zip ───────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: { name: string; data: string | Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === "string" ? Buffer.from(f.data, "utf8") : f.data;
    const packed = deflateRawSync(raw);
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date: 1980
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(0, 12);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    parts.push(local, name, packed);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// ─────────────────────────────── CSV / JSON ───────────────────────────────

function csvField(v: string | number | boolean | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(t: Table): string {
  const lines = [t.columns.map((c) => csvField(c.header)).join(",")];
  for (const r of t.rows) lines.push(t.columns.map((c, i) => csvField(plain(r[i], c.type))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n"; // BOM: Excel reads ₱ and ñ right
}

export const fileName = (t: Table) => t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function csvZip(tables: Table[]): Buffer {
  return zip(tables.map((t) => ({ name: `${fileName(t)}.csv`, data: toCsv(t) })));
}

export function toJson(tables: Table[]): Record<string, Record<string, string | number | boolean | null>[]> {
  const out: Record<string, Record<string, string | number | boolean | null>[]> = {};
  for (const t of tables) {
    out[fileName(t)] = t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c.header, plain(r[i], c.type)])));
  }
  return out;
}

// ─────────────────────────────── xlsx ───────────────────────────────

const esc = (s: string) =>
  // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these characters: drop them
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Style ids in styles.xml below: 1 header, 2 date+time, 3 date, 4 money.
const STYLE: Record<ColumnType, number> = { text: 0, number: 0, money: 4, date: 3, datetime: 2 };
const WIDTH: Record<ColumnType, number> = { text: 18, number: 10, money: 13, date: 11, datetime: 16 };

function cellXml(ref: string, v: Cell, type: ColumnType): string {
  if (v === null || v === undefined || v === "") return "";
  const s = STYLE[type] ? ` s="${STYLE[type]}"` : "";
  if (v instanceof Date) {
    let serial = (v.getTime() + MANILA_MS) / 86_400_000 + 25569; // Excel day number, Manila clock
    if (type === "date") serial = Math.floor(serial);
    return `<c r="${ref}"${s}><v>${serial}</v></c>`;
  }
  if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : "";
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetXml(t: Table): string {
  const cols = t.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? Math.max(WIDTH[c.type], Math.min(c.header.length + 2, 30))}" customWidth="1"/>`).join("");
  const head = `<row r="1">${t.columns.map((c, i) => `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${esc(c.header)}</t></is></c>`).join("")}</row>`;
  const body = t.rows.map((r, ri) => `<row r="${ri + 2}">${t.columns.map((c, i) => cellXml(`${colName(i)}${ri + 2}`, r[i], c.type)).join("")}</row>`).join("");
  const last = `${colName(t.columns.length - 1)}${t.rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${head}${body}</sheetData>${t.rows.length ? `<autoFilter ref="A1:${last}"/>` : ""}</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Excel sheet names: at most 31 characters, none of []:*?/\ */
const sheetName = (s: string) => s.replace(/[[\]:*?/\\]/g, " ").slice(0, 31);

export function toXlsx(tables: Table[]): Buffer {
  const sheets = tables.map((t, i) => `<sheet name="${esc(sheetName(t.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const rels = tables.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  const overrides = tables.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId${tables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: STYLES },
    ...tables.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(t) })),
  ]);
}
