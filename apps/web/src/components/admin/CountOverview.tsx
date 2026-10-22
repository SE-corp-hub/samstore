"use client";

// Rice Ops — owner/manager: every item against every store — what the system holds there and when it was
// last counted — so what has not been counted for a long time stands out. Excel for the whole table.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { ageText, downloadCsv, formatKg, overviewRows, type OverviewItem } from "../../lib/count-view";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
interface Loc { id: string; name: string; type: string }
interface Data { locations: Loc[]; items: OverviewItem[] }
const unit = (loose: boolean, n: number) => (loose ? formatKg(n / 1000) : `${n}`);
const DAY = 86_400_000;

export default function CountOverview() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [byAge, setByAge] = useState(true);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_URL}/admin/counts/overview`, { headers: adminHeaders() });
      const d = (await res.json().catch(() => null)) as ApiBody | null;
      if (!res.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Could not load"); return; }
      setData(d as unknown as Data);
    })().catch(() => setError("Could not load"));
  }, []);

  if (!data) return error ? <div className="alert alert-danger">{error}</div> : <p className="text-muted">Loading…</p>;
  const rows = overviewRows(data.items, query, byAge).slice(0, 300);
  const tone = (at: string | null) => (!at ? "text-danger" : Date.now() - Date.parse(at) > 30 * DAY ? "text-warning-emphasis" : "text-muted");
  const excel = () => downloadCsv("count-all-stores.csv", [
    ["Item", ...data.locations.flatMap((l) => [`${l.name} - on hand`, `${l.name} - last counted`])],
    ...overviewRows(data.items, "", false).map((i) => [i.name, ...data.locations.flatMap((l) => {
      const c = i.cells[l.id];
      return [c ? (i.loose ? c.onHand / 1000 : c.onHand) : "", c ? (c.lastCountedAt ? new Date(c.lastCountedAt).toLocaleDateString("en-PH") : "never") : ""];
    })]),
  ]);

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <input className="form-control" style={{ maxWidth: 260 }} placeholder="Find an item…" aria-label="Find an item" value={query} onChange={(e) => setQuery(e.target.value.slice(0, 40))} />
        <div className="form-check form-switch mb-0">
          <input id="ov-age" className="form-check-input" type="checkbox" checked={byAge} onChange={(e) => setByAge(e.target.checked)} />
          <label className="form-check-label" htmlFor="ov-age">Longest not counted first</label>
        </div>
        <button type="button" className="btn btn-outline-dark ms-auto" onClick={excel}>Excel</button>
      </div>
      <div className="table-responsive">
        <table className="table table-sm table-bordered align-middle" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead><tr><th>Item</th>{data.locations.map((l) => <th key={l.id} className="text-end">{l.name}</th>)}</tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.productId}>
                <td>{i.name}</td>
                {data.locations.map((l) => {
                  const c = i.cells[l.id];
                  return (
                    <td key={l.id} className="text-end">
                      {c ? <><div>{unit(i.loose, c.onHand)}</div><div className={`small ${tone(c.lastCountedAt)}`}>{ageText(c.lastCountedAt)}</div></> : <span className="text-muted">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={data.locations.length + 1} className="text-muted">No item matches.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="small text-muted">Red: never counted there. Amber: not counted for over 30 days.</div>
    </div>
  );
}
