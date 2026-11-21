// Low stock, store by store (2026-11-21).
//
// Every store has its own reorder level on its own shelf row (StockLevel.reorderThreshold, 0 = no alert).
// A rice is low AT A STORE when what is free to sell there (on hand − held for orders) is at or below that
// store's level. It is never judged on the total of all stores: 40 sacks in Bodega do not help an empty
// Lipa shelf, and the old "total vs. the biggest level" check hid exactly that.

export interface ShelfLevel {
  warehouseId: string | null;
  quantityOnHand: number;
  quantityReserved: number;
  reorderThreshold: number;
}

/** Is this one shelf low? (No level set = never low.) */
export const isLowShelf = (l: ShelfLevel): boolean => l.reorderThreshold > 0 && l.quantityOnHand - l.quantityReserved <= l.reorderThreshold;

/** The shelves of one rice that are low, emptiest first. */
export function lowShelves<T extends ShelfLevel>(levels: readonly T[]): T[] {
  return levels.filter(isLowShelf).sort((a, b) => (a.quantityOnHand - a.quantityReserved) - (b.quantityOnHand - b.quantityReserved));
}
