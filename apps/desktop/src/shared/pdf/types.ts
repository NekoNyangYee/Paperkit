import type { Alignment } from "./alignment";

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

export type EditAction =
  | { kind: "scaleText"; page: number; objects: number[]; sx: number; sy: number }
  | { kind: "pasteGraphic"; page: number; source: number[] }
  | { kind: "pasteImage"; page: number; png: number[] }
  | { kind: "addSignature"; page: number; png: number[] }
  | { kind: "addWatermark"; page: number | null; png: number[]; widthRatio: number }
  | { kind: "removeWatermark"; page: number | null }
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

export interface PreviewPage {
  fileId: string;
  pageCount: number;
  pageIndex: number;
  width: number;
  height: number;
  imageUrl: string;
  state: EditState;
  text: {
    watermarkPages?: number[];
    watermarkObjects?: number[];
    objects: TextObject[];
    graphics?: GraphicObject[];
    groups?: TextGroup[];
    warning: string | null;
  };
}
