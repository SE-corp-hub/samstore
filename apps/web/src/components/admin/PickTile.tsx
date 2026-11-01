"use client";

// One product button, the same on POS (Walk-in and Full sale) and Pre-order: the name, the price in
// big digits, what is left here, and — once it is in the sale — a green edge with "✓ 2 in sale".
// Out of stock is an amber "None left here" (careful: you may still sell at the counter), never red.
// Everything is in rem, so the tiles grow with the Text size setting.

import type { ReactNode } from "react";

export default function PickTile({ name, price, priceNote, countText, stock, stockOut = false, extra, ariaLabel, onClick }: {
  name: string;
  /** Already formatted: "₱1,600.00", or "—" when the store hides pre-order prices. */
  price: string;
  /** "/kg" for loose rice. */
  priceNote?: string;
  /** "2 in sale", "1.5 kg in sale", "3 in order" — empty when the item is not in the sale yet. */
  countText?: string;
  /** "12 left" · "None left here" · "None in stock yet". */
  stock?: string;
  /** Show `stock` as the amber careful badge. */
  stockOut?: boolean;
  /** Anything after the name, e.g. a "To review" badge. */
  extra?: ReactNode;
  ariaLabel: string;
  onClick: () => void;
}) {
  const inSale = !!countText;
  return (
    <button type="button" className={`pick-tile${inSale ? " in-sale" : ""}`} aria-pressed={inSale} aria-label={ariaLabel} onClick={onClick}>
      {inSale && <span className="pick-count"><i className="bi bi-check-lg" aria-hidden="true"></i>{countText}</span>}
      <span className="pick-name">{name}{extra}</span>
      <span className="pick-price">{price}{priceNote && <span className="pick-price-note">{priceNote}</span>}</span>
      {stock && <span className={`pick-stock${stockOut ? " out" : ""}`}>{stock}</span>}
    </button>
  );
}
