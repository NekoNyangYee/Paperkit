import type { TextObject } from "@/shared/pdf/types";

// Solve the rendered quad's two axes, including page rotation and zoom.
export function pdfDelta(
  object: Pick<TextObject, "bounds" | "screenBounds">,
  x: number,
  y: number,
): [number, number] | null {
  const [p, q, , r] = object.screenBounds;
  const ax = q[0] - p[0],
    ay = q[1] - p[1],
    bx = r[0] - p[0],
    by = r[1] - p[1];
  const determinant = ax * by - ay * bx;
  if (!Number.isFinite(determinant)) return null;
  if (Math.abs(determinant) < 0.001) {
    // Hairlines can round to a zero-height/width quad. Page rendering is a
    // uniform scale plus rotation and Y reflection, so one visible axis still
    // determines the page coordinate conversion without inventing a hit area.
    let best: { length: number; a: number; b: number } | null = null;
    for (let i = 0; i < object.screenBounds.length; i++) {
      for (let j = i + 1; j < object.screenBounds.length; j++) {
        const sx = object.screenBounds[j][0] - object.screenBounds[i][0];
        const sy = object.screenBounds[j][1] - object.screenBounds[i][1];
        const length = sx * sx + sy * sy;
        if (length < 0.001 || (best && best.length >= length)) continue;
        const px = object.bounds[j][0] - object.bounds[i][0];
        const py = object.bounds[j][1] - object.bounds[i][1];
        best = { length, a: (px * sx - py * sy) / length, b: (px * sy + py * sx) / length };
      }
    }
    return best ? [best.a * x + best.b * y, best.b * x - best.a * y] : null;
  }
  const u = (x * by - y * bx) / determinant,
    v = (ax * y - ay * x) / determinant;
  const [a, b, , c] = object.bounds;
  return [u * (b[0] - a[0]) + v * (c[0] - a[0]), u * (b[1] - a[1]) + v * (c[1] - a[1])];
}
