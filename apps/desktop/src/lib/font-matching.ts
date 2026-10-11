import type { FontInfo, TextSelection } from "./preview";

// Match the writer's unchanged-prefix/suffix style assignment, in Unicode characters.
export function textBySource(selection: TextSelection, value: string): Map<number, string> {
  if (!selection.group) return new Map([[selection.id, value.replace(/\n/g, "")]]);
  const old = Array.from(selection.text),
    next = Array.from(value);
  const styles = new Array<number>(old.length);
  for (const run of selection.group.runs)
    for (let i = run.start; i < run.end; i++) styles[i] = run.object;
  let previous = selection.group.runs[0].object;
  for (let i = 0; i < styles.length; i++) {
    if (styles[i] === undefined) styles[i] = previous;
    else previous = styles[i];
  }
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(old.length, next.length) && old[prefix] === next[prefix]) prefix++;
  while (
    suffix < Math.min(old.length, next.length) - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const inserted = styles[prefix] ?? styles.at(-1) ?? previous;
  const result = new Map<number, string>();
  next.forEach((ch, i) => {
    const id =
      i < prefix
        ? styles[i]
        : i >= next.length - suffix
          ? styles[old.length - (next.length - i)]
          : inserted;
    if (ch !== "\n") result.set(id, (result.get(id) ?? "") + ch);
  });
  return result;
}

// Static faces only: a variable font's default Thin face is not a Regular match.
export function fallbackCandidates(name: string, fonts: FontInfo[]): FontInfo[] {
  const clean = name.replace(/^[A-Z]{6}\+/, "").toLowerCase();
  const bold = /bold|black|heavy|demi/.test(clean);
  const serif = /serif|batang|myeong|times|cambria|바탕|명조/.test(clean);
  const mono = /mono|courier|coding/.test(clean);
  const ids = mono
    ? [bold ? "nanum-gothic-coding-bold" : "nanum-gothic-coding"]
    : serif
      ? [
          bold ? "nanum-myeongjo-bold" : "nanum-myeongjo",
          bold ? "gowun-batang-bold" : "gowun-batang",
        ]
      : [
          /semibold/.test(clean)
            ? "pretendard-semibold"
            : /medium/.test(clean)
              ? "pretendard-medium"
              : bold
                ? "pretendard-bold"
                : "pretendard",
          bold ? "nanum-gothic-bold" : "nanum-gothic",
        ];
  return ids.map((id) => fonts.find((f) => f.id === id)).filter((f): f is FontInfo => !!f);
}
