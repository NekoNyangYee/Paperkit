import { beforeEach, expect, it, vi } from "vitest";
import { readPage } from "./read-page";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
const options = () => ({
  fileId: "file",
  revision: 4,
  pageIndex: 2,
  signal: new AbortController().signal,
});
beforeEach(() => {
  invoke.mockReset();
});

it.each([
  { source: "pdfium", text: "문서" },
  { source: "tesseract", text: "한글 English", confidence: 85 },
])("displays the native $source result", async (result) => {
  invoke.mockResolvedValue(result);
  await expect(readPage(options())).resolves.toEqual(result);
  expect(invoke).toHaveBeenCalledOnce();
});
it("cancels the registered backend job on close, even when registration is late", async () => {
  const controller = new AbortController();
  invoke.mockImplementation(async (command, args) => {
    if (command === "cancel_page_read") return;
    controller.abort();
    args.onProgress.onmessage(0);
    return { source: "tesseract", text: "late", confidence: 82 };
  });
  await expect(readPage({ ...options(), signal: controller.signal })).rejects.toThrow();
  const jobId = invoke.mock.calls[0][1].jobId;
  expect(invoke.mock.calls.slice(1)).toEqual([
    ["cancel_page_read", { jobId }],
    ["cancel_page_read", { jobId }],
  ]);
});
it("forwards progress and forced OCR to the backend", async () => {
  const onProgress = vi.fn();
  invoke.mockImplementation(async (_, args) => {
    expect(args.forceOcr).toBe(true);
    args.onProgress.onmessage(70);
    return { text: "", source: "tesseract", confidence: 0 };
  });
  await readPage({ ...options(), forceOcr: true, onProgress });
  expect(onProgress).toHaveBeenCalledWith(70);
});
it("propagates native permission errors", async () => {
  invoke.mockRejectedValue(new Error("extraction prohibited"));
  await expect(readPage(options())).rejects.toThrow("extraction prohibited");
  expect(invoke).toHaveBeenCalledOnce();
});
it("rejects an obsolete bitmap response", async () => {
  invoke.mockResolvedValue({ text: "", imageUrl: "data:image/png;base64,AQID" });
  await expect(readPage(options())).rejects.toThrow("페이지 글자");
});
