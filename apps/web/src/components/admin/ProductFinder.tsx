"use client";

// The product buttons for POS and Pre-order, built for 50+ items: the search box stays on
// screen while scrolling, one tap filters to a variety, the items this device sells most
// come first, and the rest are grouped by variety under their own heading.

import { useEffect, useState, type ReactNode } from "react";
import { groupsFor, matchesSearch, mostUsed } from "../../lib/product-find";
import { useMediaQuery } from "../../lib/use-media-query";

export default function ProductFinder<T extends { id: string; name: string }>({ items, list, renderTile, colClass = "col-6 col-md-4 col-lg-3", clearSignal = 0 }: {
  items: T[];
  /** Which list the "sold most" counts belong to (pos, preorder). */
  list: string;
  renderTile: (item: T) => ReactNode;
  colClass?: string;
  /** Change it to empty the search box (e.g. after an item went into the sale). */
  clearSignal?: number;
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
    <div className="row g-2 mb-3">
      {rows.map((i) => <div key={i.id} className={colClass}>{renderTile(i)}</div>)}
    </div>
  );

  return (
    <>
      <div className="position-sticky top-0 bg-white pt-2 pb-2 mb-1" style={{ zIndex: 4 }}>
        <div className="position-relative">
          <i className="bi bi-search position-absolute top-50 translate-middle-y ms-3 text-muted" aria-hidden="true"></i>
          <input type="text" enterKeyHint="search" autoComplete="off" className="form-control form-control-lg ps-5 pe-5" placeholder="Search: type a few letters" aria-label="Search items"
            value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value.trim()) setGroup(""); }} />
          {q && (
            <button type="button" className="btn btn-link position-absolute top-50 end-0 translate-middle-y text-dark" style={{ minWidth: 48, minHeight: 48 }} aria-label="Clear search" onClick={() => setQ("")}>
              <i className="bi bi-x-circle-fill fs-4" aria-hidden="true"></i>
            </button>
          )}
        </div>
        {filtering && <div className="text-center text-muted small mt-1" aria-live="polite">{found.length} of {items.length} items{group ? ` · ${group}` : ""}</div>}
      </div>
      {groups.length > 1 && !roomy && (
        <select className="form-select form-select-lg mb-3" aria-label="Show one variety" value={group} onChange={(e) => { setGroup(e.target.value); setQ(""); }}>
          <option value="">Show: all varieties</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      )}
      {groups.length > 1 && roomy && (
        <div className="d-flex flex-wrap justify-content-center gap-2 mb-3" role="group" aria-label="Show one variety">
          <button type="button" className={`btn ${group === "" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={group === ""} onClick={() => setGroup("")}>All</button>
          {groups.map((g) => (
            <button key={g} type="button" className={`btn text-nowrap ${group === g ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={group === g} onClick={() => { setGroup(group === g ? "" : g); setQ(""); }}>{g}</button>
          ))}
        </div>
      )}

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
              <h3 className="h6 text-uppercase text-muted mb-2"><i className="bi bi-star-fill text-warning me-1" aria-hidden="true"></i>Sold most here</h3>
              {grid(oftenItems)}
            </>
          )}
          {groups.length > 1 ? groups.map((g) => (
            <section key={g} aria-label={g}>
              <h3 className="h6 text-uppercase text-muted border-bottom pb-1 mb-2">{g}</h3>
              {grid(items.filter((i) => groupOf(i.name) === g).sort(byName))}
            </section>
          )) : grid([...items].sort(byName))}
        </>
      )}
    </>
  );
}
