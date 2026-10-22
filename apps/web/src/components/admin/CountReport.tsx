"use client";

// Rice Ops — one posted count explained in plain words: what is short or over and why, what happened to each
// item since the last count, the weight of each kind of rice (sacks and loose together), the resack jobs
// around it, and (owner) what the consignment store was charged. Staff see the pesos too.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { differenceText, downloadCsv, formatKg, pesoText, sinceText, titleCase } from "../../lib/count-view";
import { getPrinterSettings } from "../../lib/printer-settings";
import { printSlip } from "../../lib/slip-print";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
const unit = (loose: boolean, n: number) => (loose ? formatKg(n / 1000) : `${n}`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-PH", { day: "numeric", month: "short" }) : "");

interface Since { from: { docNumber: string; countedQty: number; countedAt: string } | null; buckets: Record<string, number>; ledgerShouldBe: number }
interface RLine {
  productId: string; name: string; loose: boolean; countedQty: number; expectedQty: number; firstCountedQty: number | null; varianceQty: number; varianceValueMinor: number; explainedQty: number;
  reason: string | null; reasonLabel: string | null; note: string | null; countedBy: string | null; since: Since | null;
}
interface Weight { variety: string; countedKg: number; systemKg: number; diffKg: number; complete: boolean; parts: { name: string; countedKg: number; systemKg: number }[] }
interface Resack { docNumber: string; at: string; status: string; from: string; to: string; lossGrams: number | null }
interface Charge { totalMinor: number; entries: { docNumber: string; product: string; quantity: number; amountMinor: number; undone: boolean }[] }
interface Report {
  count: { id: string; docNumber: string; kind: string; status: string; location: string; postedAt: string | null; startedAt: string; countedBy: string | null };
  summary: { counted: number; correct: number; short: number; over: number; explained: number; kulangValueMinor: number; sobraValueMinor: number };
  openedByCount: { variety: string; sacks: number; kg: number; unexplainedKg: number; automatic: boolean }[];
  lines: RLine[]; correct: { productId: string; name: string; loose: boolean; countedQty: number }[]; weight: Weight[]; resacks: Resack[]; charge: Charge | null;
}

export default function CountReport({ countId, onBack, backLabel = "← Counts", embedded = false }: { countId: string; onBack?: () => void; backLabel?: string; embedded?: boolean }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storeName, setStoreName] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch(`${API_URL}/admin/counts/${countId}/report`, { headers: adminHeaders() });
      const d = (await res.json().catch(() => null)) as ApiBody | null;
      if (!live) return;
      if (!res.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Could not open the report"); return; }
      setReport(d as unknown as Report);
    })().catch(() => { if (live) setError("Could not open the report"); });
    void fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setStoreName(d?.store?.name ?? ""); }).catch(() => {});
    return () => { live = false; };
  }, [countId]);

  if (!report) {
    return (
      <div style={{ maxWidth: 720 }}>
        {error ? <div className="alert alert-danger">{error}</div> : <p className="text-muted">Opening the report…</p>}
        {onBack && !embedded && <button type="button" className="btn btn-outline-secondary" onClick={onBack}>{backLabel}</button>}
      </div>
    );
  }
  const { count, summary, lines } = report;
  const when = count.postedAt ? new Date(count.postedAt).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "";

  const print = () => printSlip({
    storeName: storeName || "SAM STORE", title: "COUNT REPORT", reference: count.docNumber, when: when || new Date().toLocaleString("en-PH"),
    lines: [{ label: "Store", value: count.location }, ...(count.countedBy ? [{ label: "Counted by", value: count.countedBy }] : [])],
    rows: lines.map((l) => ({
      name: l.name, qty: `${l.varianceQty > 0 ? "+" : "−"}${unit(l.loose, Math.abs(l.varianceQty))}`,
      note: `${l.explainedQty !== 0 && l.varianceValueMinor === 0 ? "covered by a resack" : `${l.varianceQty < 0 ? "short" : "over"} ${pesoText(l.varianceValueMinor)}`}${l.reasonLabel ? ` - ${l.reasonLabel}` : ""}${l.note ? ` (${l.note})` : ""}`,
    })),
    totals: [{ label: "Short", value: pesoText(summary.kulangValueMinor) }, { label: "Over", value: pesoText(summary.sobraValueMinor) }, { label: "Correct", value: `${summary.correct} of ${summary.counted}` }],
    widthMm: getPrinterSettings().widthMm === 80 ? 80 : 58,
  });
  const excel = () => downloadCsv(`count-${count.docNumber}.csv`, [
    ["Item", "Counted", "System had", "Difference", "Value (₱)", "Why", "Note", "Counted by"],
    ...lines.map((l) => [l.name, l.loose ? l.countedQty / 1000 : l.countedQty, l.loose ? l.expectedQty / 1000 : l.expectedQty, l.loose ? l.varianceQty / 1000 : l.varianceQty, l.varianceValueMinor / 100, l.reasonLabel ?? (l.explainedQty !== 0 ? "Covered by a resack" : ""), l.note ?? "", l.countedBy ?? ""]),
    ...report.correct.map((c) => [c.name, c.loose ? c.countedQty / 1000 : c.countedQty, c.loose ? c.countedQty / 1000 : c.countedQty, 0, 0, "Correct", "", ""]),
  ]);

  return (
    <div style={{ maxWidth: 760 }}>
      {!embedded && onBack && <button type="button" className="btn btn-link px-0 mb-2" onClick={onBack}>{backLabel}</button>}
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
        <div>
          <h2 className="h5 mb-0">{embedded ? "What the count found" : `${count.docNumber} · ${count.location}`}</h2>
          <div className="small text-muted">{when}{count.countedBy ? ` · counted by ${count.countedBy}` : ""}</div>
        </div>
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-outline-dark btn-sm" onClick={print}><i className="bi bi-printer me-1"></i>Print</button>
          <button type="button" className="btn btn-outline-dark btn-sm" onClick={excel}>Excel</button>
        </div>
      </div>

      <div className="row g-2 mb-3 text-center">
        <div className="col-6 col-md-3"><div className="border rounded py-2"><div className="small text-muted">Counted</div><div className="fs-4">{summary.counted}</div></div></div>
        <div className="col-6 col-md-3"><div className="border rounded py-2"><div className="small text-muted">Correct</div><div className="fs-4 text-success">{summary.correct}</div></div></div>
        <div className="col-6 col-md-3"><div className="border rounded py-2"><div className="small text-muted">Short ({summary.short})</div><div className="fs-5 text-danger">{pesoText(summary.kulangValueMinor)}</div></div></div>
        <div className="col-6 col-md-3"><div className="border rounded py-2"><div className="small text-muted">Over ({summary.over})</div><div className="fs-5">{pesoText(summary.sobraValueMinor)}</div></div></div>
      </div>

      {summary.explained > 0 && <p className="small text-muted">{summary.explained} item{summary.explained === 1 ? " is" : "s are"} explained by an opened sack that was recorded as a resack, so nothing is lost there.</p>}
      {lines.length === 0 && <div className="alert alert-success">Everything counted matches the system.</div>}
      {lines.map((l) => (
        <div key={l.productId} className="card mb-2">
          <div className="card-body py-2">
            <div className="d-flex flex-wrap justify-content-between gap-2">
              <div>
                <div className="fw-semibold">{l.name}</div>
                <div className="small text-muted">Counted {unit(l.loose, l.countedQty)}; the system had {unit(l.loose, l.expectedQty)}.{l.firstCountedQty !== null && l.firstCountedQty !== l.countedQty && <> First count: {unit(l.loose, l.firstCountedQty)}.</>}</div>
              </div>
              <div className="text-end">
                <span className={`badge ${l.varianceQty < 0 ? "text-bg-danger" : "text-bg-warning"}`}>{differenceText(l.loose, l.varianceQty)}</span>
                <div className="small">{l.explainedQty !== 0 && l.varianceValueMinor === 0 ? "Covered by a resack" : pesoText(l.varianceValueMinor)}</div>
              </div>
            </div>
            <div className="small mt-1"><span className="fw-semibold">Why:</span> {l.reasonLabel ?? "No reason given"}{l.note ? ` · ${l.note}` : ""}{l.countedBy ? <span className="text-muted"> · {l.countedBy}</span> : null}</div>
            {l.since && (
              <div className="small text-muted mt-1">
                {l.since.from ? <>Last count {l.since.from.docNumber} ({day(l.since.from.countedAt)}): {unit(l.loose, l.since.from.countedQty)}.</> : <>No earlier count, so it starts from 0.</>}{" "}
                Since then: {sinceText(l.loose, l.since.buckets)}. The records say {unit(l.loose, l.since.ledgerShouldBe)}.
              </div>
            )}
          </div>
        </div>
      ))}

      {report.openedByCount.length > 0 && (
        <div className="alert alert-info py-2">
          <strong>Sacks opened and recorded by this count</strong>
          <ul className="small mb-0">
            {report.openedByCount.map((o) => (
              <li key={o.variety}>
                {titleCase(o.variety)}: {o.sacks} sack{o.sacks === 1 ? "" : "s"} opened, {formatKg(o.kg)} now loose{o.automatic ? " (recorded automatically)" : ""}.
                {o.unexplainedKg > 0.0005 && <> {formatKg(o.unexplainedKg)} of the loose rice is still extra.</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.weight.length > 0 && (
        <div className="card mb-3">
          <div className="card-header fw-semibold">Rice by weight</div>
          <div className="table-responsive">
            <table className="table table-sm mb-0 align-middle" style={{ fontVariantNumeric: "tabular-nums" }}>
              <thead><tr><th>Kind</th><th className="text-end">Counted</th><th className="text-end">System</th><th className="text-end">Difference</th></tr></thead>
              <tbody>
                {report.weight.map((w) => (
                  <tr key={w.variety}>
                    <td>{titleCase(w.variety)}{!w.complete && <div className="small text-muted">Not every item of this kind was counted</div>}</td>
                    <td className="text-end">{formatKg(w.countedKg)}</td>
                    <td className="text-end">{formatKg(w.systemKg)}</td>
                    <td className={`text-end ${w.diffKg < 0 ? "text-danger" : w.diffKg > 0 ? "text-warning-emphasis" : "text-success"}`}>{w.diffKg === 0 ? "Matches" : `${w.diffKg > 0 ? "+" : "−"}${formatKg(Math.abs(w.diffKg))}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-footer small text-muted">Sacks and loose rice together. If a sack was opened, the sack count and the loose rice cancel out here.</div>
        </div>
      )}

      {report.resacks.length > 0 && (
        <div className="card mb-3">
          <div className="card-header fw-semibold">Resack around this count</div>
          <ul className="list-group list-group-flush small">
            {report.resacks.map((r) => (
              <li key={r.docNumber} className="list-group-item">
                <strong>{r.docNumber}</strong> · {day(r.at)} · {r.status === "FINISHED" ? "Done" : "In progress"}<br />
                {r.from} → {r.to || "…"}{r.lossGrams ? ` (loss ${formatKg(r.lossGrams / 1000)})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.charge && (
        <div className="alert alert-light border">
          <strong>Charged to this store: {pesoText(report.charge.totalMinor)}</strong> for the rice that is short (at the main store&apos;s cost).
          <ul className="small mb-0 mt-1">
            {report.charge.entries.map((e) => <li key={e.docNumber}>{e.docNumber} · {e.product} · {pesoText(e.amountMinor)}{e.undone ? " (undone)" : ""}</li>)}
          </ul>
        </div>
      )}

      {report.correct.length > 0 && (
        <details className="mb-3">
          <summary className="fw-semibold">Correct items ({report.correct.length})</summary>
          <ul className="list-group mt-2">
            {report.correct.map((c) => <li key={c.productId} className="list-group-item d-flex justify-content-between"><span>{c.name}</span><span>{unit(c.loose, c.countedQty)}</span></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
