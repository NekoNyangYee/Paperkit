import { groupSelection, type TextObject, type TextSelection, type TextGroup } from "./preview";

export function mergeSelection(
  selections: TextSelection[],
  objects: TextObject[],
): TextSelection | null {
  if (selections.length < 2 || selections.length > 32 || selections.some((s) => !s.group?.canFlow))
    return null;
  const ordered = [...selections].sort(
    (a, b) =>
      Math.max(...b.bounds.map((p) => p[1])) - Math.max(...a.bounds.map((p) => p[1])) ||
      Math.min(...a.bounds.map((p) => p[0])) - Math.min(...b.bounds.map((p) => p[0])),
  );
  const group: TextGroup = {
    id: 1_000_000,
    kind: "paragraph",
    text: "",
    runs: [],
    bounds: [],
    screenBounds: [],
    uncertain: false,
    editBlocked: null,
    canFlow: true,
  };
  const ids = new Set<number>();
  for (const selection of ordered) {
    const source = selection.group!;
    if (source.runs.some((r) => ids.has(r.object))) return null;
    source.runs.forEach((r) => ids.add(r.object));
    if (group.text) group.text += "\n\n";
    const offset = Array.from(group.text).length;
    group.text += source.text;
    group.runs.push(
      ...source.runs.map((r) => ({ ...r, start: r.start + offset, end: r.end + offset })),
    );
    group.bounds.push(...source.bounds);
    group.screenBounds.push(...source.screenBounds);
  }
  const result = groupSelection(group, objects);
  return result ? { ...result, mergedGroups: ordered.map((s) => s.group!.id) } : null;
}
