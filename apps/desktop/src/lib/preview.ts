import { detectAlignment, type Alignment } from "./alignment";
import { Channel, invoke } from "@tauri-apps/api/core";

export interface EditState {
  pageCount?: number;
  revision: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
}
export interface TextObject {
  fontObjectId?: number;
  id: number;
  text: string;
  font: string;
  fontSize: number;
  fontWeight?: number | null;
  color: number[];
  matrix: number[];
  bounds: number[][];
  screenBounds: number[][];
  editBlocked: string | null;
  fontChangeBlocked: string | null;
}
export interface TextGroup {
  followingObjects?: number[];
  canFlow?: boolean;
  canReflow?: boolean;
  canChangeFont?: boolean;
  id: number;
  kind: "sentence" | "paragraph";
  text: string;
  uncertain: boolean;
  editBlocked: string | null;
  runs: { object: number; start: number; end: number; objectStart: number }[];
  bounds: number[][][];
  screenBounds: number[][][];
}
export type TextSelection = TextObject & {
  group?: TextGroup;
  mergedGroups?: number[];
  alignment?: Alignment;
  originalAlignment?: Alignment;
  editFonts?: Record<number, string>;
};
export type SelectionMode = "sentence" | "paragraph" | "object" | "graphic";
export interface GraphicObject {
  id: number;
  kind: "image" | "path" | "shading" | "form";
  bounds: number[][];
  screenBounds: number[][];
}
export function groupSelection(group: TextGroup, objects: TextObject[]): TextSelection | null {
  const sources = group.runs.map((run) => objects.find((o) => o.id === run.object));
  const first = sources[0];
  if (!first || sources.some((o) => !o) || !group.bounds.length) return null;
  const cover = (polygons: number[][][]) => {
    const points = polygons.flat();
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [
      [Math.min(...xs), Math.min(...ys)],
      [Math.max(...xs), Math.min(...ys)],
      [Math.max(...xs), Math.max(...ys)],
      [Math.min(...xs), Math.max(...ys)],
    ];
  };
  return {
    ...first,
    originalAlignment: detectAlignment(sources as TextObject[]),
    id: -1 - group.id,
    text: group.text,
    group,
    font: new Set(sources.map((o) => o!.font)).size > 1 ? "혼합" : first.font,
    bounds: cover(group.bounds),
    screenBounds: cover(group.screenBounds),
    editBlocked: group.editBlocked,
    fontChangeBlocked: group.canChangeFont
      ? null
      : "이 블록은 서식이나 경계가 복잡합니다. 객체 선택에서 글꼴을 변경해 주세요.",
  };
}
export type EditAction =
  | { kind: "scaleText"; page: number; objects: number[]; sx: number; sy: number }
  | { kind: "pasteGraphic"; page: number; source: number[] }
  | { kind: "pasteImage"; page: number; png: number[] }
  | {
      kind: "page";
      operation: "move" | "duplicate" | "rotate" | "delete";
      page: number;
      destination?: number;
    }
  | { kind: "transformGraphic"; page: number; object: number; matrix: number[] }
  | { kind: "deleteGraphic"; page: number; object: number }
  | {
      kind: "alignBlock";
      font?: string;
      page: number;
      groups: number[];
      text?: string;
      alignment: Alignment;
      width?: number;
      height?: number;
    }
  | { kind: "replace"; page: number; object: number; text: string }
  | {
      kind: "flexibleEdit";
      page: number;
      groups: number[];
      object?: number;
      text: string;
      fonts: Record<number, string>;
      width?: number;
      height?: number;
    }
  | {
      kind: "flowBlocks";
      page: number;
      groups: number[];
      text: string;
      width?: number;
      height?: number;
    }
  | {
      kind: "flowBlock";
      page: number;
      group: number;
      text: string;
      width?: number;
      height?: number;
    }
  | { kind: "editWithFallback"; page: number; group?: number; object?: number; text: string }
  | { kind: "move"; page: number; group?: number; object?: number; dx: number; dy: number }
  | {
      kind: "changeBlockFont";
      page: number;
      group: number;
      font: string;
      text?: string;
      width?: number;
      height?: number;
    }
  | { kind: "reflowBlock"; page: number; group: number; text: string }
  | { kind: "replaceGroup"; page: number; group: number; text: string }
  | { kind: "undo" | "redo" }
  | { kind: "save"; path: string }
  | { kind: "changeFont"; page: number; object: number; font: string };

export interface FontInfo {
  id: string;
  name: string;
  postscriptNames?: string[];
  source?: "bundled" | "installed";
}
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

export interface PreviewPage {
  fileId: string;
  pageCount: number;
  pageIndex: number;
  width: number;
  height: number;
  imageUrl: string;
  state: EditState;
  text: {
    objects: TextObject[];
    graphics?: GraphicObject[];
    groups?: TextGroup[];
    warning: string | null;
  };
}

export async function renderPage(
  fileId: string,
  pageIndex: number,
  width: number,
  onProgress?: (percent: number) => void,
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
