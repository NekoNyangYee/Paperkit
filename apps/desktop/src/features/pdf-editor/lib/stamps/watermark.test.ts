import { expect, it } from "vitest";
import { watermarkText } from "./watermark";

it("appends the chosen date beside the existing text without changing the input", () => {
  const options = { text: "내부 검토용", date: "2026-10-25" };
  expect(watermarkText(options)).toBe("내부 검토용 2026-10-25");
  expect(options.text).toBe("내부 검토용");
  expect(watermarkText({ ...options, date: null })).toBe("내부 검토용");
  expect(watermarkText({ ...options, text: " \n " })).toBe("2026-10-25");
});
