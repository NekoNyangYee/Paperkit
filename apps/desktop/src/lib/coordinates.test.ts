import { expect, it } from "vitest";
import { pdfDelta } from "./coordinates";
import type { TextObject } from "./preview";

it("maps drag vectors through zoom, rotation and crop translation", () => {
  const bounds = [
    [10, 20],
    [110, 20],
    [110, 40],
    [10, 40],
  ];
  for (const [screenBounds, delta, expected] of [
    [
      [
        [100, 200],
        [300, 200],
        [300, 160],
        [100, 160],
      ],
      [20, 10],
      [10, -5],
    ],
    [
      [
        [100, 200],
        [100, 400],
        [140, 400],
        [140, 200],
      ],
      [10, 20],
      [10, 5],
    ],
    [
      [
        [0, 40],
        [400, 40],
        [400, -40],
        [0, -40],
      ],
      [40, 20],
      [10, -5],
    ],
  ]) {
    expect(
      pdfDelta({ bounds, screenBounds } as TextObject, delta[0] as number, delta[1] as number),
    ).toEqual(expected);
  }
  expect(
    pdfDelta({ bounds, screenBounds: bounds.map(() => [0, 0]) } as TextObject, 1, 1),
  ).toBeNull();
});
