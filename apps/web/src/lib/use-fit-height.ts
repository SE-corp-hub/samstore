"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * The selling screens (POS, Pre-order) fill exactly the space between the top bar and the bottom
 * bar, so nothing needs scrolling to be seen or tapped: only the product list scrolls, inside its own
 * box, and the sale card with its green button stays put (easy-read.css §9, `.sell-fit`).
 *
 * The height is measured, not guessed: where the element starts on the page, and the room the
 * ancestors keep under it (the padding `main` leaves for the bottom bar). So it holds for any text
 * size, both ways the tablet is held, and when a bar above (offline, upload) appears or goes.
 * With `enabled` false, or a window too short to be worth it, the element flows as usual.
 */
export function useFitHeight<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!enabled) { el.style.height = ""; return; }
    const apply = () => {
      el.style.height = "";
      const top = el.getBoundingClientRect().top + window.scrollY;
      let below = 0;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        below += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.marginBottom) || 0);
        if (p.tagName === "MAIN") break;
      }
      const h = Math.floor(window.innerHeight - top - below);
      el.style.height = h >= 360 ? `${h}px` : "";
    };
    apply();
    // The body grows or shrinks when a bar above appears (offline, "uploading"), or when the tablet turns.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(document.body);
    window.addEventListener("resize", apply);
    return () => { ro?.disconnect(); window.removeEventListener("resize", apply); el.style.height = ""; };
  }, [enabled]);
  return ref;
}
