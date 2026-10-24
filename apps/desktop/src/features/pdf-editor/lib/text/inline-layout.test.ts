import { expect, it } from "vitest";
import { readInlineText } from "./inline-layout";
it("preserves inferred spaces while keeping user-entered paragraph breaks", () => {
  const element = document.createElement("div");
  element.innerHTML =
    '<span>들여쓴 첫 줄</span><br data-pdf-separator=" "><span>다음 줄</span><div>새 문단<br>다음</div>';
  expect(readInlineText(element)).toBe("들여쓴 첫 줄 다음 줄\n새 문단\n다음");
  element.querySelector("br")!.remove();
  expect(readInlineText(element)).toBe("들여쓴 첫 줄다음 줄\n새 문단\n다음");
});
