import type { FontInfo, TextObject, TextSelection } from "./preview";

const styles = [
  ["extrablack|ultrablack", 900],
  ["extrabold|ultrabold", 800],
  ["semibold|demibold", 600],
  ["extralight|ultralight", 200],
  ["thin|hairline", 100],
  ["light", 300],
  ["medium", 500],
  ["bold", 700],
  ["black|heavy", 900],
  ["regular|normal|book|roman", 400],
] as const;

function bare(name: string) {
  return name
    .replace(/^[A-Z]{6}\+/, "")
    .toLowerCase()
    .replace(/[\s_.·-]/g, "");
}
export function namedWeight(name: string): number | null {
  const value = bare(name).replace(/mt$/, "");
  return (
    styles.find(([style]) => new RegExp(`(?:${style})(?:italic|oblique)?$`).test(value))?.[1] ??
    null
  );
}
function family(name: string) {
  let value = bare(name).replace(/mt$/, "");
  // Keep italic and condensed faces separate: a weight change must not alter them.
  const italic = value.match(/(?:italic|oblique)$/)?.[0] ?? "";
  value = value.replace(/(?:italic|oblique)$/, "");
  for (const [style] of styles) {
    const next = value.replace(new RegExp(`(?:${style})$`), "");
    if (next !== value) {
      value = next;
      break;
    }
  }
  return value + italic;
}
export const weightLabel = (weight: number) =>
  ({
    100: "매우 얇게",
    200: "아주 얇게",
    300: "얇게",
    400: "보통",
    500: "중간",
    600: "약간 굵게",
    700: "굵게",
    800: "아주 굵게",
    900: "매우 굵게",
  })[weight] ?? String(weight);

export function selectionStyle(
  selected: TextSelection | null,
  objects: TextObject[],
  fonts: FontInfo[],
) {
  if (!selected)
    return { weight: null, mixed: false, variants: [] as { weight: number; id: string }[] };
  const sources = selected.group
    ? [...new Set(selected.group.runs.map((run) => run.object))]
        .map((id) => objects.find((o) => o.id === id))
        .filter((o): o is TextObject => !!o)
    : [selected];
  const weights = new Set(
    sources.map((source) => namedWeight(source.font) ?? source.fontWeight ?? null),
  );
  const families = new Set(sources.map((source) => family(source.font)));
  const variants: { weight: number; id: string }[] = [];
  if (families.size === 1) {
    for (const font of fonts) {
      const names = font.postscriptNames?.length
        ? font.postscriptNames
        : [font.id.replace(/^installed:/, ""), font.name];
      const name = names.find((name) => families.has(family(name)));
      if (!name) continue;
      const weight = namedWeight(name) ?? 400;
      if (!variants.some((variant) => variant.weight === weight))
        variants.push({ weight, id: font.id });
    }
  }
  return {
    weight: weights.size === 1 ? [...weights][0] : null,
    mixed: weights.size > 1,
    variants: variants.sort((a, b) => a.weight - b.weight),
  };
}
