// Keep a PDF snapshot across page navigation, edits and undo. The clipboard
// marker prevents pasting a stale object after the user copies something else.
let copied: { marker: string; source: number[] } | null = null;
export function rememberGraphic(source: number[]) {
  const marker = `paperkit-graphic:${crypto.randomUUID()}`;
  copied = { marker, source };
  return marker;
}
export function recalledGraphic(marker: string): number[] | null {
  return copied?.marker === marker ? copied.source : null;
}
export function isTextInput(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input,textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role="dialog"]',
    )
  );
}

export async function clipboardImage(file: Blob): Promise<number[]> {
  if (file.size > 32 * 1024 * 1024) throw new Error("32 MB 이하의 이미지를 사용해 주세요.");
  if (file.type === "image/png") return Array.from(new Uint8Array(await file.arrayBuffer()));
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 16 * 1024 * 1024)
      throw new Error("이미지 크기가 너무 큽니다.");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("이미지를 읽지 못했습니다."))),
        "image/png",
      ),
    );
    return Array.from(new Uint8Array(await png.arrayBuffer()));
  } finally {
    bitmap.close();
  }
}

export type GraphicContent =
  { kind: "pasteGraphic"; source: number[] } | { kind: "pasteImage"; png: number[] };

export async function readGraphicClipboard(): Promise<GraphicContent> {
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch {
    throw new Error("클립보드를 읽지 못했습니다. Ctrl+V로 붙여넣어 주세요.");
  }
  for (const item of items) {
    if (item.types.includes("text/plain")) {
      const source = recalledGraphic(await (await item.getType("text/plain")).text());
      if (source) return { kind: "pasteGraphic", source };
    }
    const type = item.types.find((type) => type.startsWith("image/"));
    if (type) return { kind: "pasteImage", png: await clipboardImage(await item.getType(type)) };
  }
  throw new Error("이미지 또는 복사한 PDF 객체를 클립보드에 넣어 주세요.");
}

export async function graphicPreview(
  url: string,
  box: { left: number; top: number; width: number; height: number },
): Promise<Blob> {
  const encoded = url.split(",")[1];
  const pixels = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([pixels], { type: "image/png" }));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(box.width));
    canvas.height = Math.max(1, Math.ceil(box.height));
    canvas
      .getContext("2d")!
      .drawImage(
        bitmap,
        box.left,
        box.top,
        box.width,
        box.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("이미지를 복사하지 못했습니다."))),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}
