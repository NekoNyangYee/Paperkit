import { ActionButton } from "@/shared/ui/action-button";
import { readInlineText } from "@/features/pdf-editor/lib/text/inline-layout";
import { Button } from "@/shared/ui/button";
import { ActionContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/shared/ui/context-menu";
import { Asterisk, MoveHorizontal, ScanLine, ScanText } from "lucide-react";
import { Input } from "@/shared/ui/input";
import { SelectField } from "@/shared/ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "@/shared/ui/popover";
import { useConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import {
  Bold,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Save,
  Undo2,
  Redo2,
  Pencil,
  Check,
  Info,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Type,
  FileText,
  Stamp,
  PenLine,
  SlidersHorizontal,
} from "lucide-react";
import { IconButton } from "@/shared/ui/icon-button";
import { registerExitGuard, requestAppExit } from "@/shared/desktop/app-exit";
import { MessageDialog, useDiscardDialog } from "@/shared/ui/MessageDialog";
import type { MessageKind } from "@/shared/ui/dialog-feedback";
import type { FileInfo } from "@/shared/desktop/files";
import { errorMessage } from "@/shared/desktop/files";
import { errorDetail } from "@/shared/lib/errors";
import { useEventCallback } from "@/shared/lib/use-event-callback";
import { renderPage, releasePreview, editDocument, listFonts } from "@/shared/pdf/api";
import { previewCache } from "@/shared/pdf/preview-cache";
import { groupSelection } from "@/shared/pdf/selection";
import type { FontInfo } from "@/shared/pdf/types";
import type { TextSelection } from "@/shared/pdf/types";
import type { PreviewPage, TextObject, EditState, EditAction } from "@/shared/pdf/types";
import { useFileStore, registerTabCloseGuard } from "@/features/file-input/model/file-store";
import {
  PageSidebar,
  type ThumbnailChange,
} from "@/features/pdf-editor/components/pages/PageSidebar";
import { usePageZoom } from "./usePageZoom";
import { PageLoading } from "./PageLoading";
import { ZoomSurface } from "./ZoomSurface";
import { PageTextDialog } from "./PageTextDialog";
import { TextPage } from "@/features/pdf-editor/components/text/TextPage";
import { SizeControls } from "@/features/pdf-editor/components/controls/SizeControls";
import { isTextInput } from "@/features/pdf-editor/lib/graphics/graphic-clipboard";
import { editorFont, clearOriginalFonts } from "@/features/pdf-editor/lib/fonts/editor-font";
import { textBySource, fallbackCandidates } from "@/features/pdf-editor/lib/fonts/font-matching";
import { selectionStyle, weightLabel } from "@/features/pdf-editor/lib/fonts/font-style";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/shared/ui/dialog";
import { WatermarkDialog } from "@/features/pdf-editor/components/stamps/WatermarkDialog";
import { SignatureDialog } from "@/features/pdf-editor/components/stamps/SignatureDialog";
import { MaskDialog } from "@/features/pdf-editor/components/security/MaskDialog";
import { SignatureStatus } from "@/features/pdf-editor/components/security/SignatureStatus";
import { LoginRequiredDialog } from "@/features/auth/components/LoginRequiredDialog";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { SavedToolPicker } from "@/features/library/components/SavedToolPicker";
import type { LibraryTool } from "@/features/library/lib/api";

function originalFontIssue(cause: unknown) {
  const message = errorDetail(cause);
  return /^(원본 글꼴에 입력한 문자가 없습니다|원본 글꼴 데이터를 사용할 수 없습니다)/.test(
    message,
  );
}

export function PdfPreview({ file, active = true }: { file: FileInfo; active?: boolean }) {
  const session = useAuthStore((state) => state.session);
  const initialView = useRef(
    useFileStore.getState().tabs.find((tab) => tab.file?.id === file.id)?.view,
  ).current;
  const [fontGeneration, setFontGeneration] = useState(0);
  const {
    confirm: confirmDiscard,
    dialog: discardDialog,
    isOpen: discardOpen,
  } = useDiscardDialog();
  const resetDialog = useConfirmDialog({
    kind: "reset",
    title: "텍스트 너비 초기화",
    description: "직접 조절한 문단 크기를 초기화하고 입력에 맞춰 너비를 자동으로 늘릴까요?",
  });
  const pageArea = useRef<HTMLElement>(null);
  const [maskPage, setMaskPage] = useState<PreviewPage | null>(null);
  const signedEditDialog = useConfirmDialog({
    kind: "discard",
    title: "서명된 원본 편집",
    description: "내용을 바꾼 사본은 원본 서명으로 검증할 수 없습니다. 편집을 계속할까요?",
    action: "proceed",
  });
  const [stampDialog, setStampDialog] = useState<"watermark" | "signature" | null>(null);
  const [textPageIndex, setTextPageIndex] = useState<number | null>(null);
  const [pageIndex, setPageIndex] = useState(initialView?.pageIndex ?? 0);
  const [pageInput, setPageInput] = useState(String((initialView?.pageIndex ?? 0) + 1));
  const [pageInputError, setPageInputError] = useState<string | null>(null);
  const renderedLocation = useRef("");
  const [sidebarOpen, setSidebarOpen] = useState(initialView?.sidebarOpen ?? true);
  const [editingEnabled, setEditingEnabled] = useState(false);
  const selectionMode = "paragraph" as const;
  const [thumbnailChange, setThumbnailChange] = useState<ThumbnailChange | null>(null);
  const composing = useRef(false);
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [fontError, setFontError] = useState<string | null>(null);
  const [fontRetry, setFontRetry] = useState(0);
  const restoreSelection = useRef<{ object: TextObject; font: string } | null>(null);
  const restoreBlock = useRef<TextSelection | null>(null);
  const pendingSelection = useRef<TextSelection | null>(null);
  const [page, setPage] = useState<PreviewPage | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadPercent, setLoadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [editState, setEditState] = useState<EditState>({
    revision: 0,
    dirty: false,
    canUndo: false,
    canRedo: false,
  });
  const [selected, setSelected] = useState<TextSelection | null>(null);
  const [inlineEditing, setInlineEditing] = useState(false);
  const [blockSize, setBlockSize] = useState<{ width: number; height: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [fontResolution, setFontResolution] = useState(false);
  const [fontWarning, setFontWarning] = useState<string | null>(null);
  const [replacementFont, setReplacementFont] = useState("pretendard");
  const [busy, setBusy] = useState(false);
  const { zoom, setZoom, zoomPoint, bindViewport, zoomKey } = usePageZoom(
    pageArea,
    active,
    busy || (loading && !page),
    initialView?.zoom ?? 100,
    composing,
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: MessageKind; text: string } | null>(null);
  const working = useRef(false);
  const fontPreparation = useRef(0);
  const preparingObject = useRef<{ id: number; request: number } | null>(null);
  const [preparingEdit, setPreparingEdit] = useState(false);
  const unsavedDraft =
    selected !== null &&
    (draft !== selected.text || blockSize !== null || selected.alignment !== undefined);
  const closeState = useRef({ dirty: false, busy: false });
  closeState.current = { dirty: editState.dirty || unsavedDraft, busy };
  const clear = useFileStore((state) => state.clear);
  const selectionError = useFileStore((state) => state.error);
  const clearing = useFileStore((state) => state.phase === "clearing");

  useEffect(() => {
    useFileStore.getState().updateView(file.id, { pageIndex, zoom, sidebarOpen });
  }, [file.id, pageIndex, zoom, sidebarOpen]);
  useEffect(() => {
    const dirty = editState.dirty || unsavedDraft;
    useFileStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.file?.id === file.id && tab.dirty !== dirty ? { ...tab, dirty } : tab,
      ),
    }));
  }, [file.id, editState.dirty, unsavedDraft]);

  const detectedStyle = useMemo(
    () => selectionStyle(selected, page?.text.objects ?? [], fonts),
    [selected, page?.text.objects, fonts],
  );
  const fontChoices = useMemo(
    () =>
      fonts.map((font) => ({
        value: font.id,
        label: font.name,
        group: font.source === "installed" ? "이 PC의 글꼴" : "기본 제공 글꼴",
      })),
    [fonts],
  );
  const styleDisabled =
    busy ||
    loading ||
    preparingEdit ||
    !selected ||
    selected.fontChangeBlocked !== null ||
    (unsavedDraft && !selected.group?.canFlow);
  const toggleWeight = detectedStyle.weight !== null && detectedStyle.weight >= 600 ? 400 : 700;
  const toggleVariant = detectedStyle.variants.find((variant) => variant.weight === toggleWeight);

  function changeSelectedFont(font: string) {
    if (!selected || styleDisabled || composing.current || font === "current") return;
    const alignment = selected.alignment ?? selected.originalAlignment;
    void run(
      selected.group && alignment
        ? {
            kind: "alignBlock",
            page: pageIndex,
            groups: selected.mergedGroups ?? [selected.group.id],
            text: draft,
            alignment,
            font,
            ...(blockSize ?? {}),
          }
        : selected.group
          ? {
              kind: "changeBlockFont",
              page: pageIndex,
              group: selected.group.id,
              font,
              ...(unsavedDraft
                ? { text: draft, width: blockSize?.width, height: blockSize?.height }
                : {}),
            }
          : { kind: "changeFont", page: pageIndex, object: selected.id, font },
    );
  }

  async function validateDraftFont(target: TextSelection, value: string) {
    if (!value.trim()) return;
    const byFont = new Map<number, { font: string; text: string }>();
    for (const [id, text] of textBySource(target, value)) {
      const source = page!.text.objects.find((o) => o.id === id)!;
      const face = source.fontObjectId ?? source.id;
      const existing = byFont.get(face);
      byFont.set(face, { font: source.font, text: (existing?.text ?? "") + text });
    }
    for (const [id, { font, text }] of byFont) {
      if (/^(Helvetica|Courier|Times)(-|$)/.test(font) && /^[\x20-\x7e]*$/.test(text)) continue;
      const data = await invoke("document_font", {
        fileId: file.id,
        revision: editState.revision,
        pageIndex,
        objectId: id,
        text,
        validateOnly: true,
      });
      if (typeof data !== "string") throw new Error("글꼴 검증 응답이 올바르지 않습니다.");
    }
  }

  useEffect(() => {
    setFontWarning(null);
    if (!inlineEditing || !selected || draft === selected.text || busy || loading || fontResolution)
      return;
    if (!(selected.group?.canFlow || (!selected.group && selected.fontChangeBlocked === null)))
      return;
    let active = true;
    const timer = setTimeout(() => {
      if (composing.current || working.current) return;
      void validateDraftFont(selected, draft).catch((cause) => {
        if (active && originalFontIssue(cause))
          setFontWarning("원본 글꼴로 반영할 수 없는 문자가 있습니다. 입력은 유지됩니다.");
      });
    }, 800);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    draft,
    selected,
    inlineEditing,
    busy,
    loading,
    fontResolution,
    fontGeneration,
    editState.revision,
    pageIndex,
  ]);

  async function applyReplacementFont() {
    if (!selected || working.current || !fonts.some((font) => font.id === replacementFont)) return;
    setFontResolution(false);
    const text = draft;
    const result = await run(
      selected.group && selected.alignment
        ? {
            kind: "alignBlock",
            page: pageIndex,
            groups: selected.mergedGroups ?? [selected.group.id],
            text,
            alignment: selected.alignment,
            font: replacementFont,
            ...(blockSize ?? {}),
          }
        : {
            kind: "flexibleEdit",
            page: pageIndex,
            groups: selected.group ? (selected.mergedGroups ?? [selected.group.id]) : [],
            ...(!selected.group ? { object: selected.id } : {}),
            text,
            fonts: Object.fromEntries(
              [...textBySource(selected, text)].map(([id]) => [id, replacementFont]),
            ),
            ...(blockSize ?? {}),
          },
    );
    if (result) {
      setBlockSize(null);
      setFontWarning(null);
    }
  }

  function resolveFont(value = draft) {
    setDraft(value);
    setEditError(null);
    setNotice(null);
    setReplacementFont(
      fallbackCandidates(selected?.font ?? "", fonts)[0]?.id ?? fonts[0]?.id ?? "",
    );
    setFontResolution(true);
  }

  useEffect(() => {
    if (!editingEnabled) return;
    let disposed = false;
    setFontError(null);
    void listFonts()
      .then((result) => {
        if (!disposed) setFonts(result);
      })
      .catch((cause) => {
        if (!disposed) setFontError(errorMessage(cause, "font"));
      });
    return () => {
      disposed = true;
    };
  }, [editingEnabled, fontRetry]);

  useEffect(() => {
    if (pageArea.current) {
      pageArea.current.scrollTop = 0;
      pageArea.current.scrollLeft = 0;
    }
  }, [pageIndex]);

  useLayoutEffect(() => {
    let disposed = false;
    fontPreparation.current++;
    const location = `${file.id}:${pageIndex}`;
    const samePage = renderedLocation.current === location;
    setError(null);
    const show = (result: PreviewPage) => {
      setLoadPercent(100);
      renderedLocation.current = location;
      setPage(result);
      setSelected(null);
      if (!pendingSelection.current && !restoreSelection.current && !restoreBlock.current)
        setInlineEditing(false);
      setDraft("");
      setBlockSize(null);
      setPageCount(result.pageCount);
      setEditState(result.state);
      const previous = restoreSelection.current;
      if (previous) {
        const object = result.text.objects.find(
          (o) =>
            o.text === previous.object.text &&
            o.font
              .replace(/[^a-z]/gi, "")
              .toLowerCase()
              .startsWith(previous.font.replace(/-/g, "")) &&
            o.matrix.every((value, i) => Math.abs(value - previous.object.matrix[i]) < 0.01),
        );
        if (object) {
          setSelected(object);
          setDraft(object.text);
        }
        restoreSelection.current = null;
      }
      const pending = pendingSelection.current;
      const converted = restoreBlock.current;
      if (converted) {
        const group = result.text.groups?.find(
          (g) =>
            g.kind === "paragraph" &&
            g.runs.some((r) =>
              result.text.objects.some(
                (o) =>
                  o.id === r.object &&
                  Math.abs(o.matrix[4] - converted.matrix[4]) < 0.1 &&
                  Math.abs(o.matrix[5] - converted.matrix[5]) < 0.1,
              ),
            ),
        );
        const next = group && groupSelection(group, result.text.objects);
        if (next) {
          setSelected(next);
          setDraft(next.text);
        }
        restoreBlock.current = null;
      }
      if (pending) {
        const next = pending.group
          ? result.text.groups
              ?.filter((g) => g.kind === pending.group!.kind && g.text === pending.text)
              .map((g) => groupSelection(g, result.text.objects))
              .find((o) => o && o.matrix.every((v, i) => Math.abs(v - pending.matrix[i]) < 0.01))
          : result.text.objects.find(
              (o) =>
                o.text === pending.text &&
                o.matrix.every((v, i) => Math.abs(v - pending.matrix[i]) < 0.01),
            );
        if (next) {
          setSelected(next);
          setDraft(next.text);
        }
        pendingSelection.current = null;
      }
    };
    const cached = previewCache.get(file.id, pageIndex, 1600);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (cached) {
      show(cached.page);
      setLoading(false);
    } else {
      setLoading(true);
      setLoadPercent(0);
      if (!samePage) {
        setPage(null);
        setSelected(null);
      }
      timer = setTimeout(() => {
        // Zoom uses this same bitmap. Only a cache miss crosses the native boundary.
        void previewCache
          .load(file.id, pageIndex, 1600, async () => {
            const result = await renderPage(file.id, pageIndex, 1600, (percent) => {
              if (!disposed) setLoadPercent((previous) => Math.max(previous, percent));
            });
            if (!disposed) setLoadPercent(95);
            let image: HTMLImageElement | undefined;
            if (typeof Image.prototype.decode === "function") {
              image = new Image();
              image.src = result.imageUrl;
              await image.decode();
            }
            return { page: result, image };
          })
          .then((value) => {
            if (!disposed) show(value.page);
          })
          .catch((cause: unknown) => {
            if (!disposed) {
              const message = errorDetail(cause);
              if (
                !renderedLocation.current &&
                pageIndex > 0 &&
                message === "존재하지 않는 페이지입니다."
              ) {
                setPageIndex(0);
                setPageInput("1");
              } else setError(errorMessage(cause, "preview"));
            }
          })
          .finally(() => {
            if (!disposed) setLoading(false);
          });
      }, 0);
    }
    return () => {
      disposed = true;
      fontPreparation.current++;
      clearTimeout(timer);
    };
  }, [file.id, pageIndex, retry]);

  async function approveDiscard() {
    working.current = true;
    setBusy(true);
    try {
      return await confirmDiscard();
    } catch (cause) {
      setEditError(errorMessage(cause, "edit"));
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function choose(object: TextSelection | null) {
    fontPreparation.current++;
    if (composing.current) return;
    if (object && unsavedDraft && !working.current) {
      pendingSelection.current = object;
      if (!(await commitDraft())) pendingSelection.current = null;
      return;
    }
    if (!editingEnabled || working.current || (unsavedDraft && !(await approveDiscard()))) return;
    setSelected(object);
    setBlockSize(null);
    setInlineEditing(false);
    setDraft(object?.text ?? "");
    setEditError(null);
  }

  async function beginEditing(object: TextSelection) {
    if (!editingEnabled || working.current || loading || composing.current) return;
    if (inlineEditing && selected?.id === object.id) return;
    if (
      preparingObject.current?.id === object.id &&
      preparingObject.current.request === fontPreparation.current
    )
      return;
    if (object.editBlocked && object.fontChangeBlocked !== null && !object.group?.canFlow) {
      await choose(object);
      setNotice({ kind: "warning", text: object.fontChangeBlocked ?? object.editBlocked });
      return;
    }
    if (unsavedDraft && selected?.id !== object.id) {
      pendingSelection.current = object;
      if (await commitDraft()) setInlineEditing(true);
      else pendingSelection.current = null;
      return;
    }
    const preparation = ++fontPreparation.current;
    preparingObject.current = { id: object.id, request: preparation };
    setPreparingEdit(true);
    setSelected(object);
    setDraft(object.text);
    setEditError(null);
    try {
      const sources = object.group
        ? object.group.runs.map((r) => page!.text.objects.find((o) => o.id === r.object)!)
        : [object];
      const faces = new Map<number, { source: TextObject; text: string; validate: boolean }>();
      for (const source of sources) {
        const key = source.fontObjectId ?? source.id;
        const face = faces.get(key);
        faces.set(key, {
          source,
          text: (face?.text ?? "") + source.text.trimEnd(),
          validate: !!source.editBlocked || !!face?.validate,
        });
      }
      for (const { source, text, validate } of faces.values()) {
        if (preparation !== fontPreparation.current) return;
        if (validate) {
          if (source.fontChangeBlocked) throw new Error(source.fontChangeBlocked);
          // A render-time font warning is not a final editing decision. Recheck
          // the actual embedded data (including PDF cmap recovery) on entry.
          const data = await invoke("document_font", {
            fileId: file.id,
            revision: editState.revision,
            pageIndex,
            objectId: source.id,
            text,
            validateOnly: true,
          });
          if (typeof data !== "string")
            throw new Error(source.editBlocked ?? "원본 글꼴을 준비하지 못했습니다.");
        }
        await editorFont(source.font, {
          fileId: file.id,
          revision: editState.revision,
          pageIndex,
          objectId: source.fontObjectId ?? source.id,
        });
      }
      if (preparation !== fontPreparation.current) return;
      setSelected({ ...object, editBlocked: null });
      setInlineEditing(true);
      setNotice(null);
      return true;
    } catch (cause) {
      if (preparation === fontPreparation.current) setEditError(errorMessage(cause, "font"));
    } finally {
      if (preparingObject.current?.request === preparation) {
        preparingObject.current = null;
        setPreparingEdit(false);
      }
    }
  }

  async function importOriginalFont() {
    if (!selected || busy || loading || preparingEdit || composing.current) return;
    const sources = selected.group
      ? selected.group.runs.map((run) =>
          page!.text.objects.find((object) => object.id === run.object)!,
        )
      : [selected];
    const expected = [...new Set(sources.map((source) => source.font))];
    working.current = true;
    setBusy(true);
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "원본 글꼴 (TTF / TTC)", extensions: ["ttf", "ttc"] }],
      });
      if (typeof path !== "string") return;
      const matched = await invoke<string[]>("import_original_font", { path, expected });
      previewCache.clearFile(file.id);
      clearOriginalFonts(file.id);
      setEditError(null);
      setFontGeneration((value) => value + 1);
      if (!unsavedDraft) setRetry((value) => value + 1);
      setNotice({
        kind: "success",
        text: `원본 글꼴을 불러왔습니다: ${matched.join(", ")}. Windows 설치 없이 이번 앱 실행 동안 사용합니다. 입력할 문자가 포함되어 있는지 적용 전에 확인합니다.`,
      });
    } catch (cause) {
      setEditError(errorMessage(cause, "font"));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function moveSelection(dx: number, dy: number, target = selected) {
    if (!target || inlineEditing || unsavedDraft || working.current) return false;
    return (
      (await run({
        kind: "move",
        page: pageIndex,
        ...(target.group ? { group: target.group.id } : { object: target.id }),
        dx,
        dy,
      })) !== null
    );
  }

  async function deleteSelection(target: TextSelection) {
    if (working.current || unsavedDraft || composing.current) return;
    await run(
      target.group?.canFlow
        ? { kind: "flowBlock", page: pageIndex, group: target.group.id, text: "" }
        : target.group
          ? { kind: "replaceGroup", page: pageIndex, group: target.group.id, text: "" }
          : { kind: "replace", page: pageIndex, object: target.id, text: "" },
    );
  }

  async function navigate(index: number) {
    if (
      working.current ||
      pageCount === null ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= pageCount
    )
      return;
    if (index !== pageIndex && unsavedDraft && !(await commitDraft())) {
      setPageInput(String(pageIndex + 1));
      return;
    }
    setPageInput(String(index + 1));
    setPageInputError(null);
    setPageIndex(index);
  }

  function submitPage() {
    if (busy || loading || pageCount === null) return;
    const value = pageInput.trim();
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > pageCount) {
      setPageInputError(`1부터 ${pageCount}까지의 페이지 번호를 입력해 주세요.`);
      return;
    }
    void navigate(number - 1);
  }

  async function run(action: EditAction, revision = editState.revision): Promise<EditState | null> {
    if (
      ["addSignature", "addWatermark", "removeWatermark"].includes(action.kind) &&
      !useAuthStore.getState().session
    )
      return null;
    if (!editingEnabled || working.current || !page) return null;
    working.current = true;
    setBusy(true);
    setEditError(null);
    setNotice(null);
    try {
      const result = await editDocument(file.id, revision, action);
      setThumbnailChange(
        action.kind === "undo" ||
          action.kind === "redo" ||
          (action.kind === "addWatermark" && action.page === null)
          ? null
          : {
              fromRevision: revision,
              revision: result.revision,
              operation:
                action.kind === "page"
                  ? action.operation
                  : action.kind === "save"
                    ? "save"
                    : "content",
              page: "page" in action ? (action.page ?? pageIndex) : pageIndex,
              destination: action.kind === "page" ? action.destination : undefined,
            },
      );
      setEditState(result);
      if (result.pageCount !== undefined) {
        setPageCount(result.pageCount);
        const next =
          action.kind === "page"
            ? action.operation === "move"
              ? action.destination!
              : action.operation === "duplicate"
                ? action.page + 1
                : Math.min(action.page, result.pageCount - 1)
            : Math.min(pageIndex, result.pageCount - 1);
        setPageIndex(next);
        setPageInput(String(next + 1));
      }
      if (["page", "undo", "redo"].includes(action.kind)) {
        setSelected(null);
        setDraft("");
        setInlineEditing(false);
        setBlockSize(null);
      }
      if (action.kind === "save")
        setNotice({ kind: "success", text: "새 PDF로 저장하고 다시 열어 검증했습니다." });
      else {
        if (action.kind === "move" && selected) {
          const matrix = [...selected.matrix];
          matrix[4] += action.dx;
          matrix[5] += action.dy;
          pendingSelection.current = { ...selected, matrix };
        }
        restoreSelection.current =
          action.kind === "changeFont" && selected ? { object: selected, font: action.font } : null;
        restoreBlock.current = action.kind === "changeBlockFont" ? selected : null;
        if (action.kind === "changeBlockFont") setBlockSize(null);
        // Keep the current bitmap and dragged layer until the replacement is decoded.
        setLoading(true);
        setRetry((value) => value + 1);
      }
      return result;
    } catch (cause) {
      setEditError(errorMessage(cause, action.kind === "save" ? "save" : "edit"));
      return null;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function commitDraft(value = draft): Promise<EditState | null> {
    if (
      !selected ||
      (value === selected.text && blockSize === null && selected.alignment === undefined)
    ) {
      setInlineEditing(false);
      return editState;
    }
    if (composing.current) return null;
    if (working.current) return null;
    if (
      value !== selected.text &&
      (selected.group?.canFlow || (!selected.group && selected.fontChangeBlocked === null))
    ) {
      // Check newly typed characters too: a subset can display the old text yet lack new glyphs.
      working.current = true;
      setBusy(true);
      try {
        await validateDraftFont(selected, value);
      } catch (cause) {
        if (originalFontIssue(cause)) resolveFont(value);
        else setEditError(errorMessage(cause, "font"));
        return null;
      } finally {
        working.current = false;
        setBusy(false);
      }
    }
    if (selected.alignment && selected.group?.canFlow) {
      const result = await run({
        kind: "alignBlock",
        page: pageIndex,
        groups: selected.mergedGroups ?? [selected.group.id],
        text: value,
        alignment: selected.alignment,
        ...(blockSize ?? {}),
      });
      if (result) setBlockSize(null);
      return result;
    }
    if (selected.mergedGroups) {
      const result = await run({
        kind: "flowBlocks",
        page: pageIndex,
        groups: selected.mergedGroups,
        text: value,
        ...(blockSize ?? {}),
      });
      if (result) setBlockSize(null);
      return result;
    }
    if (selected.group?.canFlow) {
      const result = await run({
        kind: "flowBlock",
        page: pageIndex,
        group: selected.group.id,
        text: value,
        ...(blockSize ?? {}),
      });
      if (result) setBlockSize(null);
      return result;
    }
    if (
      selected.editBlocked &&
      !(value.trim() === "" && !selected.group && selected.fontChangeBlocked === null)
    ) {
      setEditError(
        "원본 글꼴을 사용할 수 없습니다. 글꼴 메뉴에서 사용할 글꼴을 직접 선택해 주세요.",
      );
      return null;
    }
    return run(
      selected.group
        ? {
            kind: selected.group.canReflow ? "reflowBlock" : "replaceGroup",
            page: pageIndex,
            group: selected.group.id,
            text: value,
          }
        : { kind: "replace", page: pageIndex, object: selected.id, text: value },
    );
  }

  async function insertStamp(action: EditAction): Promise<boolean> {
    if (!useAuthStore.getState().session) return false;
    if (working.current || !page || !editingEnabled || loading || preparingEdit) return false;
    const committed = await commitDraft();
    if (!committed) return false;
    const result = await run(action, committed.revision);
    if (!result) return false;
    setSelected(null);
    setDraft("");
    setInlineEditing(false);
    setBlockSize(null);
    return true;
  }

  async function useLibraryTool(tool: LibraryTool): Promise<boolean> {
    if (!active || !useAuthStore.getState().session) return false;
    if (tool.kind !== "text") return false;
    await navigator.clipboard.writeText(tool.content);
    setNotice({ kind: "success", text: "문구를 복사했습니다." });
    return true;
  }

  async function saveAs() {
    if (working.current || !page) return;
    const committed = await commitDraft();
    if (!committed || working.current) return;
    // Lock while the native dialog is open as well.
    working.current = true;
    setBusy(true);
    try {
      const path = await save({
        title: "새 PDF로 저장",
        defaultPath: file.path.replace(/\.pdf$/i, "-edited.pdf"),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      working.current = false;
      if (path) await run({ kind: "save", path }, committed.revision);
    } catch (cause) {
      setEditError(errorMessage(cause, "save"));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function closeDocument() {
    if (working.current) return;
    if (
      !useFileStore.getState().tabs.some((tab) => tab.file?.id === file.id) &&
      closeState.current.dirty &&
      !(await approveDiscard())
    )
      return;
    await clear();
  }

  async function openOtherFile() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path || typeof path !== "string") return;
      await useFileStore.getState().replaceFile([path]);
    } catch (cause) {
      setEditError(errorMessage(cause, "file"));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const window = getCurrentWindow();
      const stop = await window.onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await requestAppExit(() => window.destroy());
        } catch (cause) {
          if (!disposed) setEditError(errorMessage(cause, "edit"));
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })().catch(() => {
      if (!disposed) setEditError("앱을 닫기 전에 변경한 문서를 먼저 저장해 주세요.");
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const guard = async () => {
      if (working.current) throw new Error("문서 작업이 끝난 뒤 다시 시도해 주세요.");
      if (closeState.current.dirty) {
        const store = useFileStore.getState();
        const tab = store.tabs.find((tab) => tab.file?.id === file.id);
        if (tab) store.activateTab(tab.id);
        if (!(await confirmDiscard())) return false;
      }
      return !working.current;
    };
    const removeExit = registerExitGuard(guard);
    const removeTab = registerTabCloseGuard(file.id, guard);
    return () => {
      removeExit();
      removeTab();
    };
  }, [file.id]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (closeState.current.dirty || working.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!active || event.defaultPrevented) return;
      if (document.querySelector('[role="alertdialog"], [role="dialog"], [role="menu"]')) return;
      if (event.isComposing || composing.current) return;
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.matches("input, textarea") || event.target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && !typing && zoomKey(event.key)) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        void choose(null);
      }
      if (busy || loading || !editingEnabled) return;
      const control =
        event.target instanceof Element &&
        !!event.target.closest('button,select,[role="combobox"],[role="listbox"],[role="option"]');
      if (!typing && !control && !inlineEditing && !unsavedDraft && selected) {
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          if (!event.repeat) void deleteSelection(selected);
          return;
        }
        const step = event.shiftKey ? 10 : 1;
        const delta = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        }[event.key];
        if (delta && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          if (!event.repeat) void moveSelection(delta[0], delta[1]);
          return;
        }
        if (event.key === "F2" || event.key === "Enter") {
          event.preventDefault();
          void beginEditing(selected);
          return;
        }
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveAs();
      }
      if (typing || unsavedDraft) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey ? editState.canRedo : editState.canUndo)
          void run({ kind: event.shiftKey ? "redo" : "undo" });
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (editState.canRedo) void run({ kind: "redo" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  useEffect(() => {
    if (!active) return;
    const available = (target: EventTarget | null) =>
      selected &&
      !busy &&
      !loading &&
      !inlineEditing &&
      !unsavedDraft &&
      !isTextInput(target) &&
      !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
    const copy = (event: ClipboardEvent) => {
      if (!available(event.target) || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", selected!.text);
      if (event.type === "cut" && editingEnabled) void deleteSelection(selected!);
    };
    const paste = (event: ClipboardEvent) => {
      if (!available(event.target) || !editingEnabled) return;
      const value = event.clipboardData?.getData("text/plain");
      if (!value || value.startsWith("paperkit-graphic:") || event.clipboardData?.files.length)
        return;
      event.preventDefault();
      const target = selected!;
      if (target.editBlocked) {
        resolveFont(value);
        return;
      }
      void beginEditing(target).then((ready) => {
        if (ready) setDraft(value);
      });
    };
    document.addEventListener("copy", copy);
    document.addEventListener("cut", copy);
    document.addEventListener("paste", paste);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", copy);
      document.removeEventListener("paste", paste);
    };
  });

  useEffect(
    () => () => {
      clearOriginalFonts(file.id);
      void releasePreview(file.id).catch(() => {
        /* Backend shutdown needs no UI update. */
      });
    },
    [file.id],
  );

  const graphicEdit = useEventCallback(async (action: EditAction) => !!(await run(action)));
  const beginTextEdit = useEventCallback((object: TextSelection) => {
    void beginEditing(object);
  });
  const moveText = useEventCallback((dx: number, dy: number, target?: TextSelection) =>
    moveSelection(dx, dy, target),
  );
  const deleteText = useEventCallback((target: TextSelection) => {
    void deleteSelection(target);
  });
  const selectText = useEventCallback((object: TextSelection | null) => {
    if (!object && unsavedDraft) void commitDraft();
    else void choose(object);
  });
  const applyText = useEventCallback((value?: string) => {
    void commitDraft(value);
  });
  const composeText = useEventCallback((value: boolean) => {
    composing.current = value;
  });

  function replaceWithStars() {
    if (!selected || busy || loading || composing.current) return;
    let value = "**";
    const selection = window.getSelection();
    if (inlineEditing && selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      const editor = pageArea.current?.querySelector<HTMLElement>(
        '[contenteditable="plaintext-only"]',
      );
      if (!editor || !editor.contains(range.commonAncestorContainer)) return;
      range.deleteContents();
      range.insertNode(document.createTextNode("**"));
      value = readInlineText(editor);
    }
    setDraft(value);
    void commitDraft(value);
  }
  const basicTools = (
    <div className="ribbon-group" role="group" aria-label="기본 기능">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || loading || !page || unsavedDraft}
        onClick={() => setTextPageIndex(pageIndex)}
      >
        <FileText size={16} />
        글자 추출
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!page || loading || busy || unsavedDraft}
        onClick={() => setMaskPage(page)}
      >
        <ScanLine size={16} />
        마스킹
      </Button>
      {editingEnabled && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!selected || loading || busy || preparingEdit}
          title="선택한 텍스트 또는 블록을 **로 대체"
          onMouseDown={(e) => e.preventDefault()}
          onClick={replaceWithStars}
        >
          <Asterisk size={16} aria-hidden="true" /> 별표 대체
        </Button>
      )}
    </div>
  );

  const pageWarning =
    editingEnabled && page
      ? (page.text.warning ??
        (page.text.objects.length === 0
          ? "선택 가능한 텍스트 객체가 없습니다. 이미지나 윤곽선으로 저장된 글자일 수 있습니다."
          : null))
      : null;
  const failure =
    editError ?? selectionError ?? error ?? pageInputError ?? (editingEnabled ? fontError : null);
  const message = active ? (failure ?? notice?.text ?? pageWarning) : null;

  return (
    <main className="flex h-full select-none overflow-hidden">
      {discardDialog}
      {resetDialog.dialog}
      {signedEditDialog.dialog}
      {maskPage && (
        <MaskDialog
          active={active}
          file={file}
          initial={maskPage}
          onClose={() => setMaskPage(null)}
          onSaved={() => {
            setMaskPage(null);
            setNotice({ kind: "success", text: "마스킹 사본을 검증하고 저장했습니다." });
          }}
        />
      )}
      {active && textPageIndex !== null && (
        <PageTextDialog
          fileId={file.id}
          revision={editState.revision}
          pageIndex={textPageIndex}
          onClose={() => setTextPageIndex(null)}
        />
      )}
      <LoginRequiredDialog
        open={active && !!stampDialog && !session}
        feature={stampDialog === "signature" ? "전자서명" : "워터마크"}
        onClose={() => setStampDialog(null)}
      />
      {session && stampDialog === "watermark" && page && (
        <WatermarkDialog
          page={page}
          onClose={() => setStampDialog(null)}
          onApply={insertStamp}
          applyError={editError}
        />
      )}
      {session && stampDialog === "signature" && (
        <SignatureDialog
          applyError={editError}
          onClose={() => setStampDialog(null)}
          onApply={(png) => insertStamp({ kind: "addSignature", page: pageIndex, png })}
        />
      )}
      <Dialog open={fontResolution} onOpenChange={setFontResolution}>
        <DialogContent
          className="w-[min(92vw,540px)] p-6"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLElement>('[role="textbox"][aria-label="내용"]')?.focus();
          }}
        >
          <DialogTitle className="text-lg font-semibold">반영할 글꼴을 선택해 주세요</DialogTitle>
          <DialogDescription className="mt-3 text-sm leading-6 text-stone-600">
            내장 글꼴과 사용 가능한 동일 글꼴로 입력한 문자를 표현하지 못했습니다. 입력 내용은
            유지됩니다. 대체 글꼴로 반영하면 선택한 텍스트 전체의 글꼴과 줄바꿈이 달라질 수
            있습니다.
          </DialogDescription>
          <label className="mt-4 block text-sm">
            대체 글꼴
            <SelectField
              label="대체 글꼴"
              value={replacementFont}
              onValueChange={setReplacementFont}
              className="mt-2 w-full"
              options={fontChoices}
            />
          </label>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <ActionButton
              action="import"
              variant="ghost"
              className="dialog-button"
              onClick={() => {
                setFontResolution(false);
                void importOriginalFont();
              }}
            />
            <ActionButton
              action="apply"
              variant="ghost"
              className="dialog-button bg-emerald-900 text-white"
              disabled={busy || !replacementFont || selected?.fontChangeBlocked !== null}
              onClick={() => void applyReplacementFont()}
            />
          </div>
        </DialogContent>
      </Dialog>
      {pageCount !== null && (
        <PageSidebar
          key={file.id}
          thumbnailChange={thumbnailChange}
          editable={editingEnabled}
          onPageAction={(operation, index, destination) => {
            if (unsavedDraft || working.current || loading) return;
            void run({ kind: "page", operation, page: index, destination });
          }}
          revision={editState.revision}
          paused={busy || loading || preparingEdit || inlineEditing}
          fileId={file.id}
          pageCount={pageCount}
          selectedPage={pageIndex}
          onSelect={(index) => void navigate(index)}
          onReadText={page && !unsavedDraft ? setTextPageIndex : undefined}
          open={sidebarOpen}
        />
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4">
          <IconButton
            icon={sidebarOpen ? PanelLeftClose : PanelLeftOpen}
            label={sidebarOpen ? "페이지 목록 접기" : "페이지 목록 펼치기"}
            onClick={() => setSidebarOpen((value) => !value)}
            disabled={pageCount === null}
            aria-expanded={pageCount !== null && sidebarOpen}
            aria-controls="page-sidebar"
            title={sidebarOpen ? "페이지 목록 접기" : "페이지 목록 펼치기"}
            className="border border-stone-200"
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium" title={file.path}>
              {file.name}
              {page?.recovered && (
                <span className="ml-2 text-xs font-normal text-stone-500">복구된 사본</span>
              )}
            </h1>
            {editState.dirty && (
              <p className="mt-1 text-xs text-stone-500">저장하지 않은 변경 있음</p>
            )}
          </div>
          {!!page?.signatures?.length && <SignatureStatus reports={page.signatures} />}
          <div className="flex items-center gap-3">
            <SelectField
              label="확대 비율"
              value={String(Math.round(zoom))}
              onValueChange={(value) => {
                zoomPoint.current = null;
                setZoom(Number(value));
              }}
              disabled={busy || loading}
              className="w-24"
              options={[
                ...new Set([
                  ...Array.from({ length: 26 }, (_, i) => 25 + i * 15),
                  50,
                  75,
                  125,
                  150,
                  200,
                  250,
                  300,
                  Math.round(zoom),
                ]),
              ]
                .sort((a, b) => a - b)
                .map((value) => ({ value: String(value), label: `${value}%` }))}
            />
          </div>
          <IconButton
            icon={X}
            label="문서 나가기"
            disabled={busy || clearing}
            onClick={() => void closeDocument()}
          />
        </header>
        {!editingEnabled && (
          <div
            role="note"
            className="flex shrink-0 items-center gap-3 border-b border-amber-200 bg-amber-50/90 px-4 py-2 text-xs text-stone-700"
          >
            <Info size={19} className="shrink-0 text-sky-700" aria-hidden="true" />
            {basicTools}
            <p className="min-w-0 flex-1 leading-5">
              <strong className="mr-2 font-semibold text-stone-800">읽기 전용</strong>
            </p>
            <Button
              variant="ghost"
              type="button"
              onClick={async () => {
                if (page?.signatures?.length && !(await signedEditDialog.confirm())) return;
                setEditingEnabled(true);
              }}
              disabled={loading || busy}
              className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium text-stone-800 shadow-sm transition-colors hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-40"
            >
              <Pencil size={16} aria-hidden="true" /> 편집 사용
            </Button>
          </div>
        )}
        {editingEnabled && (
          <div
            aria-label="편집 도구"
            className="editor-toolbar shrink-0 border-b border-stone-200 bg-white text-sm"
          >
            <div className="editor-ribbon flex h-12 items-center gap-3 overflow-x-auto px-4">
              <div className="ribbon-group">
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy || clearing}
                  onClick={() => void openOtherFile()}
                  className="ribbon-command"
                >
                  <FolderOpen size={23} aria-hidden="true" />
                  <span>다른 파일 열기</span>
                </Button>
              </div>
              {basicTools}
              <div className="ribbon-group">
                <div className="flex flex-1 items-center gap-1">
                  <IconButton
                    label="실행 취소"
                    icon={Undo2}
                    disabled={busy || loading || unsavedDraft || !editState.canUndo}
                    onClick={() => void run({ kind: "undo" })}
                  />
                  <IconButton
                    label="다시 실행"
                    icon={Redo2}
                    disabled={busy || loading || unsavedDraft || !editState.canRedo}
                    onClick={() => void run({ kind: "redo" })}
                  />
                </div>
              </div>
              <div className="ribbon-group">
                <div className="flex flex-1 items-center gap-1">
                  <Button
                    variant="ghost"
                    type="button"
                    className={`ribbon-command ${!session ? "opacity-40" : ""}`}
                    disabled={busy || loading || preparingEdit || !page}
                    title={session ? "워터마크" : "워터마크 · 로그인 필요"}
                    onClick={() => {
                      setEditError(null);
                      setStampDialog("watermark");
                    }}
                  >
                    <Stamp size={23} aria-hidden="true" />
                    <span>워터마크</span>
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    className={`ribbon-command ${!session ? "opacity-40" : ""}`}
                    disabled={busy || loading || preparingEdit || !page}
                    title={session ? "전자서명" : "전자서명 · 로그인 필요"}
                    onClick={() => {
                      setEditError(null);
                      setStampDialog("signature");
                    }}
                  >
                    <PenLine size={23} aria-hidden="true" />
                    <span>전자서명</span>
                  </Button>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
                <IconButton
                  icon={Save}
                  label="저장"
                  disabled={busy || loading || (!unsavedDraft && !editState.dirty)}
                  onClick={() => void saveAs()}
                  className="bg-emerald-900 text-white hover:bg-emerald-800"
                />
              </div>
            </div>
            <div className="editor-text-tools flex h-12 items-center gap-3 overflow-x-auto border-t border-stone-100 bg-stone-50/60 px-4">
              <SavedToolPicker
                kind="text"
                label="보관한 문구 복사"
                disabled={busy || loading || !page}
                onPick={useLibraryTool}
              />
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex flex-1 items-center gap-2 text-stone-600">
                  <Type size={18} aria-hidden="true" />
                  <span className="sr-only">글꼴</span>
                  <SelectField
                    label="글꼴"
                    value="current"
                    disabled={
                      busy ||
                      loading ||
                      (unsavedDraft && !selected?.group?.canFlow) ||
                      !selected ||
                      selected.fontChangeBlocked !== null ||
                      fonts.length === 0
                    }
                    title={
                      selected?.fontChangeBlocked ??
                      (unsavedDraft && !selected?.group?.canFlow
                        ? "입력 중인 내용을 먼저 적용해 주세요."
                        : "선택한 블록 전체의 글꼴 변경 · 너비에 맞춰 자동 줄바꿈")
                    }
                    onValueChange={(value) => {
                      if (selected && value !== "current")
                        void run(
                          selected.group && selected.alignment
                            ? {
                                kind: "alignBlock",
                                page: pageIndex,
                                groups: selected.mergedGroups ?? [selected.group.id],
                                text: draft,
                                alignment: selected.alignment,
                                font: value,
                                ...(blockSize ?? {}),
                              }
                            : selected.group
                              ? {
                                  kind: "changeBlockFont",
                                  page: pageIndex,
                                  group: selected.group.id,
                                  font: value,
                                  ...(unsavedDraft
                                    ? {
                                        text: draft,
                                        width: blockSize?.width,
                                        height: blockSize?.height,
                                      }
                                    : {}),
                                }
                              : {
                                  kind: "changeFont",
                                  page: pageIndex,
                                  object: selected.id,
                                  font: value,
                                },
                        );
                    }}
                    className="w-52"

                    options={fontChoices}
                    children={
                      selected?.editFonts && Object.keys(selected.editFonts).length
                        ? `${selected.font} → ${[...new Set(Object.values(selected.editFonts))].map((id) => fonts.find((f) => f.id === id)?.name ?? id).join(", ")}`
                        : selected
                          ? selected.font
                          : "텍스트 선택"
                    }
                  />
                </label>
                <div className="flex items-center gap-2" role="group" aria-label="글꼴 굵기">
                  <output
                    aria-label="글자 크기"
                    title="PDF에서 감지한 글자 크기"
                    className="min-w-20 rounded-md border border-stone-200 px-2 py-1 text-sm tabular-nums"
                  >
                    {selected
                      ? (() => {
                          const objects = selected.group
                            ? selected.group.runs
                                .map((run) =>
                                  page?.text.objects.find((object) => object.id === run.object),
                                )
                                .filter((object): object is TextObject => !!object)
                            : [selected];
                          const sizes = [
                            ...new Set(
                              objects.map((object) =>
                                Number(
                                  (
                                    object.fontSize * Math.hypot(object.matrix[2], object.matrix[3])
                                  ).toFixed(2),
                                ),
                              ),
                            ),
                          ].sort((a, b) => a - b);
                          return sizes.length > 1
                            ? `혼합 (${sizes[0]}–${sizes[sizes.length - 1]} pt)`
                            : `${sizes[0] ?? selected.fontSize} pt`;
                        })()
                      : "— pt"}
                  </output>
                  <IconButton
                    icon={Bold}
                    label="굵게"
                    aria-pressed={
                      detectedStyle.mixed
                        ? "mixed"
                        : detectedStyle.weight !== null && detectedStyle.weight >= 600
                    }
                    disabled={styleDisabled || !toggleVariant}
                    title={
                      toggleVariant
                        ? "굵게 / 보통"
                        : "동일 글꼴의 보통 또는 굵은 서체가 필요합니다."
                    }
                    onClick={() => {
                      if (toggleVariant) changeSelectedFont(toggleVariant.id);
                    }}
                  />
                  <SelectField
                    label="굵기"
                    value="current"
                    className="w-32"
                    disabled={styleDisabled || !detectedStyle.variants.length}
                    onValueChange={changeSelectedFont}
                    options={detectedStyle.variants.map((variant) => ({
                      value: variant.id,
                      label: weightLabel(variant.weight),
                    }))}
                  >
                    {detectedStyle.mixed
                      ? "혼합 굵기"
                      : detectedStyle.weight === null
                        ? "굵기 정보 없음"
                        : weightLabel(detectedStyle.weight)}
                  </SelectField>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!selected || busy || loading || preparingEdit}
                      aria-label="텍스트 상세 설정"
                    >
                      <SlidersHorizontal size={14} />
                      상세
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[360px]" aria-label="텍스트 상세 설정">
                    <p className="mb-3 text-xs font-semibold text-stone-700">
                      텍스트 크기·원본 글꼴
                    </p>{" "}
                    {selected && (
                      <div className="flex flex-col gap-1">
                        <SizeControls
                          key={`${editState.revision}:${selected.id}`}
                          label="텍스트"
                          width={
                            Math.max(...selected.bounds.map((p) => p[0])) -
                            Math.min(...selected.bounds.map((p) => p[0]))
                          }
                          height={
                            Math.max(...selected.bounds.map((p) => p[1])) -
                            Math.min(...selected.bounds.map((p) => p[1]))
                          }
                          disabled={
                            busy ||
                            loading ||
                            preparingEdit ||
                            unsavedDraft ||
                            selected.fontChangeBlocked !== null
                          }
                          onApply={(width, height) => {
                            const oldWidth =
                              Math.max(...selected.bounds.map((p) => p[0])) -
                              Math.min(...selected.bounds.map((p) => p[0]));
                            const oldHeight =
                              Math.max(...selected.bounds.map((p) => p[1])) -
                              Math.min(...selected.bounds.map((p) => p[1]));
                            if (oldWidth > 0 && oldHeight > 0)
                              void run({
                                kind: "scaleText",
                                page: pageIndex,
                                objects: [
                                  ...new Set(
                                    selected.group?.runs.map((r) => r.object) ?? [selected.id],
                                  ),
                                ],
                                sx: width / oldWidth,
                                sy: height / oldHeight,
                              });
                          }}
                        />
                        {selected.group?.canFlow && (
                          <Button
                            variant="ghost"
                            type="button"
                            aria-label="너비 자동 확장"
                            aria-pressed={blockSize === null}
                            disabled={busy || loading || preparingEdit}
                            onClick={async () => {
                              if (blockSize !== null && !(await resetDialog.confirm())) return;
                              setBlockSize(null);
                            }}
                            className="self-start rounded border px-2 py-1 text-xs aria-pressed:bg-emerald-50 aria-pressed:text-emerald-800 disabled:opacity-40"
                            title="입력에 맞춰 너비가 늘어나고 페이지 오른쪽 끝에서 줄바꿈됩니다."
                          >
                            <MoveHorizontal size={16} aria-hidden="true" />{" "}
                            {blockSize === null ? "너비 자동 확장 켜짐" : "너비 자동 확장"}
                          </Button>
                        )}
                      </div>
                    )}
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => void importOriginalFont()}
                      disabled={!selected || busy || loading || preparingEdit}
                      className="ribbon-command mt-3 w-full justify-start border border-stone-200"
                    >
                      <FolderOpen size={22} aria-hidden="true" />
                      <span>원본 글꼴 불러오기</span>
                    </Button>
                  </PopoverContent>
                </Popover>{" "}
                <div className="flex items-center gap-1" role="group" aria-label="텍스트 정렬">
                  {(
                    [
                      ["left", "왼쪽 정렬", AlignLeft],
                      ["center", "가운데 정렬", AlignCenter],
                      ["right", "오른쪽 정렬", AlignRight],
                      ["justify", "양쪽 정렬", AlignJustify],
                    ] as const
                  ).map(([alignment, label, icon]) => (
                    <IconButton
                      key={alignment}
                      icon={icon}
                      label={label}
                      disabled={busy || loading || preparingEdit || !selected?.group?.canFlow}
                      aria-pressed={
                        (selected?.alignment ?? selected?.originalAlignment ?? "left") === alignment
                      }
                      className={
                        (selected?.alignment ?? selected?.originalAlignment ?? "left") === alignment
                          ? "bg-emerald-50 text-emerald-800"
                          : ""
                      }
                      onClick={() => {
                        if (!selected?.group?.canFlow || composing.current) return;
                        if (inlineEditing || unsavedDraft) setSelected({ ...selected, alignment });
                        else
                          void run({
                            kind: "alignBlock",
                            page: pageIndex,
                            groups: selected.mergedGroups ?? [selected.group.id],
                            alignment,
                          });
                      }}
                    />
                  ))}
                </div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 border-l border-stone-200 pl-3">
                <div className="flex flex-1 items-center gap-1">
                  {selected && (
                    <IconButton
                      icon={Info}
                      label="원본 글꼴 안내"
                      onClick={() => {
                        const names = [
                          ...new Set(
                            (selected.group
                              ? selected.group.runs.map(
                                  (r) =>
                                    page?.text.objects.find((o) => o.id === r.object)?.font ?? "",
                                )
                              : [selected.font]
                            )
                              .filter(Boolean)
                              .map((name) => name.replace(/^[A-Z]{6}\+/, "")),
                          ),
                        ];
                        setNotice({
                          kind: "info",
                          text: `원본 글꼴: ${names.join(", ")}. PDF 내장 글꼴을 우선 사용합니다. 새 글자가 없거나 내장 글꼴을 재사용할 수 없으면 ‘원본 글꼴 불러오기’로 동일한 이름·굵기의 TTF/TTC를 선택하세요. Windows 설치는 필요하지 않습니다. 다른 글꼴로 자동 교체하지 않으며, 초록색 표시가 모든 새 문자의 지원을 보장하지는 않습니다.`,
                        });
                      }}
                    />
                  )}
                  {!selected && (
                    <div className="flex items-center gap-2 px-2 text-xs text-stone-400">
                      <FileText size={20} />
                      <span className="whitespace-nowrap">텍스트를 선택하세요</span>
                    </div>
                  )}
                  {selected && (
                    <>
                      {!inlineEditing && (
                        <IconButton
                          icon={Pencil}
                          label="내용 수정"
                          disabled={
                            busy ||
                            (!!selected.editBlocked &&
                              selected.fontChangeBlocked !== null &&
                              !selected.group?.canFlow)
                          }
                          onClick={() => void beginEditing(selected)}
                        />
                      )}
                      <IconButton
                        icon={Check}
                        label="적용"
                        disabled={
                          busy ||
                          !unsavedDraft ||
                          (!!selected.editBlocked &&
                            selected.fontChangeBlocked !== null &&
                            !selected.group?.canFlow)
                        }
                        onClick={() => void commitDraft()}
                      />
                      <IconButton
                        icon={X}
                        label="취소"
                        disabled={busy}
                        onClick={() => void choose(null)}
                      />
                    </>
                  )}
                </div>
              </div>
              <span className="sr-only" role="status">
                {busy
                  ? "문서를 처리하고 있습니다…"
                  : selected?.editBlocked &&
                      selected.fontChangeBlocked !== null &&
                      !selected.group?.canFlow
                    ? selected.editBlocked
                    : null}
              </span>
            </div>
          </div>
        )}
        {fontWarning && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 bg-amber-50 px-6 py-2 text-sm text-amber-900"
          >
            <span>{fontWarning}</span>
            <Button variant="ghost" className="dialog-button" onClick={() => resolveFont()}>
              <Type size={16} aria-hidden="true" /> 글꼴 선택
            </Button>
          </div>
        )}
        {preparingEdit && (
          <p role="status" className="px-6 py-2 text-sm text-emerald-700">
            원본 글꼴을 준비하고 있습니다…
          </p>
        )}
        <MessageDialog
          message={discardOpen || stampDialog || textPageIndex !== null ? null : message}
          kind={failure ? "error" : (notice?.kind ?? "warning")}
          onDismiss={() => {
            setEditError(null);
            setNotice(null);
            setPageInputError(null);
          }}
          onRetry={
            error
              ? () => setRetry((n) => n + 1)
              : fontError
                ? () => setFontRetry((n) => n + 1)
                : undefined
          }
        />
        <ActionContextMenu
          label="PDF 페이지 작업"
          items={
            <>
              {editingEnabled && (
                <>
                  <ContextMenuItem
                    disabled={busy || loading || unsavedDraft || !editState.canUndo}
                    onSelect={() => void run({ kind: "undo" })}
                  >
                    <Undo2 />
                    실행 취소
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={busy || loading || unsavedDraft || !editState.canRedo}
                    onSelect={() => void run({ kind: "redo" })}
                  >
                    <Redo2 />
                    다시 실행
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem
                disabled={!page || loading || busy || unsavedDraft}
                onSelect={() => setTextPageIndex(pageIndex)}
              >
                <ScanText />
                글자 추출
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!page || loading || busy || unsavedDraft}
                onSelect={() => setMaskPage(page)}
              >
                <ScanLine />
                마스킹
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={pageCount === null}
                onSelect={() => setSidebarOpen((value) => !value)}
              >
                {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
                {sidebarOpen ? "페이지 목록 접기" : "페이지 목록 펼치기"}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={loading || busy || zoom === 100}
                onSelect={() => {
                  zoomPoint.current = null;
                  setZoom(100);
                }}
              >
                <RotateCcw />
                확대 비율 100%로 복원
              </ContextMenuItem>
              {editingEnabled && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={busy || loading || (!unsavedDraft && !editState.dirty)}
                    onSelect={() => void saveAs()}
                  >
                    <Save />
                    저장
                  </ContextMenuItem>
                </>
              )}
            </>
          }
        >
          <section
            ref={bindViewport}
            tabIndex={0}
            aria-label="PDF 페이지"
            aria-busy={loading}
            className="relative min-h-0 min-w-0 flex-1 overflow-auto p-6 [overflow-anchor:none]"
          >
            {loading && (
              <div className="absolute right-3 top-3 z-20 w-72 max-w-[calc(100%-1.5rem)]">
                <PageLoading page={pageIndex + 1} percent={loadPercent} />
              </div>
            )}
            {error && (
              <IconButton
                icon={RotateCcw}
                label="페이지 다시 불러오기"
                onClick={() => setRetry((n) => n + 1)}
              />
            )}
            {page && (
              <>
                <ZoomSurface
                  key={`${file.id}:${pageIndex}`}
                  width={page.width}
                  height={page.height}
                  targetWidth={(800 * zoom) / 100}
                  viewport={pageArea}
                  zoomPoint={zoomPoint}
                >
                  <TextPage
                    active={active}
                    fontGeneration={fontGeneration}
                    page={page}
                    name={file.name}
                    selected={selected}
                    disabled={!active || busy || loading || error !== null}
                    editingEnabled={editingEnabled}
                    mode={selectionMode}
                    onGraphicEdit={graphicEdit}
                    blockSize={blockSize}
                    onResize={setBlockSize}
                    inlineEditing={inlineEditing}
                    onBeginEdit={beginTextEdit}
                    onMove={moveText}
                    onDelete={deleteText}
                    draft={draft}
                    onDraft={setDraft}
                    onSelect={selectText}
                    onApply={applyText}
                    onComposition={composeText}
                  />
                </ZoomSurface>
              </>
            )}
          </section>
        </ActionContextMenu>
        <nav
          aria-label="페이지 탐색"
          className="absolute bottom-4 right-5 z-20 rounded-full border border-stone-200 bg-white/95 p-1.5 shadow-lg backdrop-blur"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitPage();
            }}
            className="flex items-center justify-center gap-1.5 text-xs"
          >
            <IconButton
              icon={ChevronLeft}
              label="이전 페이지"
              disabled={busy || loading || clearing || pageIndex === 0}
              onClick={() => void navigate(pageIndex - 1)}
            />
            <Input
              aria-label="현재 페이지"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={pageInput}
              disabled={busy || loading || clearing || pageCount === null}
              aria-invalid={pageInputError !== null}
              aria-describedby={pageInputError ? "page-input-error" : undefined}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setPageInput(event.target.value);
                setPageInputError(null);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setPageInput(String(pageIndex + 1));
                  setPageInputError(null);
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitPage();
                }
              }}
              className="h-8 w-10 rounded-md border-0 bg-stone-100 px-1 text-center text-xs tabular-nums"
            />
            <span className="text-stone-500" aria-label={`전체 ${pageCount ?? "확인 중"}페이지`}>
              / {pageCount ?? "…"}
            </span>
            <span className="sr-only" aria-live="polite">
              {pageIndex + 1} / {pageCount ?? "…"}
            </span>
            <IconButton
              icon={ChevronRight}
              label="다음 페이지"
              disabled={
                busy || loading || clearing || pageCount === null || pageIndex + 1 >= pageCount
              }
              onClick={() => void navigate(pageIndex + 1)}
            />
          </form>
        </nav>
      </div>
    </main>
  );
}
