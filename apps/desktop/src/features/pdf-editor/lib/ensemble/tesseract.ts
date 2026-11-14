import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { UserFacingError } from "@/shared/lib/errors";

// One bounded OCR job per dialog; no permanent workers or model downloads from a CDN.
export async function recognizeLocal(
  image: string,
  signal: AbortSignal,
  onProgress?: (value: number) => void,
) {
  signal.throwIfAborted();
  let worker: Worker | undefined;
  let secondPass = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 90000);
  let rejectAbort: (reason: unknown) => void = () => {};
  const canceled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const stop = () => {
    void worker?.terminate().catch(() => {});
    rejectAbort(
      new UserFacingError(
        signal.aborted
          ? "글자 읽기를 취소했습니다."
          : "글자를 읽는 데 시간이 걸리고 있어요. 다시 시도해 주세요.",
      ),
    );
  };
  controller.signal.addEventListener("abort", stop, { once: true });
  // Attach immediately: cancellation can happen while the WASM engine is loading.
  void canceled.catch(() => {});
  const task = (async () => {
    const base = new URL(`${import.meta.env.BASE_URL}ocr/`, window.location.href).href;
    worker = await createWorker(["kor", "eng"], OEM.LSTM_ONLY, {
      workerPath: `${base}worker.min.js`,
      corePath: base,
      langPath: base.replace(/\/$/, ""),
      workerBlobURL: false,
      gzip: false,
      cacheMethod: "none",
      logger: (message) => {
        if (!controller.signal.aborted && message.status === "recognizing text")
          onProgress?.(
            Math.max(
              0,
              Math.min(
                100,
                Math.round(message.progress * (secondPass ? 30 : 70)) + (secondPass ? 70 : 0),
              ),
            ),
          );
      },
      errorHandler: () => {},
    });
    if (controller.signal.aborted) {
      await worker.terminate();
      throw new UserFacingError("글자 읽기를 취소했습니다.");
    }
    // A page can have columns and titles. The library's default single-block
    // mode merges columns, so prefer automatic page segmentation first.
    await worker.setParameters({ user_defined_dpi: "180", tessedit_pageseg_mode: PSM.AUTO });
    let { data } = await worker.recognize(image, {}, { text: true });
    controller.signal.throwIfAborted();
    if (!data.text.trim() || data.confidence < 65) {
      secondPass = true;
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      const alternate = await worker.recognize(image, {}, { text: true });
      controller.signal.throwIfAborted();
      if (
        alternate.data.text.trim() &&
        (!data.text.trim() || alternate.data.confidence > data.confidence)
      )
        data = alternate.data;
    }
    if (!Number.isFinite(data.confidence) || data.text.length > 200000)
      throw new UserFacingError("인식 결과를 정리하지 못했어요. 다시 시도해 주세요.");
    onProgress?.(100);
    return { text: data.text.trim(), confidence: data.confidence };
  })();
  try {
    return await Promise.race([task, canceled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
    await worker?.terminate().catch(() => {});
  }
}
