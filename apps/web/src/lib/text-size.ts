// Text size for the admin app (easy-to-read pass, 2026-10-31).
//
// The owner is 65: every screen defaults to 18 px text ("Large"). The choice is kept on this
// tablet only (localStorage) and applied as data-text-size on <html>, which easy-read.css turns
// into the root font size, so everything built in rem (Bootstrap buttons, fields, headings,
// badges, spacing) grows together. The /admin layout sets the attribute before the first paint.

export type TextSize = "normal" | "large" | "xl";

export const TEXT_SIZE_KEY = "sam.textSize";
const EVENT = "sam-text-size";
export const DEFAULT_TEXT_SIZE: TextSize = "large";

export const TEXT_SIZES: { id: TextSize; label: string; px: number }[] = [
  { id: "normal", label: "Normal", px: 16 },
  { id: "large", label: "Large", px: 18 },
  { id: "xl", label: "Extra large", px: 20 },
];

const isTextSize = (v: unknown): v is TextSize => v === "normal" || v === "large" || v === "xl";

/** The size saved on this tablet (Large when nothing was chosen yet). */
export function readTextSize(): TextSize {
  try {
    const v = window.localStorage.getItem(TEXT_SIZE_KEY);
    return isTextSize(v) ? v : DEFAULT_TEXT_SIZE;
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

/** Puts the size on <html> so the stylesheet can scale the page. */
export function applyTextSize(size: TextSize): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-text-size", size);
}

/** Saves the size on this tablet and applies it at once. */
export function setTextSize(size: TextSize): void {
  try { window.localStorage.setItem(TEXT_SIZE_KEY, size); } catch { /* per-tablet convenience only */ }
  applyTextSize(size);
  window.dispatchEvent(new Event(EVENT));
}

/** Lets a component follow the saved size (and changes made elsewhere on the page). */
export function subscribeTextSize(onChange: (size: TextSize) => void): () => void {
  const on = () => onChange(readTextSize());
  window.addEventListener(EVENT, on);
  window.addEventListener("storage", on);
  return () => { window.removeEventListener(EVENT, on); window.removeEventListener("storage", on); };
}

/**
 * Runs before the first paint (inline in the /admin layout) so the page never flashes small text.
 * Kept as a string: it must not depend on any module.
 */
export const TEXT_SIZE_BOOT_SCRIPT =
  `(function(){var s="${DEFAULT_TEXT_SIZE}";try{var v=localStorage.getItem("${TEXT_SIZE_KEY}");if(v==="normal"||v==="large"||v==="xl")s=v;}catch(e){}document.documentElement.setAttribute("data-text-size",s);})();`;
