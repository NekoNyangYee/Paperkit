import { invoke } from "@tauri-apps/api/core";

const cache = new Map<string, Promise<string>>();
const originalCache = new Map<number, Promise<string>>();
const originalFaces = new Set<FontFace>();
let originalContext = "";
let fontSequence = 0;
export function clearOriginalFonts() {
  if (typeof document.fonts !== "undefined")
    originalFaces.forEach((face) => document.fonts.delete(face));
  originalFaces.clear();
  originalCache.clear();
  originalContext = "";
}
function fontBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export interface FontContext {
  fileId: string;
  revision: number;
  pageIndex: number;
  objectId: number;
}
export function editorFont(name: string, original?: FontContext): Promise<string> {
  const id = name.startsWith("Pretendard")
    ? "pretendard"
    : name.startsWith("NotoSansKR")
      ? "noto-sans-kr"
      : name.startsWith("NotoSerifKR")
        ? "noto-serif-kr"
        : name === "NanumGothic"
          ? "nanum-gothic"
          : name === "NanumMyeongjo"
            ? "nanum-myeongjo"
            : null;
  const fallback = name.startsWith("Courier")
    ? '"Courier New", monospace'
    : name.startsWith("Times")
      ? '"Times New Roman", serif'
      : "Arial, sans-serif";
  if (typeof FontFace === "undefined") return Promise.resolve(fallback);
  if (original && !/^(Helvetica|Courier|Times)(-|$)/.test(name)) {
    const context = `${original.fileId}:${original.revision}:${original.pageIndex}`;
    if (originalContext !== context) {
      originalFaces.forEach((face) => document.fonts.delete(face));
      originalFaces.clear();
      originalCache.clear();
      originalContext = context;
    }
    if (!originalCache.has(original.objectId))
      originalCache.set(
        original.objectId,
        (async () => {
          const data = await invoke<string>(
            "document_font",
            original as unknown as Record<string, unknown>,
          );
          if (typeof data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(data))
            throw new Error("원본 글꼴을 읽지 못했습니다.");
          const family = `Paperkit-original-${++fontSequence}`;
          const font = await new FontFace(family, fontBytes(data)).load();
          if (originalContext !== context) throw new Error("문서가 변경되었습니다.");
          document.fonts.add(font);
          originalFaces.add(font);
          return `"${family}"`;
        })().catch((error) => {
          if (originalContext === context) originalCache.delete(original.objectId);
          throw error;
        }),
      );
    return originalCache.get(original.objectId)!;
  }
  if (!id) return Promise.resolve(fallback);
  return replacementEditorFont(id);
}

// Use the exact catalog face for both the browser and the PDF writer.
export function replacementEditorFont(id: string): Promise<string> {
  if (typeof FontFace === "undefined") return Promise.resolve("sans-serif");
  if (!cache.has(id))
    cache.set(
      id,
      (async () => {
        const data = await invoke<string>("editor_font", { fontId: id });
        if (typeof data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(data))
          throw new Error("편집 글꼴을 읽지 못했습니다.");
        const bytes = fontBytes(data);
        const family = `Paperkit-${id}`;
        const font = await new FontFace(family, bytes).load();
        document.fonts.add(font);
        return `"${family}"`;
      })().catch((error) => {
        cache.delete(id);
        throw error;
      }),
    );
  return cache.get(id)!;
}
