"use client";

// Printer settings for THIS phone: paper width, auto-print after a sale, copies, header/footer.
// Kept on the phone (each phone has its own printer). A test print shows exactly what a receipt looks like.

import { useEffect, useState } from "react";
import { cleanPrinterSettings, DEFAULT_PRINTER, getPrinterSettings, savePrinterSettings, type PrinterSettings } from "../../lib/printer-settings";
import { printSlip } from "../../lib/slip-print";
import { toast } from "../../lib/toast";
import { bluetoothSupported, connectPrinter, connectedPrinterName } from "../../lib/bt-print";

export default function PrinterSettingsCard({ storeName }: { storeName?: string }) {
  const [p, setP] = useState<PrinterSettings>(DEFAULT_PRINTER);
  const [btOk, setBtOk] = useState(false);
  const [btName, setBtName] = useState<string | null>(null);
  useEffect(() => { setP(getPrinterSettings()); setBtOk(bluetoothSupported()); setBtName(connectedPrinterName()); }, []);
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
                catch (e) { toast(e instanceof Error && e.name === "NotFoundError" ? "No printer was chosen" : `Could not connect: ${e instanceof Error ? e.message : "error"}`, "danger"); }
              }}><i className="bi bi-bluetooth me-1"></i>Connect printer</button>
              <span className="small text-muted">{btName ? `Connected: ${btName}` : "Not connected yet. Turn the printer on and press Connect."}</span>
            </div>
          )}
          <div className="small text-muted mt-2">Works with printers that use Bluetooth Low Energy. If yours does not connect or print, switch this off and the normal print window is used.</div>
        </div>
        <label className="form-label" htmlFor="pr-header">Line under the store name (address, phone)</label>
        <input id="pr-header" className="form-control mb-2" maxLength={80} value={p.header} onChange={(e) => set({ header: e.target.value })} />
        <label className="form-label" htmlFor="pr-footer">Last line (instead of "Salamat po!")</label>
        <input id="pr-footer" className="form-control mb-3" maxLength={80} value={p.footer} onChange={(e) => set({ footer: e.target.value })} />
        <button type="button" className="btn btn-dark btn-lg" onClick={() => printSlip({
          storeName: storeName || "SAM STORE", title: "TEST RECEIPT", reference: "TEST-0001", when: new Date().toLocaleString("en-PH"),
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
