/** Cash a customer usually hands over: the exact total, then the next ₱100, ₱500 and ₱1,000 up. */
export function quickCash(totalMinor: number): number[] {
  if (totalMinor <= 0) return [];
  const up = (step: number) => Math.ceil(totalMinor / step) * step;
  return [...new Set([totalMinor, up(10_000), up(50_000), up(100_000)])].sort((a, b) => a - b);
}
