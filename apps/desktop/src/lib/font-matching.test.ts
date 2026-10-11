import { expect, it } from "vitest";
import { fallbackCandidates, textBySource } from "./font-matching";
import type { TextSelection } from "./preview";

const fonts = [
  "pretendard",
  "pretendard-bold",
  "pretendard-semibold",
  "nanum-myeongjo",
  "nanum-myeongjo-bold",
  "nanum-gothic-coding",
  "noto-sans-kr",
].map((id) => ({ id, name: id }));
it("matches family and weight without substituting the variable Thin default", () => {
  expect(fallbackCandidates("ABCDEF+NotoSansCJKkr-Regular", fonts)[0].id).toBe("pretendard");
  expect(fallbackCandidates("NotoSansCJKkr-Bold", fonts)[0].id).toBe("pretendard-bold");
  expect(fallbackCandidates("Inter-SemiBold", fonts)[0].id).toBe("pretendard-semibold");
  expect(fallbackCandidates("Haansoft Batang", fonts)[0].id).toBe("nanum-myeongjo");
  expect(fallbackCandidates("NotoSerifCJKkr-Bold", fonts)[0].id).toBe("nanum-myeongjo-bold");
  expect(fallbackCandidates("Courier", fonts)[0].id).toBe("nanum-gothic-coding");
  expect(fallbackCandidates("Unknown", [])).toEqual([]);
});

it("assigns inserted Unicode text to its source while preserving suffix styles", () => {
  const selected = {
    text: "제목 본문",
    group: {
      runs: [
        { object: 2, start: 0, end: 2 },
        { object: 7, start: 3, end: 5 },
      ],
    },
  } as TextSelection;
  expect([...textBySource(selected, "제목 새본문")]).toEqual([
    [2, "제목 "],
    [7, "새본문"],
  ]);
  expect([...textBySource(selected, "제목 본문🙂")]).toEqual([
    [2, "제목 "],
    [7, "본문🙂"],
  ]);
  expect([...textBySource(selected, "제목\n본문")]).toEqual([
    [2, "제목"],
    [7, "본문"],
  ]);
});
