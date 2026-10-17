// Rice Ops M5 — a phone photo (paper slip, delivery slip) shrunk to a JPEG the server
// accepts (≤ 400 KB): longest side 1000 px, quality stepped down until it fits.
const MAX_BYTES = 400_000;

export async function photoToJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("Could not read the photo"));
      i.src = url;
    });
    let side = 1000;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, side / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not read the photo");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", attempt < 3 ? 0.7 - attempt * 0.15 : 0.4);
      // base64 → bytes ≈ length × 3/4
      if ((data.length - data.indexOf(",") - 1) * 0.75 <= MAX_BYTES) return data;
      side = Math.round(side * 0.75);
    }
    throw new Error("The photo is too big — take it again from closer");
  } finally {
    URL.revokeObjectURL(url);
  }
}
