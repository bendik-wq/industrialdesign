/**
 * Builds a displacement map (PNG data URL) for a rounded rectangle / capsule of glass.
 *
 * Red encodes X offset, green encodes Y offset (128 = no offset). Pixels in the flat
 * centre are neutral; inside the bezel band the offset follows a convex (circular) profile:
 * zero where the bezel starts and steepest right at the rim, like the curved edge of a
 * real lens. Used by feDisplacementMap inside the backdrop-filter of <Glass>.
 */
const cache = new Map<string, string>();

export const makeLensMap = (
  w: number,
  h: number,
  radius: number,
  bezel: number,
  direction: 1 | -1 = -1,
): string => {
  w = Math.max(2, Math.round(w));
  h = Math.max(2, Math.round(h));
  const r = Math.min(radius, w / 2, h / 2);
  const b = Math.max(1, Math.min(bezel, Math.min(w, h) / 2));
  const key = `${w}x${h}r${r.toFixed(1)}b${b.toFixed(1)}d${direction}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const hx = w / 2 - r;
  const hy = h / 2 - r;

  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - h / 2;
    const ay = Math.abs(py);
    const qy = ay - hy;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - w / 2;
      const ax = Math.abs(px);
      const qx = ax - hx;
      // signed distance to rounded-rect edge (negative inside)
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const d = outside + Math.min(Math.max(qx, qy), 0) - r;
      const depth = -d;
      let dx = 0;
      let dy = 0;
      if (depth > 0 && depth < b) {
        // outward normal of the nearest edge
        let nx: number;
        let ny: number;
        if (qx > 0 && qy > 0) {
          nx = (Math.sign(px) * ox) / (outside || 1);
          ny = (Math.sign(py) * oy) / (outside || 1);
        } else if (qx > qy) {
          nx = Math.sign(px);
          ny = 0;
        } else {
          nx = 0;
          ny = Math.sign(py);
        }
        const t = 1 - depth / b; // 0 at inner bezel line, 1 at rim
        const mag = 1 - Math.sqrt(Math.max(0, 1 - t * t)); // circular (convex) profile
        dx = nx * mag * direction;
        dy = ny * mag * direction;
      }
      const i = (y * w + x) * 4;
      data[i] = Math.round(128 + dx * 127);
      data[i + 1] = Math.round(128 + dy * 127);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  if (cache.size > 400) cache.clear();
  cache.set(key, url);
  return url;
};
