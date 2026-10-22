// Rice Ops — pure helpers for the Supplier orders screen (no browser):
// the cost move against the last order ("price watch") and turning "To reorder" picks into a new-order draft.

export interface CostMove {
  kind: "NEW" | "SAME" | "UP" | "DOWN";
  lastMinor: number | null;
  changeMinor: number;
  pct: number;
  big: boolean;
}

const BIG_PCT = 5;

/** Same rule as the server (apps/api/src/domain/price-watch.ts): compare a cost with the supplier's last one. */
export function costMove(lastMinor: number | null | undefined, nowMinor: number): CostMove {
  if (lastMinor === null || lastMinor === undefined || lastMinor <= 0) return { kind: "NEW", lastMinor: null, changeMinor: 0, pct: 0, big: false };
  const changeMinor = nowMinor - lastMinor;
  if (changeMinor === 0) return { kind: "SAME", lastMinor, changeMinor: 0, pct: 0, big: false };
  return {
    kind: changeMinor > 0 ? "UP" : "DOWN", lastMinor, changeMinor,
    pct: Math.round((changeMinor / lastMinor) * 1000) / 10,
    big: Math.abs(changeMinor) * 100 >= BIG_PCT * lastMinor,
  };
}

/** Short words for a cost move; empty when there was no earlier cost. `money` formats centavos as pesos. */
export function moveText(m: CostMove, money: (minor: number) => string): string {
  if (m.kind === "NEW" || m.lastMinor === null) return "";
  if (m.kind === "SAME") return `Same as last time (${money(m.lastMinor)})`;
  const word = m.kind === "UP" ? "Up" : "Down";
  return `${word} ${money(Math.abs(m.changeMinor))} (${Math.abs(m.pct)}%) from ${money(m.lastMinor)}`;
}

export interface ReorderPick {
  productId: string;
  loose: boolean;
  suggestedQty: number;
  supplierId: string | null;
  lastCostMinor: number | null;
  productCostMinor: number;
}

export interface DraftRow { productId: string; qty: string; cost: string }

/** Kilos or pieces as the text boxes want them. */
const qtyBox = (loose: boolean, q: number) => String(loose ? Math.round(q) / 1000 : q);
const costBox = (minor: number) => (minor > 0 ? String(minor / 100) : "");

/** A new-order draft from the picked items: quantity from the suggestion, cost from the last order (or the item's own cost).
 *  The supplier is filled only when every pick has the same usual supplier. */
export function draftFromReorder(picks: ReorderPick[]): { supplierId: string; rows: DraftRow[] } {
  const rows = picks.map((p) => ({ productId: p.productId, qty: qtyBox(p.loose, p.suggestedQty), cost: costBox(p.lastCostMinor ?? p.productCostMinor) }));
  const sup = new Set(picks.map((p) => p.supplierId ?? ""));
  const only = sup.size === 1 ? [...sup][0]! : "";
  return { supplierId: only, rows };
}
