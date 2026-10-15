// Rice Ops M10 — the store screens' look, as numbers that are checked by a test:
// black ink on white at 7:1 or better (readable in daylight), one action green, status
// colours that always come with a word, and sizes for older eyes and thumbs.

export const RICE_TOKENS = {
  ink: "#1C1B19",
  paper: "#FFFFFF",
  action: "#1F6F3F", // every main button, nothing else
  actionHover: "#185A33",
  waiting: "#8A5A00", // amber text "Naghihintay" (on a pale amber badge)
  waitingBg: "#FFF3D6",
  onTheWay: "#0B4F8A", // blue "Nasa daan"
  onTheWayBg: "#E3F0FB",
  short: "#A3201B", // red "Kulang"
  shortBg: "#FDE8E7",
  right: "#1F6F3F", // green "Tama"
  rightBg: "#E4F3EA",
} as const;

export const RICE_SIZES = { bodyPx: 18, numberPx: 22, totalPx: 28, minTapPx: 48 } as const;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of #RRGGBB. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a colour: ${hex}`);
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((x) => channel(parseInt(x, 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
}
