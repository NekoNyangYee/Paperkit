import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
  parameters: vi.fn(),
}));
vi.mock("tesseract.js", () => ({
  createWorker: mocks.create,
  OEM: { LSTM_ONLY: 1 },
  PSM: { AUTO: "3", SINGLE_BLOCK: "6" },
}));
import { recognizeLocal } from "./tesseract";
const worker = () => ({
  recognize: mocks.recognize,
  terminate: mocks.terminate,
  setParameters: mocks.parameters,
});
beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "http://localhost:1420/" } });
  mocks.create.mockReset().mockResolvedValue(worker());
  mocks.recognize
    .mockReset()
    .mockResolvedValue({ data: { text: "  한글 English  ", confidence: 90 } });
  mocks.terminate.mockReset().mockResolvedValue(undefined);
  mocks.parameters.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
it("uses bundled models and worker assets and releases WASM after recognition", async () => {
  await expect(recognizeLocal("image", new AbortController().signal)).resolves.toEqual({
    text: "한글 English",
    confidence: 90,
  });
  expect(mocks.create).toHaveBeenCalledWith(
    ["kor", "eng"],
    1,
    expect.objectContaining({
      workerPath: "http://localhost:1420/ocr/worker.min.js",
      corePath: "http://localhost:1420/ocr/",
      langPath: "http://localhost:1420/ocr",
      workerBlobURL: false,
      gzip: false,
    }),
  );
  expect(mocks.terminate).toHaveBeenCalledOnce();
});
it("terminates an active recognition job when its dialog is closed", async () => {
  mocks.recognize.mockReturnValue(new Promise(() => {}));
  const controller = new AbortController();
  const result = recognizeLocal("image", controller.signal);
  await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalled());
  controller.abort();
  await expect(result).rejects.toThrow("취소");
  expect(mocks.terminate).toHaveBeenCalled();
});

it("prefers page layout analysis and retries a weak result with single-block recognition", async () => {
  mocks.recognize
    .mockResolvedValueOnce({ data: { text: "", confidence: 0 } })
    .mockResolvedValueOnce({ data: { text: "한글 문서 확인", confidence: 89 } });
  await expect(recognizeLocal("image", new AbortController().signal)).resolves.toEqual({
    text: "한글 문서 확인",
    confidence: 89,
  });
  expect(mocks.parameters).toHaveBeenNthCalledWith(1, {
    user_defined_dpi: "180",
    tessedit_pageseg_mode: "3",
  });
  expect(mocks.parameters).toHaveBeenNthCalledWith(2, { tessedit_pageseg_mode: "6" });
  expect(mocks.recognize).toHaveBeenCalledTimes(2);
});
it("releases a worker that finishes loading after cancellation without reading the image", async () => {
  let finish!: (value: ReturnType<typeof worker>) => void;
  mocks.create.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const controller = new AbortController();
  const result = recognizeLocal("image", controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow("취소");
  finish(worker());
  await vi.waitFor(() => expect(mocks.terminate).toHaveBeenCalled());
  expect(mocks.recognize).not.toHaveBeenCalled();
});
