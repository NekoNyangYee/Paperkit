import { Channel, invoke } from "@tauri-apps/api/core";
import { UserFacingError } from "@/shared/lib/errors";

export interface ReadPageResult {
  text: string;
  source: "pdfium" | "tesseract";
  confidence?: number;
}
export interface ReadPageOptions {
  fileId: string;
  revision: number;
  pageIndex: number;
  forceOcr?: boolean;
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
}

export async function readPage(options: ReadPageOptions): Promise<ReadPageResult> {
  const { signal, fileId, revision, pageIndex } = options;
  signal.throwIfAborted();
  const jobId = crypto.randomUUID();
  const cancel = () => {
    void invoke("cancel_page_read", { jobId }).catch(() => {});
  };
  const progress = new Channel<number>();
  progress.onmessage = (value) => {
    // Registration may finish after a close. Cancel again upon its acknowledgement.
    if (signal.aborted) {
      if (value === 0) cancel();
      return;
    }
    if (Number.isFinite(value) && value >= 0 && value <= 100) options.onProgress?.(value);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await invoke<ReadPageResult>("extract_page_text", {
      jobId,
      fileId,
      revision,
      pageIndex,
      forceOcr: !!options.forceOcr,
      onProgress: progress,
    });
    signal.throwIfAborted();
    if (
      !result ||
      typeof result.text !== "string" ||
      result.text.length > 200000 ||
      !(
        result.source === "pdfium" ||
        (result.source === "tesseract" &&
          typeof result.confidence === "number" &&
          Number.isFinite(result.confidence) &&
          result.confidence >= 0 &&
          result.confidence <= 100)
      )
    ) {
      throw new UserFacingError("페이지 글자를 읽지 못했어요. 다시 시도해 주세요.");
    }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
