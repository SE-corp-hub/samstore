"use client";

import { useEffect, useRef, useState } from "react";
import { peso } from "../../lib/number-format";

export type CheckLine = {
  key: string;
  name: string;
  /** "3 sacks", "2.5 kg", "4". */
  qtyText: string;
  /** "₱1,700 each" / "₱52 per kilo". */
  eachText: string;
  totalMinor: number;
  /** Short coloured notes on the line: a changed price, a promo, below cost. */
  notes?: { text: string; tone: "warning" | "success" | "danger" | "info" }[];
};

/**
 * "Check the order" (2026-11-17): the whole list, the store, who is buying and the total on one card
 * before Pay (POS) or Save (Pre-order), so the seller reads it back to the customer. Back goes to the
 * price list with nothing lost; the one green button goes on. Sideways the list is on the left and the
 * total with the buttons on the right; upright the list is on top and only the list scrolls.
 */
export default function OrderCheck({
  storeName, who, lines, totalMinor, itemsText, goLabel, backLabel = "Back — change", onBack, onGo, busy = false, wide = false, note, money = peso,
}: {
  storeName?: string | null;
  who: string;
  lines: CheckLine[];
  totalMinor: number;
  itemsText: string;
  goLabel: string;
  backLabel?: string;
  onBack: () => void;
  onGo: () => void;
  busy?: boolean;
  wide?: boolean;
  /** One line under the total, e.g. "Saved on this tablet, sent when the internet is back." */
  note?: string | null;
  /** How an amount is written (a login that may not see prices passes one that shows "—"). */
  money?: (minor: number) => string;
}) {
  // A long order scrolls: say so, until the last line has been seen.
  const listRef = useRef<HTMLOListElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const look = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    look();
    el.addEventListener("scroll", look, { passive: true });
    window.addEventListener("resize", look);
    return () => { el.removeEventListener("scroll", look); window.removeEventListener("resize", look); };
  }, [lines.length]);
  const list = (
    <div className="check-list-box">
    <ol ref={listRef} className="check-lines list-unstyled mb-0" aria-label={`Items in this order, ${lines.length} ${lines.length === 1 ? "line" : "lines"}`} tabIndex={0}>
      {lines.map((l, i) => (
        <li key={l.key} className="check-line">
          <span className="check-no" aria-hidden="true">{i + 1}</span>
          <span className="check-what">
            <span className="check-name">{l.name}</span>
            <span className="check-qty"><strong>{l.qtyText}</strong> × {l.eachText}</span>
            {l.notes && l.notes.length > 0 && (
              <span className="check-notes">
                {l.notes.map((n) => <span key={n.text} className={`badge text-bg-${n.tone}`}>{n.text}</span>)}
              </span>
            )}
          </span>
          <span className="check-amount">{money(l.totalMinor)}</span>
        </li>
      ))}
    </ol>
    {more && <div className="check-more" aria-hidden="true"><i className="bi bi-chevron-double-down me-1"></i>More below — slide the list up</div>}
    </div>
  );
  const who_ = (
    <dl className="check-who mb-0">
      {storeName && <div><dt><i className="bi bi-shop me-1" aria-hidden="true"></i>Store</dt><dd>{storeName}</dd></div>}
      <div><dt><i className="bi bi-person me-1" aria-hidden="true"></i>Customer</dt><dd>{who}</dd></div>
    </dl>
  );
  const total = (
    <div className="sale-total check-total" aria-live="polite">
      <span className="label">Total · {itemsText}</span><span className="amount">{money(totalMinor)}</span>
    </div>
  );
  const actions = (
    <div className="check-actions">
      <button type="button" className="btn btn-outline-dark btn-lg" disabled={busy} onClick={onBack}>
        <i className="bi bi-arrow-left me-1" aria-hidden="true"></i>{backLabel}
      </button>
      <button type="button" className="btn btn-success btn-lg fw-bold check-go" disabled={busy} onClick={onGo}>
        {busy ? "Please wait…" : <><i className="bi bi-check-lg me-1" aria-hidden="true"></i>{goLabel}</>}
      </button>
    </div>
  );
  return (
    <section className={`sale-card fit-card order-check${wide ? " wide" : ""}`} aria-labelledby="order-check-title">
      <div className="card-body">
        {wide ? (
          <div className="check-cols">
            <div className="check-left">
              <h2 id="order-check-title" className="check-title">Check the order with the customer</h2>
              {list}
            </div>
            <div className="check-right">
              {who_}
              {total}
              {note && <div className="check-note">{note}</div>}
              {actions}
            </div>
          </div>
        ) : (
          <>
            <h2 id="order-check-title" className="check-title">Check the order with the customer</h2>
            {who_}
            {list}
            {total}
            {note && <div className="check-note">{note}</div>}
            {actions}
          </>
        )}
      </div>
    </section>
  );
}
