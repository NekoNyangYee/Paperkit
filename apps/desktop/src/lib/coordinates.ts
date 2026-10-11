import type { TextObject } from "./preview";

// Solve the rendered quad's two axes, including page rotation and zoom.
export function pdfDelta(object: TextObject, x: number, y: number): [number, number] | null {
  const [p, q, , r] = object.screenBounds;
  const ax = q[0] - p[0],
    ay = q[1] - p[1],
    bx = r[0] - p[0],
    by = r[1] - p[1];
  const determinant = ax * by - ay * bx;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.001) return null;
  const u = (x * by - y * bx) / determinant,
    v = (ax * y - ay * x) / determinant;
  const [a, b, , c] = object.bounds;
  return [u * (b[0] - a[0]) + v * (c[0] - a[0]), u * (b[1] - a[1]) + v * (c[1] - a[1])];
}
