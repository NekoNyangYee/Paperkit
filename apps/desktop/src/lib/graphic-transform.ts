import type { GraphicObject } from "./preview";
import { pdfDelta } from "./coordinates";
export type Box = { left: number; top: number; width: number; height: number };
export function graphicBox(points: number[][]): Box {
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}
export function graphicTransform(object: GraphicObject, next: Box): number[] | null {
  const old = graphicBox(object.screenBounds);
  if (old.width <= 0 || old.height <= 0) return null;
  const points = [0, 1, 3].map((i) => {
    const [x, y] = object.screenBounds[i];
    const delta = pdfDelta(
      object,
      next.left + ((x - old.left) * next.width) / old.width - x,
      next.top + ((y - old.top) * next.height) / old.height - y,
    );
    return delta && [object.bounds[i][0] + delta[0], object.bounds[i][1] + delta[1]];
  });
  const [p, q, r] = points;
  if (!p || !q || !r) return null;
  const [a, b, , c] = object.bounds;
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    vx = c[0] - a[0],
    vy = c[1] - a[1],
    det = ux * vy - uy * vx;
  if (Math.abs(det) < 0.00001) return null;
  const aa = ((q[0] - p[0]) * vy - (r[0] - p[0]) * uy) / det;
  const cc = ((r[0] - p[0]) * ux - (q[0] - p[0]) * vx) / det;
  const bb = ((q[1] - p[1]) * vy - (r[1] - p[1]) * uy) / det;
  const dd = ((r[1] - p[1]) * ux - (q[1] - p[1]) * vx) / det;
  return [aa, bb, cc, dd, p[0] - aa * a[0] - cc * a[1], p[1] - bb * a[0] - dd * a[1]].map((v) =>
    v === 0 ? 0 : v,
  );
}
