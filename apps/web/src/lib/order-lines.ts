// How much of an order line, in words: sacks and pieces as "2×", kilo rice (kept in grams) as "1.785 kg".
// A kilo line's quantity is grams, so "1785×" would read as 1,785 sacks.
import { kg } from "./number-format";

export interface QtyLine { quantity: number; soldBy?: string | null }

/** Sold by the kilo or as "₱100 worth": the quantity is grams. */
export const isKiloLine = (l: QtyLine) => l.soldBy === "KILO" || l.soldBy === "PESO";

/** "2×" for sacks and pieces, "1.785 kg" for kilo rice. */
export const qtyText = (l: QtyLine) => (isKiloLine(l) ? kg(l.quantity) : `${l.quantity}×`);

/** "2× Alsa 25kg" or "1.785 kg Sinandomeng per kilo". */
export const lineText = (l: QtyLine & { productName: string }) => `${qtyText(l)} ${l.productName}`;
