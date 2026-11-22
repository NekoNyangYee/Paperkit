import { ActionButton } from "@/shared/ui/action-button";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import {
  Blend,
  Pencil,
  ScanLine,
  Scan,
  Trash2,
  Minus,
  Plus,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { PageLoading } from "../preview/PageLoading";
import { ZoomSurface } from "../preview/ZoomSurface";
import { usePageZoom } from "../preview/usePageZoom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import { renderPage } from "@/shared/pdf/api";
import type { PreviewPage, TextObject } from "@/shared/pdf/types";
import type { FileInfo } from "@/shared/desktop/files";
import { userErrorMessage } from "@/shared/lib/errors";

type Region = { page: number; x: number; y: number; right: number; bottom: number };
type TextMask = { page: number; object: number; start: number; end: number };
type MaskEntry = Region | TextMask;
const isTextMask = (entry: MaskEntry): entry is TextMask => "object" in entry;
const isWholePage = (entry: MaskEntry, page: number) =>
  !isTextMask(entry) &&
  entry.page === page &&
  entry.x === 0 &&
  entry.y === 0 &&
  entry.right === 1 &&
  entry.bottom === 1;

type Point = { x: number; y: number };
function point(e: PointerEvent<HTMLDivElement>): Point {
  const box = e.currentTarget.getBoundingClientRect();
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return {
    x: clamp((e.clientX - box.left) / box.width),
    y: clamp((e.clientY - box.top) / box.height),
  };
}
function region(page: number, a: Point, b: Point): Region {
  return {
    page,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}
type Drag = { p: Point; id: number; target?: { index: number; mask: Region; handle: string } };
function draggedRegion(drag: Drag, end: Point, page: PreviewPage): Region {
  if (!drag.target) return region(page.pageIndex, drag.p, end);
  const { mask, handle } = drag.target;
  const dx = end.x - drag.p.x,
    dy = end.y - drag.p.y;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (handle === "move") {
    const x = clamp(dx, -mask.x, 1 - mask.right),
      y = clamp(dy, -mask.y, 1 - mask.bottom);
    return {
      ...mask,
      x: mask.x + x,
      right: mask.right + x,
      y: mask.y + y,
      bottom: mask.bottom + y,
    };
  }
  return {
    ...mask,
    x: handle.includes("w") ? clamp(mask.x + dx, 0, mask.right - 1 / page.width) : mask.x,
    right: handle.includes("e") ? clamp(mask.right + dx, mask.x + 1 / page.width, 1) : mask.right,
    y: handle.includes("n") ? clamp(mask.y + dy, 0, mask.bottom - 1 / page.height) : mask.y,
    bottom: handle.includes("s")
      ? clamp(mask.bottom + dy, mask.y + 1 / page.height, 1)
      : mask.bottom,
  };
}
function Overlay({
  mask,
  image,
  draft = false,
  selected = false,
  index,
}: {
  mask: Region;
  image: HTMLImageElement | null;
  draft?: boolean;
  selected?: boolean;
  index?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (!image || !canvas.current) return;
    const ctx = canvas.current.getContext("2d");
    if (!ctx) return;
    const w = image.naturalWidth,
      h = image.naturalHeight;
    const x = Math.floor(mask.x * w),
      y = Math.floor(mask.y * h);
    const width = Math.max(1, Math.ceil(mask.right * w) - x);
    const height = Math.max(1, Math.ceil(mask.bottom * h) - y);
    const cell = Math.max(12, Math.ceil(w / 20));
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    canvas.current.width = cols;
    canvas.current.height = rows;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, x, y, width, height, 0, 0, cols, rows);
  }, [image, mask]);
  return (
    <div
      data-region={index}
      className={`absolute bg-stone-200 ${index === undefined ? "pointer-events-none" : "cursor-move"} ${draft || selected ? "outline-2 outline-emerald-600" : ""}`}
      style={{
        left: mask.x * 100 + "%",
        top: mask.y * 100 + "%",
        width: (mask.right - mask.x) * 100 + "%",
        height: (mask.bottom - mask.y) * 100 + "%",
      }}
    >
      <canvas
        aria-hidden="true"
        ref={canvas}
        width={2}
        height={2}
        className="pointer-events-none block size-full"
      />
      {selected &&
        index !== undefined &&
        ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) => (
          <span
            key={handle}
            data-handle={handle}
            aria-hidden="true"
            className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white bg-emerald-700"
            style={{
              left: handle.includes("w") ? "0%" : handle.includes("e") ? "100%" : "50%",
              top: handle.includes("n") ? "0%" : handle.includes("s") ? "100%" : "50%",
              cursor: handle + "-resize",
            }}
          />
        ))}
    </div>
  );
}

export function MaskDialog({
  active,
  file,
  initial,
  onClose,
  onSaved,
}: {
  active: boolean;
  file: FileInfo;
  initial: PreviewPage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [index, setIndex] = useState(initial.pageIndex);
  const [preview, setPreview] = useState<PreviewPage | null>(initial);
  const [masks, setMasks] = useState<MaskEntry[]>([]);
  const [starMode, setStarMode] = useState(false);
  const [textBlock, setTextBlock] = useState<TextObject | null>(null);
  const rangeInput = useRef<HTMLTextAreaElement>(null);
  const [replacing, setReplacing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Region | null>(null);
  const start = useRef<Drag | null>(null);
  useEffect(() => {
    if (!active) {
      start.current = null;
      setDraft(null);
    }
  }, [active]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const viewport = useRef<HTMLElement | null>(null);
  const { zoom, setZoom, zoomKey, zoomPoint, bindViewport } = usePageZoom(viewport, active, saving);
  const [fitWidth, setFitWidth] = useState(800);
  const attachViewport = useCallback(
    (node: HTMLDivElement | null) => {
      const detach = bindViewport(node);
      if (!node) return;
      const observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width && width > 0) setFitWidth(width);
      });
      observer.observe(node);
      return () => {
        observer.disconnect();
        detach?.();
      };
    },
    [bindViewport],
  );
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const history = useRef<{ undo: MaskEntry[][]; redo: MaskEntry[][] }>({ undo: [], redo: [] });
  function change(next: MaskEntry[]) {
    history.current.undo.push(masks);
    if (history.current.undo.length > 50) history.current.undo.shift();
    history.current.redo = [];
    setMasks(next);
  }
  function restore(direction: "undo" | "redo") {
    const snapshot = history.current[direction].pop();
    if (!snapshot) return;
    history.current[direction === "undo" ? "redo" : "undo"].push(masks);
    setMasks(snapshot);
    setSelected(null);
    setReplacing(null);
    start.current = null;
    setDraft(null);
  }
  function remove(i: number) {
    change(masks.filter((_, n) => n !== i));
    setSelected(null);
    setReplacing(null);
  }
  function navigate(page: number) {
    if (page < 0 || page >= initial.pageCount || page === index) return;
    setSelected(null);
    setReplacing(null);
    setTextBlock(null);
    setIndex(page);
  }
  useEffect(() => {
    let current = true;
    setError("");
    setImage(null);
    setDraft(null);
    start.current = null;
    if (index === initial.pageIndex) {
      setPreview(initial);
      return;
    }
    setPreview(null);
    void renderPage(file.id, index, 1600)
      .then((p) => {
        if (!current) return;
        if (p.state.revision !== initial.state.revision) throw Error();
        setPreview(p);
      })
      .catch(() => {
        if (current) setError("페이지를 불러오지 못했습니다. 다시 시도해 주세요.");
      });
    return () => {
      current = false;
    };
  }, [file.id, index, initial, retry]);
  function add(mask: Region) {
    if (
      isWholePage(mask, index) &&
      masks.some((entry, i) => i !== replacing && isWholePage(entry, index))
    )
      return;
    if (replacing === null && masks.length >= 2048) {
      setError("한 사본에는 최대 2,048개 영역을 지정할 수 있습니다.");
      return;
    }
    change(
      replacing === null ? [...masks, mask] : masks.map((m, i) => (i === replacing ? mask : m)),
    );
    setSelected(replacing ?? masks.length);
    setReplacing(null);
  }
  function addTextRange() {
    const input = rangeInput.current;
    if (!input || !textBlock) return;
    const { value, selectionStart, selectionEnd } = input;
    const partial = selectionEnd > selectionStart;
    let start = partial ? Array.from(value.slice(0, selectionStart)).length : 0;
    let end = partial ? Array.from(value.slice(0, selectionEnd)).length : Array.from(value).length;
    if (start === end) return;
    const other = masks.filter((m) => {
      if (
        !isTextMask(m) ||
        m.page !== index ||
        m.object !== textBlock.id ||
        m.end < start ||
        m.start > end
      )
        return true;
      start = Math.min(start, m.start);
      end = Math.max(end, m.end);
      return false;
    });
    if (other.length >= 2048) {
      setError("한 사본에는 최대 2,048개 영역을 지정할 수 있습니다.");
      return;
    }
    change([...other, { page: index, object: textBlock.id, start, end }]);
    setSelected(other.length);
    setTextBlock(null);
  }

  // Blur geometry does not affect the text raster. Reuse it across moves and resizes.
  const pageTextMasks = JSON.stringify(masks.filter(isTextMask).filter((m) => m.page === index));
  const [raster, setRaster] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (pageTextMasks === "[]") return;
    let current = true;
    let url: string | undefined;
    setError("");
    void invoke<ArrayBuffer>("preview_text_masks", {
      fileId: file.id,
      revision: initial.state.revision,
      page: index,
      textMasks: JSON.parse(pageTextMasks),
    })
      .then((png) => {
        if (!current) return;
        url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
        setRaster({ key: pageTextMasks, url });
      })
      .catch((cause) => {
        if (current) setError(userErrorMessage(cause, "edit"));
      });
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
      setRaster(null);
    };
  }, [file.id, index, initial.state.revision, pageTextMasks, retry]);

  async function exportCopy() {
    if (lock.current || start.current || !masks.length) return;
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      const path = await save({
        title: "마스킹 사본 저장",
        defaultPath: file.path.replace(/\.pdf$/i, "-masked.pdf"),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!path) return;
      await invoke("save_masked_copy", {
        fileId: file.id,
        revision: initial.state.revision,
        masks: masks
          .filter((m): m is Region => !isTextMask(m))
          .map((mask) => ({ ...mask, stars: false, blur: true })),
        ...(masks.some(isTextMask) ? { textMasks: masks.filter(isTextMask) } : {}),
        path,
      });
      onSaved();
    } catch (cause) {
      setError(userErrorMessage(cause, "save"));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  const pageImage =
    pageTextMasks === "[]"
      ? preview?.imageUrl
      : raster?.key === pageTextMasks
        ? raster.url
        : undefined;
  const visible = preview?.pageIndex === index && pageImage ? preview : null;
  function shortcut(e: KeyboardEvent) {
    if (!active || e.nativeEvent.isComposing || e.altKey || e.defaultPrevented) return;
    const control = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (saving) return;
    if (control && zoomKey(key)) {
      e.preventDefault();
      return;
    }
    if (control && key === "s") {
      e.preventDefault();
      if (visible && replacing === null && !e.repeat) void exportCopy();
      return;
    }
    if (
      e.target instanceof HTMLElement &&
      e.target.closest('input,textarea,select,[contenteditable="true"]')
    )
      return;
    if (control && (key === "z" || key === "y")) {
      e.preventDefault();
      restore(key === "y" || e.shiftKey ? "redo" : "undo");
    } else if (!control && (key === "delete" || key === "backspace") && selected !== null) {
      e.preventDefault();
      if (!e.repeat) remove(selected);
    } else if (!control && ["pageup", "pagedown", "arrowleft", "arrowright"].includes(key)) {
      e.preventDefault();
      navigate(index + (key === "pageup" || key === "arrowleft" ? -1 : 1));
    }
  }
  return (
    <Dialog
      open={active}
      onOpenChange={(open) => {
        if (!open && !lock.current) onClose();
      }}
    >
      <DialogContent
        cancelDisabled={saving}
        onKeyDown={shortcut}
        onEscapeKeyDown={(e) => {
          if (saving || start.current || replacing !== null) {
            e.preventDefault();
            start.current = null;
            setDraft(null);
            setReplacing(null);
          }
        }}
        className="flex h-[min(90vh,900px)] w-[min(95vw,1120px)] min-w-0 flex-col overflow-x-hidden gap-3 p-5"
      >
        <DialogTitle className="text-lg font-semibold">마스킹 사본 만들기</DialogTitle>
        <DialogDescription className="text-sm text-stone-600">
          블러는 윤곽이 남을 수 있습니다. 사본은 이미지로 저장되며 검색용 텍스트, 양식, 첨부파일은
          제외됩니다.
        </DialogDescription>
        {!!initial.signatures?.length && (
          <p role="note" className="rounded bg-amber-50 p-2 text-sm text-amber-900">
            원본의 디지털 서명은 마스킹 사본에 승계되지 않습니다.
          </p>
        )}
        <fieldset disabled={saving} className="flex w-full min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!visible || masks.some((m) => isWholePage(m, index))}
              onClick={() => add({ page: index, x: 0, y: 0, right: 1, bottom: 1 })}
            >
              <Scan size={15} /> 페이지 전체 가리기
            </Button>
            <Button
              size="sm"
              variant={starMode ? "default" : "outline"}
              aria-pressed={starMode}
              onClick={() => {
                setStarMode(!starMode);
                setReplacing(null);
                setTextBlock(null);
              }}
            >
              <span aria-hidden="true" className="font-mono font-bold">
                **
              </span>{" "}
              별표 대체
            </Button>
            <div className="ml-auto flex items-center rounded-lg border border-stone-200 bg-white p-0.5">
              <Button
                variant="ghost"
                size="icon"
                aria-label="축소"
                title="축소"
                disabled={zoom <= 25}
                onClick={() => zoomKey("-")}
              >
                <Minus size={14} />
              </Button>
              <select
                aria-label="확대 비율"
                className="rounded px-1 text-xs tabular-nums"
                value={Math.round(zoom)}
                onChange={(e) => {
                  zoomPoint.current = null;
                  setZoom(Number(e.target.value));
                }}
              >
                {Array.from(new Set([25, 50, 75, 100, 125, 150, 200, 300, 400, Math.round(zoom)]))
                  .sort((a, b) => a - b)
                  .map((z) => (
                    <option key={z} value={z}>
                      {z}%
                    </option>
                  ))}
              </select>
              <Button
                variant="ghost"
                size="icon"
                aria-label="확대"
                title="확대"
                disabled={zoom >= 400}
                onClick={() => zoomKey("+")}
              >
                <Plus size={14} />
              </Button>
            </div>
          </div>
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_clamp(9rem,20vw,13rem)] gap-3">
            <div
              ref={attachViewport}
              tabIndex={0}
              aria-label="마스킹 페이지"
              className="min-h-0 min-w-0 overflow-auto [contain:inline-size] rounded-xl border border-stone-200 bg-stone-100 p-3 [overflow-anchor:none] [scrollbar-gutter:stable]"
            >
              {visible ? (
                <ZoomSurface
                  key={index}
                  width={visible.width}
                  height={visible.height}
                  targetWidth={(fitWidth * zoom) / 100}
                  viewport={viewport}
                  zoomPoint={zoomPoint}
                >
                  <div
                    className="relative mx-auto touch-none select-none bg-white cursor-crosshair"
                    aria-label="마스킹 영역 선택"
                    onPointerDown={(e) => {
                      if (!e.isPrimary || e.button !== 0 || saving || starMode) return;
                      if (start.current) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const el = e.target instanceof Element ? e.target : null;
                      const entry =
                        replacing === null ? el?.closest<HTMLElement>("[data-region]") : null;
                      const idx = Number(entry?.dataset.region);
                      const mask = masks[idx];
                      const target =
                        entry && mask && !isTextMask(mask)
                          ? {
                              index: idx,
                              mask,
                              handle:
                                el?.closest<HTMLElement>("[data-handle]")?.dataset.handle ?? "move",
                            }
                          : undefined;
                      start.current = { p: point(e), id: e.pointerId, target };
                      if (target) setSelected(idx);
                      setDraft(null);
                    }}
                    onPointerMove={(e) => {
                      if (start.current?.id === e.pointerId)
                        setDraft(draggedRegion(start.current, point(e), visible));
                    }}
                    onPointerCancel={() => {
                      start.current = null;
                      setDraft(null);
                    }}
                    onLostPointerCapture={() => {
                      start.current = null;
                      setDraft(null);
                    }}
                    onPointerUp={(e) => {
                      if (start.current?.id !== e.pointerId) return;
                      const target = start.current.target;
                      const m = draggedRegion(start.current, point(e), visible);
                      start.current = null;
                      setDraft(null);
                      if (target) {
                        const before = target.mask;
                        if (
                          m.x !== before.x ||
                          m.y !== before.y ||
                          m.right !== before.right ||
                          m.bottom !== before.bottom
                        )
                          change(masks.map((item, i) => (i === target.index ? m : item)));
                        return;
                      }
                      if (
                        (m.right - m.x) * visible.width >= 1 &&
                        (m.bottom - m.y) * visible.height >= 1
                      )
                        add(m);
                    }}
                  >
                    <img
                      key={pageImage}
                      onLoad={(e) => setImage(e.currentTarget)}
                      src={pageImage}
                      alt={`${index + 1}페이지 마스킹 미리보기`}
                      draggable={false}
                      className="block w-full"
                      width={visible.width}
                      height={visible.height}
                    />
                    {masks.map(
                      (m, i) =>
                        !isTextMask(m) &&
                        m.page === index && (
                          <Overlay
                            key={i}
                            index={i}
                            mask={start.current?.target?.index === i && draft ? draft : m}
                            selected={selected === i}
                            image={image?.getAttribute("src") === pageImage ? image : null}
                          />
                        ),
                    )}
                    {starMode && (
                      <svg
                        viewBox={`0 0 ${visible.width} ${visible.height}`}
                        className="absolute inset-0 size-full"
                        aria-label="대체할 텍스트 블록"
                      >
                        {visible.text.objects
                          .filter((o) => o.text.trim() && (!o.editBlocked || !o.fontChangeBlocked))
                          .map((o) => (
                            <polygon
                              key={o.id}
                              points={o.screenBounds.map((p) => p.join(",")).join(" ")}
                              role="button"
                              tabIndex={0}
                              aria-label={`텍스트 선택: ${o.text}`}
                              aria-pressed={textBlock?.id === o.id}
                              className="cursor-text fill-transparent stroke-emerald-500 hover:fill-emerald-200/40 focus:fill-emerald-200/40"
                              vectorEffect="non-scaling-stroke"
                              strokeDasharray="3 2"
                              onClick={() => setTextBlock(o)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setTextBlock(o);
                                }
                              }}
                            />
                          ))}
                      </svg>
                    )}
                    {draft && !start.current?.target && (
                      <Overlay mask={draft} image={image} draft />
                    )}
                  </div>
                </ZoomSurface>
              ) : (
                <div className="grid h-full min-h-40 place-items-center">
                  {error ? (
                    <ActionButton
                      action="retry"
                      variant="outline"
                      onClick={() => setRetry((n) => n + 1)}
                    />
                  ) : (
                    <PageLoading page={index + 1} />
                  )}
                </div>
              )}
            </div>
            <aside
              aria-label="선택 영역"
              className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-stone-50 text-xs"
            >
              <h3 className="flex items-center gap-2 border-b border-stone-200 bg-white px-3 py-3 font-semibold text-stone-800">
                <ScanLine className="text-emerald-700" size={16} /> 선택 영역{" "}
                <span className="ml-auto rounded-md bg-emerald-50 px-2 py-0.5 text-emerald-800">
                  {masks.length}개
                </span>
              </h3>
              <div className="min-h-0 overflow-y-auto p-2">
                {starMode && (
                  <div className="mb-2 rounded-lg border border-emerald-200 bg-white p-2.5">
                    {textBlock ? (
                      <>
                        <label className="block font-medium" htmlFor="mask-text-range">
                          대체할 글자 범위
                        </label>
                        <textarea
                          id="mask-text-range"
                          ref={rangeInput}
                          key={textBlock.id}
                          value={textBlock.text}
                          readOnly
                          className="my-2 w-full resize-y rounded border border-stone-200 p-1.5 text-sm"
                        />
                        <p className="mb-2 text-stone-600">글자를 선택하면 해당 범위만 바뀝니다.</p>
                        <ActionButton action="apply" size="sm" onClick={addTextRange} />
                      </>
                    ) : (
                      <p>
                        {visible &&
                        !visible.text.objects.some(
                          (o) => o.text.trim() && (!o.editBlocked || !o.fontChangeBlocked),
                        )
                          ? "이 페이지에는 대체할 수 있는 텍스트 블록이 없습니다."
                          : "페이지에서 대체할 텍스트 블록을 선택하세요."}
                      </p>
                    )}
                  </div>
                )}
                {!masks.length && !starMode && (
                  <div className="px-2 py-6 text-center leading-5 text-stone-500">
                    <Scan className="mx-auto mb-2 text-stone-400" size={22} />
                    페이지에서 가릴 영역을 드래그하세요.
                  </div>
                )}
                {replacing !== null && (
                  <p role="status" className="mb-2 text-emerald-800">
                    새 범위를 드래그하세요.
                    <button
                      type="button"
                      className="ml-2 underline"
                      onClick={() => setReplacing(null)}
                    >
                      재지정 취소
                    </button>
                  </p>
                )}
                {masks.map((m, i) => (
                  <div
                    key={i}
                    className={`mb-2 rounded-lg border bg-white p-2.5 ${selected === i ? "border-emerald-400" : "border-stone-200"}`}
                  >
                    <button
                      type="button"
                      aria-pressed={selected === i}
                      onClick={() => {
                        navigate(m.page);
                        setReplacing(null);
                        setSelected(i);
                      }}
                      className="flex w-full items-center gap-2 text-left font-medium"
                    >
                      <Blend size={14} /> {m.page + 1}쪽 · 영역 {i + 1}
                    </button>
                    <div className="mt-2 flex items-center gap-1">
                      <span className="mr-auto text-stone-500">
                        {isTextMask(m) ? "** 별표 대체" : "블러"}
                      </span>
                      {!isTextMask(m) && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`영역 ${i + 1} 다시 지정`}
                          title="다시 지정"
                          onClick={() => {
                            navigate(m.page);
                            setSelected(i);
                            setStarMode(false);
                            setReplacing(i);
                          }}
                        >
                          <Pencil size={13} />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-rose-700 hover:bg-rose-50"
                        aria-label={`영역 ${i + 1} 삭제`}
                        title="삭제"
                        onClick={() => remove(i)}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </aside>
          </div>
          <div className="flex items-center justify-center gap-3 text-sm">
            <Button
              size="sm"
              variant="ghost"
              disabled={index === 0}
              onClick={() => navigate(index - 1)}
              title="이전 페이지"
            >
              <ChevronLeft size={15} /> 이전
            </Button>
            {index + 1} / {initial.pageCount}
            <Button
              size="sm"
              variant="ghost"
              disabled={index + 1 === initial.pageCount}
              onClick={() => navigate(index + 1)}
              title="다음 페이지"
            >
              <ChevronRight size={15} /> 다음
            </Button>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-stone-100 pt-3">
          <ActionButton
            busy={saving}
            action="save"
            disabled={!masks.length || !visible || replacing !== null}
            onClick={() => void exportCopy()}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
