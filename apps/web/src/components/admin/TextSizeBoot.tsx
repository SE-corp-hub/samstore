"use client";

import { useEffect } from "react";
import { applyTextSize, readTextSize } from "../../lib/text-size";

/**
 * Keeps the saved text size on <html> while an /admin page is open (the inline script in the
 * layout handles the first paint; this covers client-side navigation into /admin) and takes it
 * off again when the admin pages are left, so the storefront keeps its own sizes.
 */
export default function TextSizeBoot() {
  useEffect(() => {
    applyTextSize(readTextSize());
    return () => { document.documentElement.removeAttribute("data-text-size"); };
  }, []);
  return null;
}
