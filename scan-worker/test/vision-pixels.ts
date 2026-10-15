// The synthetic images of the GenClass Vision parity fixtures (scripts/vision-fixtures.py pixel() and image(), repeated
// in TypeScript): integers only, so Python and TypeScript make the same pixels and the fixtures need no image files.

/** scripts/vision-fixtures.py pixel(), repeated: integers only, so both languages make the same image. */
export function pixel(kind: string, x: number, y: number, w: number, h: number, seed: number): [number, number, number] {
  const fd = (a: number, b: number) => Math.floor(a / b);
  if (kind === "grad") return [fd(x * 255, Math.max(1, w - 1)), fd(y * 255, Math.max(1, h - 1)), ((x + y) * ((seed % 7) + 1)) % 256];
  if (kind === "noise") {
    const v = ((x * 73856093) ^ (y * 19349663) ^ (seed * 83492791)) & 0xffffff;
    return [v & 255, (v >> 8) & 255, (v >> 16) & 255];
  }
  if (kind === "stripes") return (fd(x, 3) + fd(y, 7) + seed) % 2 === 0 ? [230, 230, 230] : [20 + (seed % 50), 40, 90];
  const dark = seed % 2 === 1;
  const faint = fd(seed, 2) % 2 === 1;
  const bg: [number, number, number] = dark ? [24, 26, 32] : [250, 250, 248];
  const fg: [number, number, number] = dark ? (faint ? [40, 42, 48] : [220, 222, 228]) : faint ? [236, 236, 232] : [28, 30, 36];
  const bx0 = fd(w, 6);
  const by0 = fd(h, 3);
  const bx1 = w - fd(w, 6);
  const by1 = h - fd(h, 3);
  if (w >= 40 && h >= 24 && bx0 <= x && x < bx1 && by0 <= y && y < by1) {
    if (x === bx0 || x === bx1 - 1 || y === by0 || y === by1 - 1) return [20, 60, 160];
    const gx = x - bx0 - 4;
    const gy = y - by0 - fd(by1 - by0, 2) + 3;
    if (gy >= 0 && gy < 7 && gx >= 0 && gx < bx1 - bx0 - 8 && gx % 7 < 5 && (fd(gx, 7) * 2654435761 + seed) % 5 !== 0) return [255, 255, 255];
    return [37, 99, 235];
  }
  if (w >= 160 && x >= fd(w * 3, 4) && y >= 4 && y < h - 4) return [(x * 3 + seed * 11) % 256, (y * 5) % 256, 160];
  const ly = y % 14;
  if (ly >= 3 && ly < 11 && x >= 4) {
    const gx = x - 4;
    if (gx % 7 < 5 && (fd(gx, 7) * 2654435761 + fd(y, 14) * 97 + seed) % 6 !== 0) return fg;
  }
  return bg;
}

export function image(kind: string, w: number, h: number, seed: number, stride = 4): Uint8Array {
  const a = new Uint8Array(w * h * stride);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = pixel(kind, x, y, w, h, seed);
      const o = (y * w + x) * stride;
      a[o] = p[0];
      a[o + 1] = p[1];
      a[o + 2] = p[2];
      if (stride === 4) a[o + 3] = 255;
    }
  return a;
}
