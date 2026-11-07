"use client";

// A product's picture, small (Products list, Inventory) or as the top of a POS / Pre-order button.
// No picture, or one this tablet cannot load right now (offline and never seen before): nothing is
// shown in a button, and a plain rice-bag icon in a list, so the layout never jumps or breaks.

import { useState } from "react";
import { photoUrl } from "../../lib/product-photo";

export default function ProductPhoto({ photoKey, size, className = "" }: {
  photoKey?: string | null;
  /** "thumb" = a 3 rem square for lists (an icon when there is no picture). */
  size: "thumb";
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = photoUrl(photoKey);
  const show = url && failed !== url;
  return (
    <span className={`product-thumb product-thumb-${size} ${className}`} aria-hidden="true">
      {show ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(url)} />
        : <i className="bi bi-bag" />}
    </span>
  );
}
