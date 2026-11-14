import { invoke } from "@tauri-apps/api/core";
import { UserFacingError } from "@/shared/lib/errors";
import { recognizeLocal } from "./tesseract";

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

/** Reading and editing have separate contracts: OCR never produces editable PDF object IDs. */
export async function readPage(options: ReadPageOptions): Promise<ReadPageResult> {
  options.signal.throwIfAborted();
  const value = await invoke<unknown>("extract_page_text", {
    fileId: options.fileId,
    revision: options.revision,
    pageIndex: options.pageIndex,
    forceOcr: !!options.forceOcr,
  });
  options.signal.throwIfAborted();
  if (
    !value ||
    typeof value !== "object" ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    value.text.length > 200000 ||
    !("imageUrl" in value)
  )
    throw new UserFacingError("페이지 글자를 읽지 못했어요. 다시 시도해 주세요.");
  if (value.imageUrl === null && !options.forceOcr) return { text: value.text, source: "pdfium" };
  if (
    typeof value.imageUrl !== "string" ||
    !value.imageUrl.startsWith("data:image/png;base64,") ||
    value.imageUrl.length > 32 * 1024 * 1024
  )
    throw new UserFacingError("페이지 이미지를 준비하지 못했어요. 다시 시도해 주세요.");
  const result = await recognizeLocal(value.imageUrl, options.signal, options.onProgress);
  return { ...result, source: "tesseract" };
}
