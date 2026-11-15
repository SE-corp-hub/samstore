"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Caps a list (the lines of a sale or a pre-order) at `n` lines plus a sliver of the next one, so the
 * rest scrolls and the sliver shows there is more. Lines can be one or two rows tall (a changed price adds
 * the reason buttons), so the height is measured, again whenever a line or the screen changes size.
 * `on` false (or n lines or fewer) takes the cap off. `lines` is how many lines there are.
 */
export function useLinesCap<T extends HTMLElement>(on: boolean, lines: number, n = 3) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const kids = el.children;
      if (!on || kids.length <= n) { el.style.maxHeight = ""; el.classList.remove("lines-capped"); return; }
      const first = kids[0]!.getBoundingClientRect().top;
      const next = kids[n]!.getBoundingClientRect();
      const peek = Math.min(18, next.height / 3); // a sliver of line n+1: "there is more, scroll"
      el.style.maxHeight = `${Math.ceil(next.top - first + parseFloat(getComputedStyle(el).paddingTop) + peek)}px`;
      el.classList.add("lines-capped");
    };
    apply();
    if (!on) return;
    const ro = new ResizeObserver(apply);
    for (const k of Array.from(el.children)) ro.observe(k);
    const mo = new MutationObserver(() => { ro.disconnect(); for (const k of Array.from(el.children)) ro.observe(k); apply(); });
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [on, n, lines]); // `lines`: the list only exists once there is a line, so measure again when it appears
  return ref;
}
