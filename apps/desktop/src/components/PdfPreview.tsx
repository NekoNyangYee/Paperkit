import { useEffect, useMemo, useRef, useState } from "react";
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
  ImagePlus,
  ClipboardPaste,
} from "lucide-react";
import { IconButton } from "./ui/icon-button";
import { registerExitGuard } from "../lib/app-exit";
import { MessageDialog, useDiscardDialog } from "./MessageDialog";
import type { FileInfo } from "../lib/desktop";
import { errorMessage } from "../lib/desktop";
import {
  renderPage,
  releasePreview,
  editDocument,
  listFonts,
  groupSelection,
} from "../lib/preview";
import type { FontInfo } from "../lib/preview";
import type { TextSelection } from "../lib/preview";
import type { PreviewPage, TextObject, EditState, EditAction } from "../lib/preview";
import { useAppStore } from "../stores/app-store";
import { PageSidebar, type ThumbnailChange } from "./PageSidebar";
import { ZoomSurface } from "./ZoomSurface";
import { TextPage } from "./TextPage";
import { SizeControls } from "./SizeControls";
import {
  clipboardImage,
  readGraphicClipboard,
  type GraphicContent,
} from "../lib/graphic-clipboard";
import { editorFont, clearOriginalFonts } from "../lib/editor-font";
import { textBySource, fallbackCandidates } from "../lib/font-matching";
import { selectionStyle, weightLabel } from "../lib/font-style";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";

function originalFontIssue(cause: unknown) {
  const message = errorMessage(cause);
  return /^(원본 글꼴에 입력한 문자가 없습니다|원본 글꼴 데이터를 사용할 수 없습니다)/.test(
    message,
  );
}

export function PdfPreview({ file }: { file: FileInfo }) {
  const [fontGeneration, setFontGeneration] = useState(0);
  const {
    confirm: confirmDiscard,
    dialog: discardDialog,
    isOpen: discardOpen,
  } = useDiscardDialog();
  const pageArea = useRef<HTMLElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  const [pageInputError, setPageInputError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const renderContext = useRef("");
  const renderedLocation = useRef("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const working = useRef(false);
  const fontPreparation = useRef(0);
  const preparingObject = useRef<{ id: number; request: number } | null>(null);
  const [preparingEdit, setPreparingEdit] = useState(false);
  const unsavedDraft =
    selected !== null &&
    (draft !== selected.text || blockSize !== null || selected.alignment !== undefined);
  const closeState = useRef({ dirty: false, busy: false });
  closeState.current = { dirty: editState.dirty || unsavedDraft, busy };
  const clear = useAppStore((state) => state.clear);
  const selectionError = useAppStore((state) => state.error);
  const clearing = useAppStore((state) => state.phase === "clearing");

  const detectedStyle = useMemo(
    () => selectionStyle(selected, page?.text.objects ?? [], fonts),
    [selected, page?.text.objects, fonts],
  );
  const fontChoices = useMemo(
    () => ({
      bundled: fonts
        .filter((font) => font.source !== "installed")
        .map((font) => (
          <option key={font.id} value={font.id}>
            {font.name}
          </option>
        )),
      installed: fonts
        .filter((font) => font.source === "installed")
        .map((font) => (
          <option key={font.id} value={font.id}>
            {font.name}
          </option>
        )),
    }),
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
    const area = pageArea.current;
    if (!area) return;
    const wheel = (event: WheelEvent) => {
      // Only Ctrl+wheel zooms; ordinary wheel keeps native page scrolling.
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      if (busy || (loading && !page) || composing.current) return;
      if (unsavedDraft) {
        setNotice("입력한 내용을 적용하거나 취소한 뒤 확대·축소할 수 있습니다.");
        return;
      }
      // Apply every wheel event immediately. Only the expensive PDF render is
      // debounced below, so a fast burst never collapses into a single step.
      setZoom((current) => Math.max(25, Math.min(400, current + (event.deltaY < 0 ? 15 : -15))));
    };
    area.addEventListener("wheel", wheel, { passive: false });
    return () => {
      area.removeEventListener("wheel", wheel);
    };
  }, [busy, loading, unsavedDraft, page]);

  useEffect(() => {
    if (!editingEnabled) return;
    let disposed = false;
    setFontError(null);
    void listFonts()
      .then((result) => {
        if (!disposed) setFonts(result);
      })
      .catch((cause) => {
        if (!disposed) setFontError(errorMessage(cause));
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

  useEffect(() => {
    let disposed = false;
    fontPreparation.current++;
    const context = `${file.id}:${pageIndex}:${retry}`;
    const zoomOnly = renderContext.current === context;
    const location = `${file.id}:${pageIndex}`;
    const samePage = renderedLocation.current === location;
    renderContext.current = context;
    setLoading(true);
    setLoadPercent(0);
    setError(null);
    if (!samePage) {
      setPage(null);
      setSelected(null);
    }
    const timer = setTimeout(
      () => {
        // Display zoom is independent of the bounded native bitmap size.
        void renderPage(
          file.id,
          pageIndex,
          Math.max(300, Math.min(1600, (800 * zoom) / 100)),
          (percent) => {
            if (!disposed) setLoadPercent((previous) => Math.max(previous, percent));
          },
        )
          .then(async (result) => {
            if (disposed) return;
            setLoadPercent(95);
            // Decode before replacing the animated old bitmap to avoid a blank frame.
            if (typeof Image.prototype.decode === "function") {
              const image = new Image();
              image.src = result.imageUrl;
              await image.decode();
            }
            if (disposed) return;
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
                    .find(
                      (o) => o && o.matrix.every((v, i) => Math.abs(v - pending.matrix[i]) < 0.01),
                    )
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
          })
          .catch((cause: unknown) => {
            if (!disposed) setError(errorMessage(cause));
          })
          .finally(() => {
            if (!disposed) setLoading(false);
          });
      },
      zoomOnly ? 220 : 0,
    );
    return () => {
      disposed = true;
      fontPreparation.current++;
      clearTimeout(timer);
    };
  }, [file.id, pageIndex, zoom, retry]);

  async function approveDiscard() {
    working.current = true;
    setBusy(true);
    try {
      return await confirmDiscard();
    } catch (cause) {
      setEditError(errorMessage(cause));
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
      setNotice(object.fontChangeBlocked ?? object.editBlocked);
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
      for (const source of [...new Map(sources.map((o) => [o.id, o])).values()]) {
        if (preparation !== fontPreparation.current) return;
        if (source.editBlocked) {
          if (source.fontChangeBlocked) throw new Error(source.fontChangeBlocked);
          // A render-time font warning is not a final editing decision. Recheck
          // the actual embedded data (including PDF cmap recovery) on entry.
          const data = await invoke("document_font", {
            fileId: file.id,
            revision: editState.revision,
            pageIndex,
            objectId: source.id,
            text: source.text.trimEnd(),
            validateOnly: true,
          });
          if (typeof data !== "string") throw new Error(source.editBlocked);
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
    } catch (cause) {
      if (preparation === fontPreparation.current) setEditError(errorMessage(cause));
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
      clearOriginalFonts();
      setEditError(null);
      setFontGeneration((value) => value + 1);
      if (!unsavedDraft) setRetry((value) => value + 1);
      setNotice(
        `원본 글꼴을 불러왔습니다: ${matched.join(", ")}. Windows 설치 없이 이번 앱 실행 동안 사용합니다. 입력할 문자가 포함되어 있는지 적용 전에 확인합니다.`,
      );
    } catch (cause) {
      setEditError(errorMessage(cause));
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
    if (!editingEnabled || working.current || !page) return null;
    working.current = true;
    setBusy(true);
    setEditError(null);
    setNotice(null);
    try {
      const result = await editDocument(file.id, revision, action);
      setThumbnailChange(
        action.kind === "undo" || action.kind === "redo"
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
              page: "page" in action ? action.page : pageIndex,
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
      if (action.kind === "save") setNotice("새 PDF로 저장하고 다시 열어 검증했습니다.");
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
      setEditError(errorMessage(cause));
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
        else setEditError(errorMessage(cause));
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

  async function insertGraphic(read: () => Promise<GraphicContent>) {
    if (working.current || !page || !editingEnabled || loading || preparingEdit) return;
    const committed = await commitDraft();
    if (!committed || working.current) return;
    working.current = true;
    setBusy(true);
    setEditError(null);
    try {
      const content = await read();
      working.current = false;
      await run({ ...content, page: pageIndex }, committed.revision);
    } catch (cause) {
      setEditError(errorMessage(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
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
      setEditError(errorMessage(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function closeDocument() {
    if (working.current || (closeState.current.dirty && !(await approveDiscard()))) return;
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
      if (closeState.current.dirty && !(await confirmDiscard())) return;
      await useAppStore.getState().replaceFile([path]);
    } catch (cause) {
      setEditError(errorMessage(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let confirming = false;
    void (async () => {
      const window = getCurrentWindow();
      const stop = await window.onCloseRequested(async (event) => {
        if (!closeState.current.dirty && !working.current) return;
        event.preventDefault();
        if (working.current || confirming) return;
        confirming = true;
        try {
          if (await confirmDiscard()) await window.destroy();
        } catch (cause) {
          if (!disposed) setEditError(errorMessage(cause));
        } finally {
          confirming = false;
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })().catch((cause) => {
      if (!disposed) setEditError(`종료 확인을 등록하지 못했습니다: ${errorMessage(cause)}`);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(
    () =>
      registerExitGuard(async () => {
        if (working.current) throw new Error("문서 작업이 끝난 뒤 업데이트해 주세요.");
        if (closeState.current.dirty && !(await confirmDiscard())) return false;
        return !working.current;
      }),
    [],
  );

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
      if (document.querySelector('[role="alertdialog"], [role="dialog"]')) return;
      if (event.isComposing || composing.current) return;
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.matches("input, textarea") || event.target.isContentEditable);
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        void choose(null);
      }
      if (!(event.ctrlKey || event.metaKey) || busy || loading || !editingEnabled) return;
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

  useEffect(
    () => () => {
      void releasePreview(file.id).catch(() => {
        /* Backend shutdown needs no UI update. */
      });
    },
    [file.id],
  );

  const pageWarning =
    editingEnabled && page
      ? (page.text.warning ??
        (page.text.objects.length === 0
          ? "선택 가능한 텍스트 객체가 없습니다. 이미지나 윤곽선으로 저장된 글자일 수 있습니다."
          : null))
      : null;
  const message =
    editError ??
    selectionError ??
    error ??
    pageInputError ??
    (editingEnabled ? fontError : null) ??
    notice ??
    pageWarning;

  return (
    <main className="flex h-full select-none overflow-hidden">
      {discardDialog}
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
            <select
              aria-label="대체 글꼴"
              value={replacementFont}
              onChange={(event) => setReplacementFont(event.target.value)}
              className="mt-2 w-full rounded-lg border p-2"
            >
              {fonts.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.name}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button className="dialog-button" onClick={() => setFontResolution(false)}>
              계속 편집
            </button>
            <button
              className="dialog-button"
              onClick={() => {
                setFontResolution(false);
                void importOriginalFont();
              }}
            >
              원본 글꼴 불러오기
            </button>
            <button
              className="dialog-button bg-emerald-900 text-white"
              disabled={busy || !replacementFont || selected?.fontChangeBlocked !== null}
              onClick={() => void applyReplacementFont()}
            >
              대체 글꼴로 반영
            </button>
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
          open={sidebarOpen}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            </h1>
            <p className="mt-1 text-xs text-stone-500">
              {editState.dirty ? "저장하지 않은 변경 있음" : "원본 보호 · 새 파일로 저장"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              aria-label="확대 비율"
              value={zoom}
              disabled={busy || loading || unsavedDraft}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"
            >
              {Array.from({ length: 26 }, (_, i) => 25 + i * 15).map((value) => (
                <option key={value} value={value}>
                  {value}%
                </option>
              ))}
            </select>
          </div>
          <IconButton
            icon={X}
            label="닫기 · 다른 파일"
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
            <p className="min-w-0 flex-1 leading-5">
              <strong className="mr-2 font-semibold text-stone-800">읽기 전용</strong>
              원본을 보호하고 있습니다. 수정하려면 ‘편집 사용’을 눌러주세요.
            </p>
            <button
              type="button"
              onClick={() => {
                setEditingEnabled(true);
              }}
              disabled={loading || busy}
              className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium text-stone-800 shadow-sm transition-colors hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-40"
            >
              편집 사용
            </button>
          </div>
        )}
        {editingEnabled && (
          <div
            aria-label="편집 도구"
            className="editor-ribbon flex shrink-0 items-stretch gap-3 overflow-x-auto border-b border-stone-200 bg-white px-4 py-3 text-sm"
          >
            <div className="ribbon-group justify-center">
              <button
                type="button"
                disabled={busy || clearing}
                onClick={() => void openOtherFile()}
                className="ribbon-command"
              >
                <FolderOpen size={23} aria-hidden="true" />
                <span>다른 파일 열기</span>
              </button>
            </div>
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
              <span className="ribbon-caption">작업 기록</span>
            </div>
            <div className="ribbon-group">
              <input
                ref={imageInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
                aria-label="삽입할 이미지 파일"
                className="hidden"
                tabIndex={-1}
                onChange={(event) => {
                  const image = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (image)
                    void insertGraphic(async () => ({
                      kind: "pasteImage",
                      png: await clipboardImage(image),
                    }));
                }}
              />
              <div className="flex flex-1 items-center gap-1">
                <button
                  type="button"
                  className="ribbon-command"
                  disabled={busy || loading || preparingEdit || !page}
                  title="이미지 파일 선택 (PNG, JPG, WEBP, BMP, GIF)"
                  onClick={() => imageInput.current?.click()}
                >
                  <ImagePlus size={23} aria-hidden="true" />
                  <span>이미지 삽입</span>
                </button>
                <button
                  type="button"
                  className="ribbon-command"
                  disabled={busy || loading || preparingEdit || !page}
                  aria-label="이미지·도형 붙여넣기"
                  title="클립보드의 이미지·도형 붙여넣기 (Ctrl+V)"
                  onClick={() => void insertGraphic(readGraphicClipboard)}
                >
                  <ClipboardPaste size={23} aria-hidden="true" />
                  <span>붙여넣기</span>
                </button>
              </div>
              <span className="ribbon-caption">이미지·도형</span>
            </div>
            <div className="ribbon-group">
              <label className="flex flex-1 items-center gap-2 text-stone-600">
                <Type size={18} aria-hidden="true" />
                <span className="sr-only">글꼴</span>
                <select
                  aria-label="글꼴"
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
                  onChange={(event) => {
                    if (selected && event.target.value !== "current")
                      void run(
                        selected.group && selected.alignment
                          ? {
                              kind: "alignBlock",
                              page: pageIndex,
                              groups: selected.mergedGroups ?? [selected.group.id],
                              text: draft,
                              alignment: selected.alignment,
                              font: event.target.value,
                              ...(blockSize ?? {}),
                            }
                          : selected.group
                            ? {
                                kind: "changeBlockFont",
                                page: pageIndex,
                                group: selected.group.id,
                                font: event.target.value,
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
                                font: event.target.value,
                              },
                      );
                  }}
                  className="max-w-56 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm disabled:opacity-40"
                >
                  <option value="current" disabled>
                    {selected?.editFonts && Object.keys(selected.editFonts).length
                      ? `${selected.font} → ${[...new Set(Object.values(selected.editFonts))].map((id) => fonts.find((f) => f.id === id)?.name ?? id).join(", ")}`
                      : selected
                        ? selected.font
                        : "텍스트 선택"}
                  </option>
                  <optgroup label="기본 제공 글꼴">{fontChoices.bundled}</optgroup>
                  {fontChoices.installed.length > 0 && (
                    <optgroup label="이 PC의 글꼴">{fontChoices.installed}</optgroup>
                  )}
                </select>
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
                    toggleVariant ? "굵게 / 보통" : "동일 글꼴의 보통 또는 굵은 서체가 필요합니다."
                  }
                  onClick={() => {
                    if (toggleVariant) changeSelectedFont(toggleVariant.id);
                  }}
                />
                <select
                  aria-label="굵기"
                  className="rounded-lg border border-stone-200 bg-white px-2 py-1 text-sm disabled:opacity-40"
                  value="current"
                  disabled={styleDisabled || !detectedStyle.variants.length}
                  onChange={(event) => changeSelectedFont(event.target.value)}
                >
                  <option value="current" disabled>
                    {detectedStyle.mixed
                      ? "혼합 굵기"
                      : detectedStyle.weight === null
                        ? "굵기 정보 없음"
                        : weightLabel(detectedStyle.weight)}
                  </option>
                  {detectedStyle.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {weightLabel(variant.weight)}
                    </option>
                  ))}
                </select>
              </div>
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
                            ...new Set(selected.group?.runs.map((r) => r.object) ?? [selected.id]),
                          ],
                          sx: width / oldWidth,
                          sy: height / oldHeight,
                        });
                    }}
                  />
                  <span className="text-[10px] text-stone-500">
                    단위 pt · 가로·세로를 각각 늘이기 · 문단 핸들로 줄바꿈 폭 조절
                  </span>
                  {selected.group?.canFlow && (
                    <button
                      type="button"
                      aria-label="너비 자동 확장"
                      aria-pressed={blockSize === null}
                      disabled={busy || loading || preparingEdit}
                      onClick={() => setBlockSize(null)}
                      className="self-start rounded border px-2 py-1 text-xs aria-pressed:bg-emerald-50 aria-pressed:text-emerald-800 disabled:opacity-40"
                      title="입력에 맞춰 너비가 늘어나고 페이지 오른쪽 끝에서 줄바꿈됩니다."
                    >
                      {blockSize === null ? "너비 자동 확장 켜짐" : "너비 자동 확장"}
                    </button>
                  )}
                </div>
              )}
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

              <span className="ribbon-caption">글꼴</span>
            </div>
            <button
              type="button"
              onClick={() => void importOriginalFont()}
              disabled={!selected || busy || loading || preparingEdit}
              className="ribbon-command"
            >
              <FolderOpen size={22} aria-hidden="true" />
              <span>원본 글꼴 불러오기</span>
            </button>
            <span className="sr-only" role="status">
              {busy
                ? "문서를 처리하고 있습니다…"
                : selected?.editBlocked &&
                    selected.fontChangeBlocked !== null &&
                    !selected.group?.canFlow
                  ? selected.editBlocked
                  : "클릭: 선택 · 더블 클릭: 내용 수정 · 빈 곳 드래그: 여러 블록 선택 · Ctrl+휠: 확대/축소 · 휠: 스크롤"}
            </span>
            <div className="ribbon-group">
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
                      setNotice(
                        `원본 글꼴: ${names.join(", ")}. PDF 내장 글꼴을 우선 사용합니다. 새 글자가 없거나 내장 글꼴을 재사용할 수 없으면 ‘원본 글꼴 불러오기’로 동일한 이름·굵기의 TTF/TTC를 선택하세요. Windows 설치는 필요하지 않습니다. 다른 글꼴로 자동 교체하지 않으며, 초록색 표시가 모든 새 문자의 지원을 보장하지는 않습니다.`,
                      );
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
              <span className="ribbon-caption">내용 편집</span>
            </div>
            <div className="ml-auto flex shrink-0 flex-col items-center justify-center gap-1 px-2">
              <IconButton
                icon={Save}
                label="새 PDF로 저장"
                disabled={busy || loading || (!unsavedDraft && !editState.dirty)}
                onClick={() => void saveAs()}
                className="bg-emerald-900 text-white hover:bg-emerald-800"
              />
              <span className="ribbon-caption">새 PDF 저장</span>
            </div>
          </div>
        )}
        {fontWarning && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 bg-amber-50 px-6 py-2 text-sm text-amber-900"
          >
            <span>{fontWarning}</span>
            <button className="dialog-button" onClick={() => resolveFont()}>
              반영 방법 선택
            </button>
          </div>
        )}
        {preparingEdit && (
          <p role="status" className="px-6 py-2 text-sm text-emerald-700">
            원본 글꼴을 준비하고 있습니다…
          </p>
        )}
        <MessageDialog
          message={discardOpen ? null : message}
          title={
            editError || selectionError || error || pageInputError || fontError
              ? "확인해 주세요"
              : "알림"
          }
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
        <section
          ref={pageArea}
          aria-label="PDF 페이지"
          aria-busy={loading}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto p-6 [overflow-anchor:none]"
        >
          {loading && (
            <div className="absolute right-3 top-3 z-20 w-72 max-w-[calc(100%-1.5rem)] rounded-xl bg-white p-4 text-sm text-stone-600 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-4" role="status">
                <span>{pageIndex + 1}페이지 준비 중</span>
                <span>{loadPercent}%</span>
              </div>
              <progress
                aria-label="페이지 로딩 진행률"
                max={100}
                value={loadPercent}
                className="h-2 w-full accent-emerald-700"
              />
              <p className="mt-2 text-xs text-stone-500">
                {loadPercent < 15
                  ? "처리 대기"
                  : loadPercent < 40
                    ? "PDF 읽는 중"
                    : loadPercent < 85
                      ? "페이지와 글꼴 분석 중"
                      : "화면 준비 중"}{" "}
                · 단계별 진행률
              </p>
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
              >
                <TextPage
                  fontGeneration={fontGeneration}
                  page={page}
                  name={file.name}
                  selected={selected}
                  disabled={busy || loading || error !== null}
                  editingEnabled={editingEnabled}
                  mode={selectionMode}
                  onGraphicEdit={async (action) => !!(await run(action))}
                  blockSize={blockSize}
                  onResize={setBlockSize}
                  inlineEditing={inlineEditing}
                  onBeginEdit={(object) => void beginEditing(object)}
                  onMove={(dx, dy, target) => moveSelection(dx, dy, target)}
                  onDelete={(target) => void deleteSelection(target)}
                  draft={draft}
                  onDraft={setDraft}
                  onSelect={(object) => {
                    if (!object && unsavedDraft) void commitDraft();
                    else void choose(object);
                  }}
                  onApply={(value) => void commitDraft(value)}
                  onComposition={(value) => {
                    composing.current = value;
                  }}
                />
              </ZoomSurface>
            </>
          )}
        </section>
        <nav
          aria-label="페이지 탐색"
          className="shrink-0 border-t border-stone-200 bg-white px-4 py-3"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitPage();
            }}
            className="flex items-center justify-center gap-3 text-sm"
          >
            <IconButton
              icon={ChevronLeft}
              label="이전 페이지"
              disabled={busy || loading || clearing || pageIndex === 0}
              onClick={() => void navigate(pageIndex - 1)}
            />
            <input
              aria-label="현재 페이지"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={pageInput}
              disabled={busy || loading || clearing || pageCount === null}
              aria-invalid={pageInputError !== null}
              aria-describedby={pageInputError ? "page-input-error" : "page-input-help"}
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
              className="w-16 rounded-lg border border-stone-300 bg-white px-2 py-2 text-center tabular-nums focus:outline-2 focus:outline-emerald-700 disabled:opacity-40"
            />
            <span className="text-stone-500" aria-label={`전체 ${pageCount ?? "확인 중"}페이지`}>
              / {pageCount ?? "…"}
            </span>
            <span id="page-input-help" className="sr-only">
              페이지 번호를 입력하고 Enter를 누르세요. Escape로 현재 번호를 복원합니다.
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
