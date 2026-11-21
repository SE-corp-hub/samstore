"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { peso } from "../../lib/number-format";
import { KeyHint } from "./PosKeys";

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
  /** Change the line right here (2026-11-17: the sale card is small while picking). */
  qty?: number | string;
  /** "sack" / "kilo" / "piece" for the button names. */
  unitWord?: string;
  onMinus?: () => void;
  onPlus?: () => void;
  /** At one left, "−" becomes the trash can. */
  canMinus?: boolean;
  onRemove?: () => void;
  /** Price: opens the screen's own price card… */
  onPrice?: () => void;
  /** …or a price box shown under the line (Pre-order). */
  priceEditor?: ReactNode;
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
  const [openPrice, setOpenPrice] = useState<string | null>(null);
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
          {(l.onMinus || l.onPlus || l.onPrice || l.priceEditor) && (
            <span className="check-edit">
              {l.onPlus && (
                <span className="qty" role="group" aria-label={`How many ${l.name}`}>
                  <button type="button" className={`btn qty-btn ${l.canMinus ? "btn-outline-dark" : "btn-outline-danger"}`} disabled={busy}
                    aria-label={l.canMinus ? `One ${l.unitWord ?? ""} less ${l.name}` : `Remove ${l.name}`}
                    onClick={() => (l.canMinus ? l.onMinus?.() : l.onRemove?.())}>
                    {l.canMinus ? "−" : <i className="bi bi-trash" aria-hidden="true"></i>}
                  </button>
                  <span className="qty-num" aria-live="polite">{l.qty}</span>
                  <button type="button" className="btn btn-outline-dark qty-btn" disabled={busy} aria-label={`One ${l.unitWord ?? ""} more ${l.name}`} onClick={l.onPlus}>+</button>
                </span>
              )}
              {(l.onPrice || l.priceEditor) && (
                <button type="button" className={`btn line-edit ${openPrice === l.key ? "btn-dark" : "btn-outline-primary"}`} disabled={busy}
                  aria-expanded={l.priceEditor ? openPrice === l.key : undefined} aria-label={`Change price of ${l.name}`}
                  onClick={() => (l.priceEditor ? setOpenPrice(openPrice === l.key ? null : l.key) : l.onPrice?.())}>
                  <i className="bi bi-tag me-1" aria-hidden="true"></i>{l.priceEditor && openPrice === l.key ? "Done" : "Price"}
                </button>
              )}
              {l.onRemove && l.canMinus && (
                <button type="button" className="btn btn-outline-danger line-remove" disabled={busy} aria-label={`Remove ${l.name}`} onClick={l.onRemove}>
                  <i className="bi bi-trash" aria-hidden="true"></i>
                </button>
              )}
            </span>
          )}
          {l.priceEditor && openPrice === l.key && <div className="check-price">{l.priceEditor}</div>}
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
      <button type="button" className="btn btn-outline-dark btn-lg" disabled={busy} data-pos-esc onClick={onBack}>
        <i className="bi bi-arrow-left me-1" aria-hidden="true"></i>{backLabel}<KeyHint text="Esc" />
      </button>
      <button type="button" className="btn btn-success btn-lg fw-bold check-go" disabled={busy} data-pos-key="next" data-pos-enter onClick={onGo}>
        {busy ? "Please wait…" : <><i className="bi bi-check-lg me-1" aria-hidden="true"></i>{goLabel}<KeyHint action="next" /></>}
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
