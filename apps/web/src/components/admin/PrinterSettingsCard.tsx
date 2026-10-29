"use client";

// Printer settings for THIS phone: paper width, auto-print after a sale, copies, and what the
// receipt says at the top (store name, address, contact) and bottom.
// Kept on the phone (each phone has its own printer). A test print shows exactly what a receipt looks like.

import { useEffect, useState } from "react";
import { cleanPrinterSettings, DEFAULT_PRINTER, getPrinterSettings, PLACEHOLDER_NAME, receiptName, savePrinterSettings, type PrinterSettings } from "../../lib/printer-settings";
import { printSlip, registeredStoreName } from "../../lib/slip-print";
import { cachedGet } from "../../lib/offlineCache";
import { toast } from "../../lib/toast";
import { bluetoothSupported, btErrorText, connectPrinter, connectedPrinterName, diagnosePrinter, printTestLine, slipLines } from "../../lib/bt-print";

export default function PrinterSettingsCard({ storeName }: { storeName?: string }) {
  const [p, setP] = useState<PrinterSettings>(DEFAULT_PRINTER);
  const [btOk, setBtOk] = useState(false);
  const [btName, setBtName] = useState<string | null>(null);
  const [report, setReport] = useState("");
  const [checking, setChecking] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);
  useEffect(() => {
    setP(getPrinterSettings()); setBtOk(bluetoothSupported()); setBtName(connectedPrinterName());
    // The registered name (also saved on this tablet, so receipts know it offline).
    setRegistered(registeredStoreName());
    void cachedGet<{ name?: string }>("/admin/settings").then((d) => { if (d?.name) setRegistered(d.name.trim() || null); });
  }, []);
  const clean = cleanPrinterSettings(p);
  // Only the top and bottom of a receipt, exactly as the Bluetooth printer lines them up.
  const lines = slipLines({
    storeName: receiptName(PLACEHOLDER_NAME, clean.name, registered), header: clean.header || null, contact: clean.contact || null,
    title: "SALES RECEIPT", footer: clean.footer || "Salamat po!",
  }, p.widthMm === 80 ? 48 : 32);
  const rule = lines.findIndex((l) => l.startsWith("---"));
  const preview = [...lines.slice(0, rule + 1), "  (items and total)", ...lines.slice(rule + 1).filter((l) => l.trim())].join("\n");
  const set = (patch: Partial<PrinterSettings>) => { const next = cleanPrinterSettings({ ...p, ...patch }); setP({ ...p, ...patch }); savePrinterSettings(next); };

  return (
    <div className="card mb-3">
      <div className="card-body">
        <h2 className="h5"><i className="bi bi-printer me-2"></i>Printer (this phone)</h2>
        <div className="fw-semibold mb-1">Paper width</div>
        <div className="btn-group mb-3" role="group" aria-label="Paper width">
          {([58, 80] as const).map((w) => (
            <button key={w} type="button" className={`btn btn-lg ${p.widthMm === w ? "btn-dark" : "btn-outline-dark"}`} onClick={() => set({ widthMm: w })}>{w} mm</button>
          ))}
        </div>
        <div className="form-check form-switch mb-2">
          <input className="form-check-input" type="checkbox" id="pr-auto" checked={p.autoPrint} onChange={(e) => set({ autoPrint: e.target.checked })} />
          <label className="form-check-label" htmlFor="pr-auto">Print the receipt right after each sale</label>
        </div>
        <div className="form-check form-switch mb-3">
          <input className="form-check-input" type="checkbox" id="pr-copies" checked={p.copies === 2} onChange={(e) => set({ copies: e.target.checked ? 2 : 1 })} />
          <label className="form-check-label" htmlFor="pr-copies">Two copies (customer and store)</label>
        </div>
        <div className="border rounded p-2 mb-3">
          <div className="form-check form-switch mb-2">
            <input className="form-check-input" type="checkbox" id="pr-bt" checked={p.bluetooth} disabled={!btOk} onChange={(e) => set({ bluetooth: e.target.checked })} />
            <label className="form-check-label" htmlFor="pr-bt">Print straight to my Bluetooth printer (no print window)</label>
          </div>
          {!btOk && <div className="small text-danger">This browser cannot print straight to Bluetooth. Use Chrome.</div>}
          {btOk && (
            <div className="d-flex flex-wrap align-items-center gap-2">
              <button type="button" className="btn btn-outline-dark" onClick={async () => {
                try { const name = await connectPrinter(); setBtName(name); toast(`Connected: ${name}`); set({ bluetooth: true }); }
                catch (e) { toast(`Could not connect: ${btErrorText(e)}`, "danger"); }
              }}><i className="bi bi-bluetooth me-1"></i>Connect printer</button>
              <span className="small text-muted">{btName ? `Connected: ${btName}` : "Not connected yet. Turn the printer on and press Connect."}</span>
            </div>
          )}
          {btOk && (
            <div className="mt-2">
              <button type="button" className="btn btn-outline-secondary btn-sm" disabled={checking} onClick={async () => { setChecking(true); setReport(await diagnosePrinter()); setBtName(connectedPrinterName()); setChecking(false); }}>
                <i className="bi bi-search me-1"></i>{checking ? "Checking…" : "Check my printer"}
              </button>
              <button type="button" className="btn btn-outline-secondary btn-sm ms-2" onClick={async () => { try { await printTestLine(p.widthMm); toast("Sent to the printer"); } catch (e) { toast(`Did not print: ${btErrorText(e)}`, "danger"); } }}>
                <i className="bi bi-printer me-1"></i>Print a test line
              </button>
              {report && (
                <>
                  <textarea className="form-control form-control-sm mt-2" rows={8} readOnly value={report} aria-label="Printer report" />
                  <button type="button" className="btn btn-link btn-sm px-0" onClick={() => { void navigator.clipboard?.writeText(report).then(() => toast("Copied")).catch(() => {}); }}>Copy the report</button>
                </>
              )}
            </div>
          )}
          <div className="small text-muted mt-2">Works with printers that use Bluetooth Low Energy. If yours does not connect or print, switch this off and the normal print window is used.</div>
        </div>
        <h3 className="h6 mt-2"><i className="bi bi-receipt me-1"></i>What the receipt says</h3>
        <label className="form-label mb-1" htmlFor="pr-name">Store name at the top</label>
        <input id="pr-name" className="form-control mb-1" maxLength={40} value={p.name} placeholder={registered ?? "Your store name"} onChange={(e) => set({ name: e.target.value })} />
        <div className="small text-muted mb-2">Leave empty to use the registered store name{registered ? ` (${registered})` : ""}.</div>
        <label className="form-label mb-1" htmlFor="pr-header">Address</label>
        <input id="pr-header" className="form-control mb-2" maxLength={80} value={p.header} placeholder="e.g. Stall 12, Public Market, Malolos" onChange={(e) => set({ header: e.target.value })} />
        <label className="form-label mb-1" htmlFor="pr-contact">Contact (phone, Facebook page)</label>
        <input id="pr-contact" className="form-control mb-2" maxLength={80} value={p.contact} placeholder="e.g. 0917 123 4567" inputMode="text" onChange={(e) => set({ contact: e.target.value })} />
        <label className="form-label mb-1" htmlFor="pr-footer">Last line (instead of "Salamat po!")</label>
        <input id="pr-footer" className="form-control mb-2" maxLength={80} value={p.footer} placeholder="Salamat po! Balik po kayo." onChange={(e) => set({ footer: e.target.value })} />
        <div className="small text-muted mb-1">How the top and bottom will look:</div>
        <pre className="border rounded bg-light p-2 small mb-3" style={{ maxWidth: "26rem", whiteSpace: "pre", overflowX: "auto" }} aria-label="Receipt preview">{preview}</pre>
        <button type="button" className="btn btn-dark btn-lg" onClick={() => printSlip({
          storeName: storeName || registered || PLACEHOLDER_NAME, title: "TEST RECEIPT", reference: "TEST-0001", when: new Date().toLocaleString("en-PH"),
          rows: [{ name: "Sinandomeng 25 kg", qty: "1  ₱1,500.00" }, { name: "Jasmine", qty: "2.500 kg  ₱150.00" }],
          totals: [{ label: "TOTAL", value: "₱1,650.00" }], footer: "Salamat po!",
        })}><i className="bi bi-printer me-1"></i>Test print</button>
        <div className="small text-muted mt-3">
          <strong>How to connect:</strong> pair the Bluetooth (or plug in the USB) receipt printer in this phone's settings first. Press Test print, then choose the printer in the print window
          (or "Save as PDF" if you have none). If the phone does not list your printer, install the printer's own print service app (many 58 mm printers come with one) and pick it there.
          These settings are saved on this phone only.
        </div>
      </div>
    </div>
  );
}
