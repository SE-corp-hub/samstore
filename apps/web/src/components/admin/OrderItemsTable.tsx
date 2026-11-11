"use client";

// "Items in orders": one table with every product in the orders on screen and how many sit at each stage
// (to receive, in progress, out for delivery, done), so the store sees what still has to be packed and
// handed over without opening each order. Tap a product to see which orders hold it, and open one.
// Same day and filters as the Orders list; with "Today" picked, orders still in progress count from every day.

import { useEffect, useMemo, useRef, useState } from "react";
import { cachedGet, useOffline } from "../../lib/offlineCache";

type Stage = "toReceive" | "inProgress" | "outForDelivery" | "done" | "void";
interface ItemOrder { id: string; orderNumber: string; customerName: string; status: string; stage: Stage; quantity: number; createdAt: string }
interface ItemRow { key: string; productId: string | null; productName: string; stages: Record<Stage, number>; toGive: number; orders: ItemOrder[] }
interface Summary { products: ItemRow[]; totals: Record<Stage, number> & { toGive: number } }

/** The columns, in the order an order moves. "Still to give" sits after the three open stages. */
const COLS: { id: Stage; label: string; tone: string }[] = [
  { id: "toReceive", label: "To receive", tone: "is-wait" },
  { id: "inProgress", label: "In progress", tone: "is-work" },
  { id: "outForDelivery", label: "Out for delivery", tone: "is-road" },
];
const STAGE_WORD: Record<Stage, string> = { toReceive: "To receive", inProgress: "In progress", outForDelivery: "Out for delivery", done: "Done", void: "Cancelled" };
const STAGE_BADGE: Record<Stage, string> = {
  toReceive: "text-bg-warning", inProgress: "text-bg-info", outForDelivery: "text-bg-dark", done: "text-bg-success", void: "text-bg-secondary",
};
type Show = "all" | "open" | Stage;
const SHOWS: { id: Show; label: string }[] = [
  { id: "open", label: "Still to give" },
  { id: "toReceive", label: "To receive" },
  { id: "inProgress", label: "In progress" },
  { id: "outForDelivery", label: "Out for delivery" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

const n = (v: number) => v.toLocaleString("en-PH");
const Num = ({ v, strong }: { v: number; strong?: boolean }) =>
  v > 0 ? <span className={`num ${strong ? "fw-bold" : ""}`}>{n(v)}</span> : <span className="text-muted" aria-label="none">–</span>;

export default function OrderItemsTable({ query, scopeWords, onOpenOrder, onClose }: {
  /** The Orders list's day and filters, as /admin/orders/items takes them. */
  query: string;
  /** "today and every open order", "yesterday"…: says which orders are counted. */
  scopeWords: string;
  onOpenOrder: (id: string) => void;
  onClose: () => void;
}) {
  const offline = useOffline();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>("open");
  const [find, setFind] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    cachedGet<Summary>(`/admin/orders/items?${query}`)
      .then((d) => { if (!live) return; if (d?.products) setData(d); else setError("Could not load the items. Check the connection and try again."); })
      .catch(() => { if (live) setError("Could not load the items. Check the connection and try again."); });
    return () => { live = false; };
  }, [query]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo(() => {
    const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.products ?? []).filter((p) => {
      if (words.length && !words.every((w) => p.productName.toLowerCase().includes(w))) return false;
      if (show === "all") return p.toGive + p.stages.done > 0;
      if (show === "open") return p.toGive > 0;
      return p.stages[show] > 0;
    });
  }, [data, find, show]);
  const sum = useMemo(() => rows.reduce((t, p) => {
    for (const c of ["toReceive", "inProgress", "outForDelivery", "done", "void"] as Stage[]) t[c] += p.stages[c];
    t.toGive += p.toGive;
    return t;
  }, { toReceive: 0, inProgress: 0, outForDelivery: 0, done: 0, void: 0, toGive: 0 }), [rows]);

  const countFor = (s: Show) => !data ? null : s === "all" ? data.totals.toGive + data.totals.done : s === "open" ? data.totals.toGive : data.totals[s];
  const ordersShown = (p: ItemRow) => p.orders.filter((o) => (show === "all" && o.stage !== "void") || (show === "open" ? ["toReceive", "inProgress", "outForDelivery"].includes(o.stage) : o.stage === show));

  return (
    <>
      <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="order-items-title">
        <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable order-items-modal">
          <div className="modal-content">
            <div className="modal-header">
              <div className="min-w-0 flex-grow-1 me-2">
                <h2 className="modal-title fs-4 mb-0" id="order-items-title"><i className="bi bi-table me-2" aria-hidden="true"></i>Items in orders</h2>
                <div className="text-muted">How many of each product, at each step · {scopeWords}</div>
              </div>
              <button ref={closeRef} type="button" className="btn btn-outline-dark ms-auto order-edit-close" onClick={onClose} aria-label="Close the items list">
                <i className="bi bi-x-lg" aria-hidden="true"></i>
              </button>
            </div>
            <div className="modal-body">
              {offline && <div className="alert alert-warning py-2" role="status">No connection: showing the last list saved on this tablet.</div>}

              {/* The big numbers first: what is still owed, then each step. They also pick what the table shows. */}
              <div className="items-show" role="group" aria-label="Show items">
                {SHOWS.map((s) => {
                  const c = countFor(s.id);
                  return (
                    <button key={s.id} type="button" className={`btn ${show === s.id ? "btn-dark" : "btn-outline-dark"} items-show-btn ${s.id === "open" ? "is-main" : ""}`} aria-pressed={show === s.id} onClick={() => { setShow(s.id); setOpenKey(null); }}>
                      <span className="items-show-label">{s.label}</span>
                      <span className="items-show-num num">{c === null ? "…" : n(c)}</span>
                      <span className="visually-hidden"> items</span>
                    </button>
                  );
                })}
              </div>

              <div className="input-group my-3">
                <span className="input-group-text bg-white"><i className="bi bi-search" aria-hidden="true"></i></span>
                <input type="search" className="form-control" placeholder="Find a product" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a product" />
              </div>

              {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
              {!data && !error && <div className="text-muted py-3" role="status"><span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Counting the items…</div>}
              {data && rows.length === 0 && (
                <div className="text-center py-4">
                  <i className="bi bi-check2-circle fs-1 text-success" aria-hidden="true"></i>
                  <p className="fw-bold mb-0 mt-2">{find ? "No product with that name here" : show === "open" ? "Nothing left to give. Every order is done." : "No items at this step"}</p>
                </div>
              )}

              {data && rows.length > 0 && (
                <div className="table-responsive items-table-wrap">
                  <table className="table items-table align-middle mb-0">
                    <thead>
                      <tr>
                        <th scope="col">Product</th>
                        {COLS.map((c) => <th key={c.id} scope="col" className={`text-end ${c.tone}`}>{c.label}</th>)}
                        <th scope="col" className="text-end is-give">Still to give</th>
                        <th scope="col" className="text-end is-done">Done</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => {
                        const isOpen = openKey === p.key;
                        const list = ordersShown(p);
                        return [
                          <tr key={p.key} className={`items-row ${isOpen ? "is-open" : ""}`}>
                            <th scope="row">
                              <button type="button" className="items-name" aria-expanded={isOpen} onClick={() => setOpenKey(isOpen ? null : p.key)}>
                                <i className={`bi ${isOpen ? "bi-chevron-down" : "bi-chevron-right"}`} aria-hidden="true"></i>
                                <span className="min-w-0">
                                  <span className="d-block">{p.productName}</span>
                                  <span className="d-block items-orders">{p.orders.filter((o) => o.stage !== "void").length} order{p.orders.filter((o) => o.stage !== "void").length === 1 ? "" : "s"}</span>
                                </span>
                              </button>
                            </th>
                            {COLS.map((c) => <td key={c.id} className={`text-end ${c.tone}`}><Num v={p.stages[c.id]} /></td>)}
                            <td className="text-end is-give"><Num v={p.toGive} strong /></td>
                            <td className="text-end is-done"><Num v={p.stages.done} /></td>
                          </tr>,
                          isOpen && (
                            <tr key={`${p.key}:orders`} className="items-orders-row">
                              <td colSpan={COLS.length + 3}>
                                {list.length === 0 ? <span className="text-muted">No orders at this step.</span> : (
                                  <ul className="items-order-list">
                                    {list.map((o) => (
                                      <li key={o.id}>
                                        <span className="min-w-0">
                                          <span className="fw-bold">{o.orderNumber}</span> · <span className="text-truncate">{o.customerName}</span>
                                          <span className={`badge ${STAGE_BADGE[o.stage]} ms-2`}>{STAGE_WORD[o.stage]}</span>
                                        </span>
                                        <span className="fw-bold num text-nowrap ms-auto">{n(o.quantity)} ×</span>
                                        <button type="button" className="btn btn-outline-primary" onClick={() => onOpenOrder(o.id)} aria-label={`Open order ${o.orderNumber}`}>
                                          Open
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                            </tr>
                          ),
                        ];
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">Total{rows.length > 1 ? ` · ${rows.length} products` : ""}</th>
                        {COLS.map((c) => <td key={c.id} className={`text-end ${c.tone}`}><Num v={sum[c.id]} strong /></td>)}
                        <td className="text-end is-give"><Num v={sum.toGive} strong /></td>
                        <td className="text-end is-done"><Num v={sum.done} strong /></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              {data && data.totals.void > 0 && (
                <p className="text-muted mt-2 mb-0"><i className="bi bi-info-circle me-1" aria-hidden="true"></i>{n(data.totals.void)} item{data.totals.void === 1 ? "" : "s"} in cancelled or failed orders are not counted.</p>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}
