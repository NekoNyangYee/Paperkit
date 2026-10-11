import type { TextObject } from "./preview";
export type Alignment = "left" | "center" | "right" | "justify";
export function detectAlignment(objects: TextObject[]): Alignment {
  const lines: number[][] = [];
  for (const object of [...objects].sort((a, b) => b.matrix[5] - a.matrix[5])) {
    const left = object.matrix[4],
      right = Math.max(left, ...object.bounds.map((p) => p[0]));
    const last = lines.at(-1);
    if (last && Math.abs(last[0] - object.matrix[5]) < 1) {
      last[1] = Math.min(last[1], left);
      last[2] = Math.max(last[2], right);
    } else lines.push([object.matrix[5], left, right]);
  }
  if (lines.length < 2) return "left";
  const spread = (f: (line: number[]) => number) =>
    Math.max(...lines.map(f)) - Math.min(...lines.map(f));
  if (spread((l) => l[1]) > 2 && spread((l) => (l[1] + l[2]) / 2) < 1.5) return "center";
  if (spread((l) => l[1]) > 2 && spread((l) => l[2]) < 1.5) return "right";
  return "left";
}
