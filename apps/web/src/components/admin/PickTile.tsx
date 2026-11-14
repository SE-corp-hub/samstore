"use client";

// One product button, the same on POS and Pre-order: the name, the price in
// big digits, what is left here, and — once it is in the sale — a green edge with "✓ 2 in sale".
// Out of stock is an amber "None left here" (careful: you may still sell at the counter), never red.
// Everything is in rem, so the tiles grow with the Text size setting. A product with a picture shows it
// across the top of the button (fixed height, so the grid never jumps while pictures load).

import { useState, type ReactNode } from "react";
import { photoUrl } from "../../lib/product-photo";

export default function PickTile({ name, photoKey, price, priceNote, countText, stock, stockOut = false, extra, ariaLabel, onClick, layout = "tile" }: {
  name: string;
  /** The product's picture (Products → Picture). None, or not loadable offline: the plain button. */
  photoKey?: string | null;
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
  /** "row": one line of the price list (small picture · name · on the right the price, with what is left under it). */
  layout?: "tile" | "row";
}) {
  const inSale = !!countText;
  const url = photoUrl(photoKey);
  const [failed, setFailed] = useState<string | null>(null);
  const photo = url && failed !== url ? url : null;
  // On the product buttons a whole-peso price needs no centavos: "₱1,200", but "₱52.50" stays.
  const shown = price.replace(/\.00$/, "");
  if (layout === "row") {
    return (
      <button type="button" className={`pick-row${inSale ? " in-sale" : ""}`} aria-pressed={inSale} aria-label={ariaLabel} onClick={onClick}>
        {/* The picture's place is kept on every row once any rice on the list has a picture (.has-thumbs), so the names stay in one line down the list. */}
        <span className={`pick-thumb${photo ? "" : " none"}`} aria-hidden="true">
          {photo ? <img src={photo} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(photo)} /> : <i className="bi bi-image"></i>}
        </span>
        <span className="pick-name">{name}{extra}</span>
        {/* Right side, lined up down the list: the price, and under it what is left — or, once it is in the sale, how many. */}
        <span className="pick-row-end">
          <span className="pick-price">{shown}{priceNote && <span className="pick-price-note">{priceNote}</span>}</span>
          {inSale ? <span className="pick-count"><i className="bi bi-check-lg" aria-hidden="true"></i>{countText}</span>
            : stock && <span className={`pick-stock${stockOut ? " out" : ""}`}>{stock}</span>}
        </span>
      </button>
    );
  }
  return (
    <button type="button" className={`pick-tile${inSale ? " in-sale" : ""}${photo ? " has-photo" : ""}`} aria-pressed={inSale} aria-label={ariaLabel} onClick={onClick}>
      {/* The picture is decoration: the button's name already says which rice it is. */}
      {photo && <span className="pick-photo" aria-hidden="true"><img src={photo} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(photo)} /></span>}
      {inSale && <span className="pick-count"><i className="bi bi-check-lg" aria-hidden="true"></i>{countText}</span>}
      <span className="pick-name">{name}{extra}</span>
      <span className="pick-price">{shown}{priceNote && <span className="pick-price-note">{priceNote}</span>}</span>
      {stock && <span className={`pick-stock${stockOut ? " out" : ""}`}>{stock}</span>}
    </button>
  );
}
