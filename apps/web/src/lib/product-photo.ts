// Product pictures: the address of a product's picture, and shrinking a camera photo on the tablet
// before it is sent (a 12 MP photo becomes about 480 px and 30–60 KB, so it uploads on weak signal
// and the tablet can keep every picture for offline use; see public/sw.js).

import { API_URL } from "../config";

/** The picture's address, or null when the product has none. */
export function photoUrl(photoKey: string | null | undefined): string | null {
  return photoKey ? `${API_URL}/public/product-photo/${encodeURIComponent(photoKey)}` : null;
}

/** Longest side of the saved picture, in pixels: sharp on a 4-to-a-row tile and in the product form. */
export const PHOTO_SIDE = 480;

/** A picture file (camera or gallery) → a small JPEG "data:" address ready to upload. */
export async function shrinkPhoto(file: File, side = PHOTO_SIDE): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a picture (JPG or PNG)");
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("This picture cannot be opened — try another one"));
      i.src = src;
    });
    const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This picture cannot be opened — try another one");
    ctx.fillStyle = "#fff"; // a see-through PNG gets a white background, not black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(src);
  }
}
