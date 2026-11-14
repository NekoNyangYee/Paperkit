import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), ocr: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./tesseract", () => ({ recognizeLocal: mocks.ocr }));
import { readPage } from "./read-page";
const options = () => ({
  fileId: "file",
  revision: 4,
  pageIndex: 2,
  signal: new AbortController().signal,
});
beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.ocr.mockReset().mockResolvedValue({ text: "인식한 글자", confidence: 85 });
});
it("uses full-page native text including form text without loading OCR", async () => {
  mocks.invoke.mockResolvedValue({ text: "폼 안의 글자", imageUrl: null });
  await expect(readPage(options())).resolves.toEqual({ text: "폼 안의 글자", source: "pdfium" });
  expect(mocks.ocr).not.toHaveBeenCalled();
});
it("routes only bitmap sources to local OCR and preserves confidence", async () => {
  mocks.invoke.mockResolvedValue({ text: "", imageUrl: "data:image/png;base64,AQID" });
  const input = options();
  await expect(readPage(input)).resolves.toEqual({
    text: "인식한 글자",
    confidence: 85,
    source: "tesseract",
  });
  expect(mocks.ocr).toHaveBeenCalledWith("data:image/png;base64,AQID", input.signal, undefined);
  expect(mocks.invoke).toHaveBeenCalledWith("extract_page_text", {
    fileId: "file",
    revision: 4,
    pageIndex: 2,
    forceOcr: false,
  });
});
it("does not bypass native permission errors with OCR", async () => {
  mocks.invoke.mockRejectedValue(new Error("extraction prohibited"));
  await expect(readPage(options())).rejects.toThrow("extraction prohibited");
  expect(mocks.ocr).not.toHaveBeenCalled();
});
it("discards a canceled native result before creating any OCR worker", async () => {
  const controller = new AbortController();
  mocks.invoke.mockImplementation(async () => {
    controller.abort();
    return { text: "", imageUrl: "data:image/png;base64,AQID" };
  });
  await expect(readPage({ ...options(), signal: controller.signal })).rejects.toThrow();
  expect(mocks.ocr).not.toHaveBeenCalled();
});
it("rejects remote image sources instead of sending document data to another host", async () => {
  mocks.invoke.mockResolvedValue({ text: "", imageUrl: "https://unexpected.invalid/private.png" });
  await expect(readPage(options())).rejects.toThrow("페이지 이미지를 준비하지 못했어요.");
  expect(mocks.ocr).not.toHaveBeenCalled();
});
