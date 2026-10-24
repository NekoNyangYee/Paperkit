import { Channel, invoke } from "@tauri-apps/api/core";
import type { EditState, TextObject, TextGroup, EditAction, FontInfo, PreviewPage } from "./types";

export async function listFonts(): Promise<FontInfo[]> {
  const fonts = await invoke<unknown>("list_fonts");
  if (
    !Array.isArray(fonts) ||
    !fonts.every((f) => f && typeof f.id === "string" && typeof f.name === "string")
  )
    throw new Error("글꼴 목록을 읽지 못했습니다.");
  return fonts;
}

function isState(value: unknown): value is EditState {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    (s.pageCount === undefined || (Number.isSafeInteger(s.pageCount) && Number(s.pageCount) > 0)) &&
    Number.isSafeInteger(s.revision) &&
    Number(s.revision) >= 0 &&
    [s.dirty, s.canUndo, s.canRedo].every((v) => typeof v === "boolean")
  );
}
const numbers = (v: unknown, length: number): v is number[] =>
  Array.isArray(v) &&
  v.length === length &&
  v.every((n) => typeof n === "number" && Number.isFinite(n));
function isGroup(value: unknown): value is TextGroup {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  return (
    integer(g.id) &&
    (g.kind === "sentence" || g.kind === "paragraph") &&
    typeof g.text === "string" &&
    (g.canReflow === undefined || typeof g.canReflow === "boolean") &&
    (g.canFlow === undefined || typeof g.canFlow === "boolean") &&
    (g.canChangeFont === undefined || typeof g.canChangeFont === "boolean") &&
    typeof g.uncertain === "boolean" &&
    (g.editBlocked === null || typeof g.editBlocked === "string") &&
    [g.bounds, g.screenBounds].every(
      (v) =>
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((q) => Array.isArray(q) && q.length === 4 && q.every((p) => numbers(p, 2))),
    ) &&
    Array.isArray(g.runs) &&
    g.runs.length > 0 &&
    g.runs.every(
      (r) =>
        r &&
        [r.object, r.start, r.end, r.objectStart].every(integer) &&
        r.end > r.start &&
        r.end <= Array.from(g.text as string).length,
    )
  );
}
function isText(value: unknown): value is TextObject {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(o.id) &&
    Number(o.id) >= 0 &&
    typeof o.text === "string" &&
    typeof o.font === "string" &&
    (o.fontObjectId === undefined ||
      (Number.isSafeInteger(o.fontObjectId) && Number(o.fontObjectId) >= 0)) &&
    typeof o.fontSize === "number" &&
    Number.isFinite(o.fontSize) &&
    numbers(o.color, 4) &&
    numbers(o.matrix, 6) &&
    [o.bounds, o.screenBounds].every(
      (p) => Array.isArray(p) && p.length === 4 && p.every((v) => numbers(v, 2)),
    ) &&
    (o.editBlocked === null || typeof o.editBlocked === "string") &&
    (o.fontChangeBlocked === null || typeof o.fontChangeBlocked === "string")
  );
}

export async function editDocument(
  fileId: string,
  revision: number,
  action: EditAction,
): Promise<EditState> {
  const value = await invoke<unknown>("edit_document", { fileId, revision, action });
  if (!isState(value)) throw new Error("문서 상태 응답이 올바르지 않습니다.");
  return value;
}

export function renderPage(
  fileId: string,
  pageIndex: number,
  width: number,
  onProgress?: (percent: number) => void,
): Promise<PreviewPage> {
  return renderPageResponse(fileId, pageIndex, width, onProgress);
}

export function renderThumbnail(
  fileId: string,
  pageIndex: number,
  width: number,
): Promise<PreviewPage> {
  return renderPageResponse(fileId, pageIndex, width, undefined, true);
}

async function renderPageResponse(
  fileId: string,
  pageIndex: number,
  width: number,
  onProgress?: (percent: number) => void,
  thumbnail = false,
): Promise<PreviewPage> {
  const progress = onProgress ? new Channel<number>() : undefined;
  if (progress)
    progress.onmessage = (percent) => {
      if (Number.isFinite(percent) && percent >= 0 && percent <= 85) onProgress?.(percent);
    };
  const value = await invoke<unknown>("render_selected_page", {
    fileId,
    pageIndex,
    width,
    ...(progress ? { onProgress: progress } : {}),
    ...(thumbnail ? { thumbnail: true } : {}),
  });
  if (typeof value !== "object" || value === null)
    throw new Error("페이지 응답이 올바르지 않습니다.");
  const page = value as Record<string, unknown>;
  if (
    page.fileId !== fileId ||
    page.pageIndex !== pageIndex ||
    typeof page.pageCount !== "number" ||
    !Number.isInteger(page.pageCount) ||
    page.pageCount <= pageIndex ||
    typeof page.width !== "number" ||
    !Number.isInteger(page.width) ||
    page.width < 1 ||
    page.width > 1600 ||
    typeof page.height !== "number" ||
    !Number.isInteger(page.height) ||
    page.height < 1 ||
    page.height > 2200 ||
    typeof page.imageUrl !== "string" ||
    !page.imageUrl.startsWith("data:image/png;base64,")
  ) {
    throw new Error("페이지 응답이 올바르지 않습니다.");
  }
  const text = page.text as PreviewPage["text"] | undefined;
  if (
    !isState(page.state) ||
    !text ||
    !Array.isArray(text.objects) ||
    !text.objects.every(isText) ||
    (text.groups !== undefined && (!Array.isArray(text.groups) || !text.groups.every(isGroup))) ||
    !(text.warning === null || typeof text.warning === "string")
  )
    throw new Error("텍스트 응답이 올바르지 않습니다.");
  return {
    fileId,
    pageIndex,
    pageCount: page.pageCount,
    width: page.width,
    height: page.height,
    imageUrl: page.imageUrl,
    text,
    state: page.state,
  };
}

export async function releasePreview(fileId: string): Promise<void> {
  await invoke("release_preview", { fileId });
}
