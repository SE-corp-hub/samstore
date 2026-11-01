"use client";

// The product buttons for POS and Pre-order, built for 50+ items: one bar holds the search box and
// the variety buttons (one tap filters to a variety), the items this device sells most come first,
// and the rest are grouped by variety under their own heading. With `fit`, the results scroll in
// their own box under the bar, so the bar, the sale and the buttons never leave the screen.

import { useEffect, useState, type ReactNode } from "react";
import { groupsFor, matchesSearch, mostUsed } from "../../lib/product-find";
import { useMediaQuery } from "../../lib/use-media-query";

export default function ProductFinder<T extends { id: string; name: string }>({ items, list, renderTile, colClass = "col-6 col-md-4 col-lg-3", clearSignal = 0, lead, footer, fit = false }: {
  items: T[];
  /** Which list the "sold most" counts belong to (pos, preorder). */
  list: string;
  renderTile: (item: T) => ReactNode;
  colClass?: string;
  /** Change it to empty the search box (e.g. after an item went into the sale). */
  clearSignal?: number;
  /** Shown at the start of the bar, before the search box (a heading such as "2 Tap items to add"). */
  lead?: ReactNode;
  /** Shown after the last product (e.g. the "+ New item" button), inside the scrolling box. */
  footer?: ReactNode;
  /** The parent is a fixed-height flex column (`.fit-col`): the results scroll inside `.fit-scroll`. */
  fit?: boolean;
}) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [often, setOften] = useState<string[]>([]);
  useEffect(() => { setOften(mostUsed(list, 8)); }, [list, items.length]);
  useEffect(() => { setQ(""); }, [clearSignal]);
  // A phone has no room for a dozen buttons: there the varieties are one big drop-down.
  const roomy = useMediaQuery("(min-width: 768px)");

  const groupOfName = groupsFor(items.map((i) => i.name));
  const groupOf = (name: string) => groupOfName.get(name) ?? "Other";
  const groups = [...new Set(groupOfName.values())].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const found = items.filter((i) => matchesSearch(i.name, q) && (!group || groupOf(i.name) === group)).sort(byName);
  const filtering = q.trim() !== "" || group !== "";
  const oftenItems = often.map((id) => items.find((i) => i.id === id)).filter((i): i is T => !!i);
  const grid = (rows: T[]) => (
    <div className="row g-2 mb-2">
      {rows.map((i) => <div key={i.id} className={colClass}>{renderTile(i)}</div>)}
    </div>
  );

  const bar = (
    <div className="finder-bar">
      {lead}
      <div className="finder-search">
        <i className="bi bi-search position-absolute top-50 translate-middle-y ms-3 text-muted" aria-hidden="true"></i>
        <input type="text" enterKeyHint="search" autoComplete="off" className="form-control ps-5 pe-5" placeholder="Search: type a few letters" aria-label="Search items"
          value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value.trim()) setGroup(""); }} />
        {q && (
          <button type="button" className="btn btn-link position-absolute top-50 end-0 translate-middle-y text-dark py-0" style={{ minWidth: 48, minHeight: 44 }} aria-label="Clear search" onClick={() => setQ("")}>
            <i className="bi bi-x-circle-fill fs-4" aria-hidden="true"></i>
          </button>
        )}
      </div>
      {groups.length > 1 && !roomy && (
        <select className="form-select" style={{ flex: "1 1 10rem" }} aria-label="Show one variety" value={group} onChange={(e) => { setGroup(e.target.value); setQ(""); }}>
          <option value="">Show: all varieties</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      )}
      {groups.length > 1 && roomy && (
        <div className="finder-groups" role="group" aria-label="Show one variety">
          <button type="button" className={`btn ${group === "" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={group === ""} onClick={() => setGroup("")}>All</button>
          {groups.map((g) => (
            <button key={g} type="button" className={`btn text-nowrap ${group === g ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={group === g} onClick={() => { setGroup(group === g ? "" : g); setQ(""); }}>{g}</button>
          ))}
        </div>
      )}
      {filtering && <span className="text-muted text-nowrap" aria-live="polite">{found.length} of {items.length}</span>}
    </div>
  );

  const results = (
    <>
      {filtering ? (
        found.length > 0 ? grid(found) : (
          <div className="text-center py-4">
            <div className="mb-2">No item matches{q.trim() ? ` "${q.trim()}"` : ""}{group ? ` in ${group}` : ""}.</div>
            <div className="text-muted small mb-3">Try the first letters only, like &quot;din&quot; for Dinorado.</div>
            <button type="button" className="btn btn-outline-dark btn-lg" onClick={() => { setQ(""); setGroup(""); }}>Show all items</button>
          </div>
        )
      ) : (
        <>
          {oftenItems.length > 0 && items.length > 8 && (
            <>
              <h3 className="finder-heading"><i className="bi bi-star-fill" aria-hidden="true"></i>Sold most here</h3>
              {grid(oftenItems)}
            </>
          )}
          {/* Up to 8 items (two rows) are one grid: a heading per variety would cost more rows than it saves. */}
          {groups.length > 1 && items.length > 8 ? groups.map((g) => (
            <section key={g} aria-label={g}>
              <h3 className="finder-heading group">{g}</h3>
              {grid(items.filter((i) => groupOf(i.name) === g).sort(byName))}
            </section>
          )) : grid([...items].sort(byName))}
        </>
      )}
      {footer}
    </>
  );

  return (
    <>
      {bar}
      {fit ? <div className="fit-scroll">{results}</div> : results}
    </>
  );
}
