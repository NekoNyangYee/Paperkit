import { describe, expect, it } from "vitest";
import { errorDetail, errorFallbacks, UserFacingError, userErrorMessage } from "./errors";

describe("user error recovery", () => {
  it.each([
    new Error("HTTP 404 /v1/library/tools"),
    new TypeError("Failed to fetch"),
    { message: "SQLite error in /private/documents.db", code: "internal" },
    "PDFium FPDF_LoadPage failed at C:\\private\\report.pdf",
    { message: "서버 업데이트가 필요합니다. request_id=private-id" },
  ])("does not expose diagnostics in a library failure", (cause) => {
    expect(userErrorMessage(cause, "library")).toBe(errorFallbacks.library);
  });
  it("gives file and font recovery without losing domain classification", () => {
    const missingFont = "원본 글꼴에 입력한 문자가 없습니다. internal detail";
    expect(errorDetail(missingFont)).toBe(missingFont);
    expect(userErrorMessage(missingFont, "font")).toContain("다른 글꼴");
    expect(userErrorMessage({ code: "notFound", message: "raw path" }, "file")).toContain(
      "다시 열어",
    );
    expect(userErrorMessage("암호가 필요한 PDF입니다.", "preview")).toContain("암호가 해제된 사본");
  });
  it("preserves only explicitly authored UI errors", () => {
    const safe = "이미지 크기를 줄여 다시 선택해 주세요.";
    expect(userErrorMessage(new UserFacingError(safe), "tools")).toBe(safe);
    expect(userErrorMessage(new Error("unknown"), "save")).toBe(errorFallbacks.save);
  });
});
