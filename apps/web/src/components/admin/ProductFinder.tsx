"use client";

// The product buttons for POS and Pre-order, built for 30–50+ items. One bar holds the search box,
// the size buttons and the List / Big switch; under it, one button per group (the owner's own price-list
// sections from Products → Group — Premium, Imported, Local … — or the kind of rice from the name), each
// with how many items it holds. "List" shows the products as rows like the printed price list (small
// picture, name, what is left, price lined up on the right), two columns on a tablet; "Big" is the large
// buttons with the picture on top. The group headings stay at the top of the box while it scrolls, so you always see where
// you are. With `fit`, the results scroll in their own box under the bar, so the bar, the sale and the
// buttons never leave the screen.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { finderGroups, matchesSearch, mostUsed, saveView, savedView, sizeOf, sizesFor, sortGroups, type FinderView } from "../../lib/product-find";
import { useMediaQuery } from "../../lib/use-media-query";

export default function ProductFinder<T extends { id: string; name: string; group?: string | null; photoKey?: string | null }>({ items, list, renderTile, colClass = "col-6 col-md-4 col-lg-3", clearSignal = 0, lead, footer, fit = false }: {
  items: T[];
  /** Which list the "sold most" counts belong to (pos, preorder). */
  list: string;
  /** One product: a PickTile with `layout={view === "list" ? "row" : "tile"}`. */
  renderTile: (item: T, view: FinderView) => ReactNode;
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
  const [size, setSize] = useState("");
  const [often, setOften] = useState<string[]>([]);
  const [view, setView] = useState<FinderView>("list");
  useEffect(() => { setView(savedView()); }, []);
  useEffect(() => { setOften(mostUsed(list, 8)); }, [list, items.length]);
  useEffect(() => { setQ(""); }, [clearSignal]);
  // A phone has no room for a line of group buttons: there they are one big drop-down.
  const roomy = useMediaQuery("(min-width: 768px)");
  // A new filter starts at the top of the list, never half-way down the old one.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: 0 }); }, [q, group, size, view]);

  const groupOfName = finderGroups(items);
  const groupOf = (name: string) => groupOfName.get(name) ?? "Other";
  const groups = sortGroups(groupOfName.values());
  const countIn = (g: string) => items.filter((i) => groupOf(i.name) === g).length;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true });
  // Size buttons (25kg / 5kg …) work together with the group buttons and the search box.
  const sizes = sizesFor(items.map((i) => i.name));
  const sizeOn = sizes.includes(size) ? size : "";
  const groupOn = groups.includes(group) ? group : "";
  const found = items.filter((i) => matchesSearch(i.name, q) && (!groupOn || groupOf(i.name) === groupOn) && (!sizeOn || sizeOf(i.name) === sizeOn)).sort(byName);
  const filtering = q.trim() !== "" || groupOn !== "" || sizeOn !== "";
  const oftenItems = often.map((id) => items.find((i) => i.id === id)).filter((i): i is T => !!i).slice(0, view === "list" ? 6 : 8);
  const anyPhoto = items.some((i) => !!i.photoKey);
  const grid = (rows: T[]) => view === "list" ? (
    <ul className={`pick-rows${anyPhoto ? " has-thumbs" : ""}`}>
      {rows.map((i) => <li key={i.id}>{renderTile(i, view)}</li>)}
    </ul>
  ) : (
    <div className="row g-2 mb-2">
      {rows.map((i) => <div key={i.id} className={colClass}>{renderTile(i, view)}</div>)}
    </div>
  );
  const pickView = (v: FinderView) => { setView(v); saveView(v); };
  const pickGroup = (g: string) => { setGroup(g); setQ(""); };
  const groupButtons = groups.length > 1 && roomy;

  const bar = (
    <div className="finder-bar">
      {lead}
      <div className="finder-search">
        <i className="bi bi-search position-absolute top-50 translate-middle-y ms-3 text-muted" aria-hidden="true"></i>
        <input type="text" enterKeyHint="search" autoComplete="off" className="form-control ps-5 pe-5" placeholder={lead ? "Search" : "Search: type a few letters"} aria-label="Search items"
          value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value.trim()) setGroup(""); }} />
        {q && (
          <button type="button" className="btn btn-link position-absolute top-50 end-0 translate-middle-y text-dark py-0" style={{ minWidth: 48, minHeight: 44 }} aria-label="Clear search" onClick={() => setQ("")}>
            <i className="bi bi-x-circle-fill fs-4" aria-hidden="true"></i>
          </button>
        )}
      </div>
      {sizes.length > 0 && (
        <div className="finder-sizes" role="group" aria-label="Show one size">
          {sizes.map((z) => (
            <button key={z} type="button" className={`btn text-nowrap ${sizeOn === z ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={sizeOn === z} onClick={() => setSize(sizeOn === z ? "" : z)}>{z}</button>
          ))}
        </div>
      )}
      <div className="finder-view" role="group" aria-label="How to show the items">
        <button type="button" className={`btn text-nowrap ${view === "list" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={view === "list"} aria-label="Show as a price list" title="List" onClick={() => pickView("list")}>
          <i className="bi bi-list-ul" aria-hidden="true"></i><span className="finder-view-word">List</span>
        </button>
        <button type="button" className={`btn text-nowrap ${view === "tiles" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={view === "tiles"} aria-label="Show as big buttons with pictures" title="Big buttons" onClick={() => pickView("tiles")}>
          <i className="bi bi-grid-3x2-gap" aria-hidden="true"></i><span className="finder-view-word">Big</span>
        </button>
      </div>
      {groups.length > 1 && !groupButtons && (
        <select className="form-select" style={{ flex: "1 1 10rem" }} aria-label="Show one group" value={groupOn} onChange={(e) => pickGroup(e.target.value)}>
          <option value="">Show: all ({items.length})</option>
          {groups.map((g) => <option key={g} value={g}>{g} ({countIn(g)})</option>)}
        </select>
      )}
      {groupButtons && (
        <div className="finder-groups" role="group" aria-label="Show one group">
          <button type="button" className={`btn ${groupOn === "" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={groupOn === ""} onClick={() => pickGroup("")}>
            All <span className="finder-n">{items.length}</span>
          </button>
          {groups.map((g) => (
            <button key={g} type="button" className={`btn text-nowrap ${groupOn === g ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={groupOn === g} onClick={() => pickGroup(groupOn === g ? "" : g)}>
              {g} <span className="finder-n">{countIn(g)}</span>
            </button>
          ))}
        </div>
      )}
      {filtering && <span className="finder-found text-muted text-nowrap" aria-live="polite">{found.length} of {items.length}</span>}
    </div>
  );

  const heading = (text: ReactNode, n?: number, star = false) => (
    <h3 className={`finder-heading${star ? "" : " group"}`}>
      {star && <i className="bi bi-star-fill" aria-hidden="true"></i>}{text}
      {n !== undefined && <span className="finder-heading-n">{n} {n === 1 ? "item" : "items"}</span>}
    </h3>
  );

  const results = (
    <>
      {filtering ? (
        found.length > 0 ? grid(found) : (
          <div className="text-center py-4">
            <div className="mb-2">No item matches{q.trim() ? ` "${q.trim()}"` : ""}{groupOn ? ` in ${groupOn}` : ""}{sizeOn ? ` (${sizeOn})` : ""}.</div>
            <div className="text-muted small mb-3">Try the first letters only, like &quot;din&quot; for Dinorado.</div>
            <button type="button" className="btn btn-outline-dark btn-lg" onClick={() => { setQ(""); setGroup(""); setSize(""); }}>Show all items</button>
          </div>
        )
      ) : (
        <>
          {oftenItems.length > 0 && items.length > 8 && (
            <section aria-label="Sold most here">
              {heading("Sold most here", undefined, true)}
              {grid(oftenItems)}
            </section>
          )}
          {/* Up to 8 items (two rows) are one grid: a heading per group would cost more rows than it saves. */}
          {groups.length > 1 && items.length > 8 ? groups.map((g) => {
            const rows = items.filter((i) => groupOf(i.name) === g).sort(byName);
            return (
              <section key={g} aria-label={g}>
                {heading(g, rows.length)}
                {grid(rows)}
              </section>
            );
          }) : grid([...items].sort(byName))}
        </>
      )}
      {footer}
    </>
  );

  return (
    <>
      {bar}
      {fit ? <div className="fit-scroll finder-results" ref={box}>{results}</div> : <div className="finder-results" ref={box}>{results}</div>}
    </>
  );
}
