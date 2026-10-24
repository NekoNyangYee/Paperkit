import { detectAlignment } from "./alignment";
import type { TextGroup, TextObject, TextSelection } from "./types";

export function groupSelection(group: TextGroup, objects: TextObject[]): TextSelection | null {
  const sources = group.runs.map((run) => objects.find((o) => o.id === run.object));
  const first = sources[0];
  if (!first || sources.some((o) => !o) || !group.bounds.length) return null;
  const cover = (polygons: number[][][]) => {
    const points = polygons.flat();
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [
      [Math.min(...xs), Math.min(...ys)],
      [Math.max(...xs), Math.min(...ys)],
      [Math.max(...xs), Math.max(...ys)],
      [Math.min(...xs), Math.max(...ys)],
    ];
  };
  return {
    ...first,
    originalAlignment: detectAlignment(sources as TextObject[]),
    id: -1 - group.id,
    text: group.text,
    group,
    font: new Set(sources.map((o) => o!.font)).size > 1 ? "혼합" : first.font,
    bounds: cover(group.bounds),
    screenBounds: cover(group.screenBounds),
    editBlocked: group.editBlocked,
    fontChangeBlocked: group.canChangeFont
      ? null
      : "이 블록은 서식이나 경계가 복잡합니다. 객체 선택에서 글꼴을 변경해 주세요.",
  };
}
