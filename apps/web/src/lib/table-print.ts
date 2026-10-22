// Print a wide table on an A4 page (landscape). The HTML builder is pure so its escaping is unit-tested.

export interface TablePrint {
  title: string;
  /** A line under the title (the store and the dates). */
  subtitle?: string;
  head: string[];
  rows: string[][];
  /** Extra rows at the bottom (totals). */
  foot?: string[][];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function tableHtml(t: TablePrint): string {
  const cells = (tag: "th" | "td", row: string[]) => row.map((c, i) => `<${tag}${i === 0 ? "" : ' class="n"'}>${esc(c)}</${tag}>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)}</title><style>
@page { size: A4 landscape; margin: 10mm; }
body { font: 12px/1.35 Arial, sans-serif; color: #000; margin: 0; }
h1 { font-size: 16px; margin: 0 0 2px; } .sub { margin: 0 0 8px; color: #333; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #999; padding: 3px 5px; text-align: left; }
th { border-bottom: 2px solid #000; } .n { text-align: right; white-space: nowrap; }
tfoot td { font-weight: bold; border-top: 2px solid #000; }
</style></head><body>
<h1>${esc(t.title)}</h1>${t.subtitle ? `<p class="sub">${esc(t.subtitle)}</p>` : ""}
<table><thead><tr>${cells("th", t.head)}</tr></thead>
<tbody>${t.rows.map((r) => `<tr>${cells("td", r)}</tr>`).join("")}</tbody>
${t.foot && t.foot.length ? `<tfoot>${t.foot.map((r) => `<tr>${cells("td", r)}</tr>`).join("")}</tfoot>` : ""}
</table></body></html>`;
}

/** Print through a hidden frame (works on phones and desktops; "Save as PDF" is in the print dialog). */
export function printTable(t: TablePrint): void {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentWindow?.document;
  if (!doc || !frame.contentWindow) { frame.remove(); return; }
  doc.open(); doc.write(tableHtml(t)); doc.close();
  setTimeout(() => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 60_000); }, 150);
}
