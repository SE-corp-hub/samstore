"use client";

import { useEffect, useState } from "react";

/** True while the CSS media query matches (false on the server and on the first paint). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Bootstrap's lg breakpoint: a tablet held sideways (MatePad SE 11 is 1280 px wide) or a PC. */
export const WIDE = "(min-width: 992px)";
/** A tablet either way (800 px upright) or a PC: the selling screens fit the screen with no page scroll (lib/use-fit-height.ts). A phone keeps the flowing layout. */
export const FIT = "(min-width: 600px)";
/**
 * POS and Pre-order only: side by side (price list | sale) from 992 px, and also from 880 px when the screen is
 * held sideways. A tablet with bigger "Display size" in Android settings is about 985 × 615 sideways: with WIDE
 * alone it got the upright layout and the sale card shrank to one line, with Pay under the bottom bar (2026-11-22).
 */
export const SELL_WIDE = "(min-width: 992px), (min-width: 880px) and (orientation: landscape)";
