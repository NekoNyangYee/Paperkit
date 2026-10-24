import { expect, it } from "vitest";
import { namedWeight, selectionStyle } from "./font-style";
import type { TextSelection } from "@/shared/pdf/types";

const source = (font: string, fontWeight?: number): TextSelection => ({
  id: 0,
  text: "Test",
  font,
  fontWeight,
  fontSize: 12,
  color: [0, 0, 0, 255],
  matrix: [1, 0, 0, 1, 0, 0],
  bounds: [],
  screenBounds: [],
  editBlocked: null,
  fontChangeBlocked: null,
});
const fonts = [
  { id: "regular", name: "Example", postscriptNames: ["Example-Regular"] },
  { id: "bold", name: "Example Bold", postscriptNames: ["Example-Bold"] },
  { id: "light", name: "Example Light", postscriptNames: ["Example-Light"] },
  { id: "italic", name: "Example Bold Italic", postscriptNames: ["Example-BoldItalic"] },
  { id: "other", name: "Other Bold", postscriptNames: ["Other-Bold"] },
];
it("detects subset names and distinguishes thin, regular, semi-bold and bold", () => {
  expect(namedWeight("ABCDEF+Example-ExtraLight")).toBe(200);
  expect(namedWeight("Example-SemiBold")).toBe(600);
  expect(namedWeight("Arial-BoldMT")).toBe(700);
  expect(namedWeight("Example-Regular")).toBe(400);
  expect(namedWeight("Example")).toBeNull();
});
it("offers actual same-family weights without changing italic or another family", () => {
  const style = selectionStyle(source("ABCDEF+Example-Regular", 400), [], fonts);
  expect(style.variants).toEqual([
    { weight: 300, id: "light" },
    { weight: 400, id: "regular" },
    { weight: 700, id: "bold" },
  ]);
  expect(style.weight).toBe(400);
});
it("uses PDF metadata for unnamed weights and does not invent unavailable variants", () => {
  expect(selectionStyle(source("UnknownFace", 300), [], fonts)).toEqual({
    weight: 300,
    mixed: false,
    variants: [],
  });
});
it("reports mixed weights while allowing one family to be made consistent", () => {
  const regular = source("Example-Regular", 400);
  const bold = { ...source("Example-Bold", 700), id: 1 };
  const selected = {
    ...regular,
    group: {
      id: 0,
      kind: "paragraph" as const,
      text: "TestTest",
      uncertain: false,
      editBlocked: null,
      bounds: [],
      screenBounds: [],
      runs: [
        { object: 0, start: 0, end: 4, objectStart: 0 },
        { object: 1, start: 4, end: 8, objectStart: 0 },
      ],
    },
  };
  expect(selectionStyle(selected, [regular, bold], fonts).mixed).toBe(true);
  expect(selectionStyle(selected, [regular, bold], fonts).variants).toHaveLength(3);
});
