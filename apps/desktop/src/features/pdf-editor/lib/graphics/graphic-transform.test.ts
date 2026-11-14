import { expect, it } from "vitest";
import { graphicBox, graphicTransform } from "./graphic-transform";
import { pdfDelta } from "../geometry/coordinates";
import type { GraphicObject } from "@/shared/pdf/types";

it("moves a horizontal hairline whose pixel quad has zero height", () => {
  const line: GraphicObject = {
    id: 1,
    kind: "path",
    bounds: [
      [10, 20],
      [110, 20],
      [110, 20],
      [10, 20],
    ],
    screenBounds: [
      [20, 160],
      [220, 160],
      [220, 160],
      [20, 160],
    ],
  };
  const box = graphicBox(line.screenBounds);
  expect(pdfDelta(line, 20, 10)).toEqual([10, -5]);
  expect(graphicTransform(line, { ...box, left: box.left + 20, top: box.top + 10 })).toEqual([
    1, 0, 0, 1, 10, -5,
  ]);
});

it("moves a hairline on a rotated page using the remaining visible axis", () => {
  const line: GraphicObject = {
    id: 1,
    kind: "path",
    bounds: [
      [10, 20],
      [110, 20],
      [110, 20],
      [10, 20],
    ],
    screenBounds: [
      [40, 20],
      [40, 220],
      [40, 220],
      [40, 20],
    ],
  };
  const box = graphicBox(line.screenBounds);
  expect(pdfDelta(line, 20, 10)).toEqual([5, 10]);
  expect(graphicTransform(line, { ...box, left: box.left + 20, top: box.top + 10 })).toEqual([
    1, 0, 0, 1, 5, 10,
  ]);
});
