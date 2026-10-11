import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { groupSelection } from "../lib/preview";
import type { PreviewPage, TextSelection, SelectionMode } from "../lib/preview";
import { InlineTextEditor } from "./InlineTextEditor";
import { pdfDelta } from "../lib/coordinates";
import { mergeSelection } from "../lib/merge-selection";
import Moveable, { type Requester } from "react-moveable";
import { Move, Trash2, Combine, X } from "lucide-react";
import { IconButton } from "./ui/icon-button";
import { MessageDialog } from "./MessageDialog";

async function decodedLayer(data: string) {
  if (typeof data !== "string" || !data.startsWith("data:image/png;base64,"))
    throw new Error("미리보기 이미지 응답이 올바르지 않습니다.");
  if (typeof Image.prototype.decode === "function") {
    const image = new Image();
    image.src = data;
    await image.decode();
  }
  return data;
}

export function TextPage({
  fontGeneration = 0,
  page,
  name,
  selected,
  disabled,
  editingEnabled,
  mode,
  draft,
  onDraft,
  onApply,
  onSelect,
  onComposition,
  inlineEditing,
  onBeginEdit,
  onMove,
  onDelete,
  blockSize,
  onResize,
}: {
  fontGeneration?: number;
  page: PreviewPage;
  name: string;
  selected: TextSelection | null;
  disabled: boolean;
  editingEnabled: boolean;
  mode: SelectionMode;
  draft: string;
  onDraft: (text: string) => void;
  onApply: (text?: string) => void;
  onSelect: (object: TextSelection | null) => void;
  onComposition: (value: boolean) => void;
  inlineEditing: boolean;
  onBeginEdit: (object: TextSelection) => void;
  onMove: (dx: number, dy: number, target?: TextSelection) => void | Promise<boolean>;
  onDelete: (target: TextSelection) => void;
  blockSize: { width: number; height: number } | null;
  onResize: (size: { width: number; height: number }) => void;
}) {
  const point = useRef<{ x: number; y: number } | null>(null);
  const lastClick = useRef<{ id: number; x: number; y: number; time: number } | null>(null);
  const clickText = (object: TextSelection, event: React.MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    point.current = { x: event.clientX, y: event.clientY };
    const previous = lastClick.current;
    lastClick.current = {
      id: object.id,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
    };
    // Selecting inserts a drag overlay between the first and second click.
    // Browser dblclick requires the same target, so track this pair ourselves.
    if (
      previous?.id === object.id &&
      performance.now() - previous.time < 400 &&
      Math.hypot(previous.x - event.clientX, previous.y - event.clientY) < 5
    ) {
      lastClick.current = null;
      onBeginEdit(object);
    } else {
      setMultiple([]);
      onSelect(object);
    }
  };
  const [hovered, setHovered] = useState<TextSelection | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  };
  useEffect(() => () => keepHover(), []);
  const [multiple, setMultiple] = useState<TextSelection[]>([]);
  const [marquee, setMarquee] = useState<{
    x: number;
    y: number;
    endX: number;
    endY: number;
  } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const iconDrag = useRef<{ x: number; y: number; target: TextSelection } | null>(null);
  useEffect(() => {
    setHovered(null);
    setMultiple([]);
    setMarquee(null);
  }, [page, mode, inlineEditing]);
  const drag = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const moveable = useRef<Moveable>(null);
  const moveTarget = useRef<HTMLDivElement>(null);
  const inertDragTarget = useRef<HTMLSpanElement>(null);
  const requester = useRef<Requester | null>(null);
  const requested = useRef({ x: 0, y: 0 });
  const snapped = useRef({ x: 0, y: 0 });
  const [foreground, setForeground] = useState<string | null>(null);
  const movePreview = (x: number, y: number) => {
    if (!moveable.current) return;
    if (!requester.current) {
      requested.current = { x: 0, y: 0 };
      requester.current = moveable.current.request("draggable", { useSnap: true });
    }
    const displayScale = (moveTarget.current?.getBoundingClientRect().width ?? 0) / width || 1;
    const next = { x: x / displayScale, y: y / displayScale };
    requester.current.request({
      deltaX: next.x - requested.current.x,
      deltaY: next.y - requested.current.y,
    });
    requested.current = next;
  };
  const resetMove = () => {
    requester.current?.requestEnd();
    requester.current = null;
    snapped.current = { x: 0, y: 0 };
    setOffset({ x: 0, y: 0 });
  };
  useEffect(() => {
    resetMove();
  }, [selected?.id, page]);
  useEffect(() => {
    if (!disabled && !drag.current && !iconDrag.current) resetMove();
  }, [disabled]);
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const [background, setBackground] = useState<string | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [fontsReady, setFontsReady] = useState<string | null>(null);
  const [preparedSelection, setPreparedSelection] = useState<string | null>(null);
  const selectionKey = `${page.fileId}:${page.state.revision}:${page.pageIndex}:${selected?.group?.kind ?? "object"}:${selected?.id}:${JSON.stringify(selected?.group?.runs ?? [])}`;
  const completeSelection =
    !!selected &&
    (!selected.group ||
      selected.group.runs.every(
        (r) =>
          r.objectStart === 0 &&
          r.end - r.start >=
            Array.from(page.text.objects.find((o) => o.id === r.object)?.text.trimEnd() ?? "")
              .length,
      ));
  const fontReadyKey = `${selectionKey}:${page.width}:${prepareAttempt}:${fontGeneration}`;
  const ready =
    typeof FontFace === "undefined" ||
    (preparedSelection === selectionKey &&
      fontsReady === fontReadyKey &&
      (!completeSelection || background !== null));
  useEffect(() => {
    setBackground(null);
    setForeground(null);
    setBackgroundError(null);
    setPreparedSelection(selectionKey);
    let active = true;
    if (!selected) return;
    const ids = selected.group?.runs.map((r) => r.object) ?? [selected.id];
    const complete =
      !selected.group ||
      selected.group.runs.every(
        (r) =>
          r.objectStart === 0 &&
          r.end - r.start >=
            Array.from(page.text.objects.find((o) => o.id === r.object)?.text.trimEnd() ?? "")
              .length,
      );
    if (!complete) return;
    const args = {
      fileId: page.fileId,
      revision: page.state.revision,
      pageIndex: page.pageIndex,
      width: page.width,
      objects: ids,
    };
    // Keep the prepared layer when a selection enters editing. Serial requests
    // also avoid filling the PDF worker queue with both layers at once.
    void (async () => {
      let stage = "편집 배경";
      try {
        const data = await decodedLayer(await invoke<string>("editing_background", args));
        if (!active) return;
        setBackground(data);
        stage = "이동 미리보기";
        const foregroundData = await decodedLayer(
          await invoke<string>("editing_background", { ...args, foreground: true }),
        );
        if (active) setForeground(foregroundData);
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "알 수 없는 오류입니다.";
        if (active) setBackgroundError(`${stage} 준비 실패: ${detail}`);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectionKey, page.width, prepareAttempt]);
  const xs = selected?.screenBounds.map((p) => p[0]) ?? [0];
  const ys = selected?.screenBounds.map((p) => p[1]) ?? [0];
  const left = Math.max(0, Math.min(...xs));
  const top = Math.max(0, Math.min(...ys));
  const originalWidth = Math.min(page.width - left, Math.max(12, Math.max(...xs) - left));
  const originalHeight = Math.max(16, Math.max(...ys) - top);
  const pdfHeight = selected
    ? Math.max(...selected.bounds.map((p) => p[1])) - Math.min(...selected.bounds.map((p) => p[1]))
    : 0;
  const scale = pdfHeight > 0 ? (Math.max(...ys) - Math.min(...ys)) / pdfHeight : 1;
  const width = blockSize ? blockSize.width * scale : originalWidth;
  const height = blockSize ? blockSize.height * scale : originalHeight;
  const groups = mode === "object" ? [] : (page.text.groups ?? []).filter((g) => g.kind === mode);
  const groupedObjects = new Set(groups.flatMap((g) => g.runs.map((r) => r.object)));
  const targets: TextSelection[] = [
    ...groups
      .map((g) => groupSelection(g, page.text.objects))
      .filter((g): g is TextSelection => g !== null),
    ...page.text.objects.filter((o) => !groupedObjects.has(o.id)),
  ];
  const editorObjects = page.text.objects;
  const editorSelection = selected;
  const source = selected?.group
    ? page.text.objects.find((o) => o.id === selected.group!.runs[0]?.object)
    : selected;
  const canMove =
    selected &&
    (!selected.group ||
      (!selected.group.uncertain &&
        selected.group.runs.every((r) => {
          const o = page.text.objects.find((o) => o.id === r.object);
          return (
            o &&
            o.fontChangeBlocked === null &&
            r.objectStart === 0 &&
            r.end - r.start >= Array.from(o.text.trimEnd()).length
          );
        }))) &&
    (selected.group || selected.fontChangeBlocked === null);
  const merge = mergeSelection(multiple, page.text.objects);
  const moving =
    (offset.x !== 0 || offset.y !== 0) &&
    preparedSelection === selectionKey &&
    !!foreground &&
    !!background;
  const otherTargets = targets.filter((t) => t.id !== selected?.id);
  const verticalGuidelines = [
    0,
    page.width / 2,
    page.width,
    ...otherTargets.flatMap((t) => {
      const x = t.screenBounds.map((p) => p[0]);
      return [Math.min(...x), (Math.min(...x) + Math.max(...x)) / 2, Math.max(...x)];
    }),
  ];
  const horizontalGuidelines = [
    0,
    page.height / 2,
    page.height,
    ...otherTargets.flatMap((t) => {
      const y = t.screenBounds.map((p) => p[1]);
      return [Math.min(...y), (Math.min(...y) + Math.max(...y)) / 2, Math.max(...y)];
    }),
  ];
  const verticalSnaps = [...new Set(verticalGuidelines)].filter((x) =>
    [left + offset.x, left + offset.x + width / 2, left + offset.x + width].some(
      (edge) => Math.abs(edge - x) < 0.75,
    ),
  );
  const horizontalSnaps = [...new Set(horizontalGuidelines)].filter((y) =>
    [top + offset.y, top + offset.y + height / 2, top + offset.y + height].some(
      (edge) => Math.abs(edge - y) < 0.75,
    ),
  );
  return (
    <div
      className="relative mx-auto select-none bg-white shadow-lg"
      onMouseLeave={() => setHovered(null)}
      style={{ width: page.width, height: page.height }}
    >
      <img
        draggable={false}
        className="pointer-events-none block max-w-none"
        src={moving || (inlineEditing && ready && background) ? background! : page.imageUrl}
        width={page.width}
        height={page.height}
        alt={`${name} · ${page.pageIndex + 1}페이지`}
      />
      {moving && (
        <img
          data-testid="moving-text"
          aria-hidden="true"
          src={foreground!}
          width={page.width}
          height={page.height}
          className="pointer-events-none absolute left-0 top-0 z-[5] max-w-none"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        />
      )}
      {(offset.x !== 0 || offset.y !== 0) && (
        <svg
          aria-label="페이지 중앙 가이드"
          width={page.width}
          height={page.height}
          className="pointer-events-none absolute inset-0 z-20 text-fuchsia-500/60"
        >
          <path
            d={`M${page.width / 2} 0V${page.height}M0 ${page.height / 2}H${page.width}`}
            fill="none"
            stroke="currentColor"
            strokeDasharray="4 4"
          />
          <text x={page.width / 2 + 5} y={15} fill="currentColor" fontSize="11">
            중앙
          </text>
          {verticalSnaps.map((x) => (
            <line
              key={`x-${x}`}
              x1={x}
              x2={x}
              y1={0}
              y2={page.height}
              stroke="#d946ef"
              strokeWidth={1.5}
            />
          ))}
          {horizontalSnaps.map((y) => (
            <line
              key={`y-${y}`}
              x1={0}
              x2={page.width}
              y1={y}
              y2={y}
              stroke="#d946ef"
              strokeWidth={1.5}
            />
          ))}
        </svg>
      )}
      {editingEnabled && (
        <svg
          className="absolute inset-0"
          width={page.width}
          height={page.height}
          viewBox={`0 0 ${page.width} ${page.height}`}
          aria-label="텍스트 객체 선택"
          onClick={() => !disabled && onSelect(null)}
          onClickCapture={(event) => {
            if (suppressClick.current) {
              event.stopPropagation();
              suppressClick.current = false;
            }
          }}
          onPointerDown={(event) => {
            if (disabled || inlineEditing || event.button !== 0) return;
            const r = event.currentTarget.getBoundingClientRect();
            start.current = { x: event.clientX - r.left, y: event.clientY - r.top };
          }}
          onPointerMove={(event) => {
            if (!start.current) return;
            const r = event.currentTarget.getBoundingClientRect();
            if (
              Math.hypot(
                event.clientX - r.left - start.current.x,
                event.clientY - r.top - start.current.y,
              ) < 5
            )
              return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setMarquee({
              ...start.current,
              endX: event.clientX - r.left,
              endY: event.clientY - r.top,
            });
          }}
          onPointerCancel={() => {
            start.current = null;
            setMarquee(null);
          }}
          onPointerUp={(event) => {
            const s = start.current;
            start.current = null;
            setMarquee(null);
            if (!s) return;
            const r = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - r.left,
              y = event.clientY - r.top;
            if (Math.hypot(x - s.x, y - s.y) < 5) return;
            suppressClick.current = true;
            onSelect(null);
            setMultiple(
              targets.filter((t) => {
                const xs = t.screenBounds.map((p) => p[0]),
                  ys = t.screenBounds.map((p) => p[1]);
                return (
                  Math.max(...xs) >= Math.min(s.x, x) &&
                  Math.min(...xs) <= Math.max(s.x, x) &&
                  Math.max(...ys) >= Math.min(s.y, y) &&
                  Math.min(...ys) <= Math.max(s.y, y)
                );
              }),
            );
          }}
        >
          {targets.flatMap((object) =>
            (object.group?.kind === "paragraph"
              ? [object.screenBounds]
              : (object.group?.screenBounds ?? [object.screenBounds])
            ).map((bounds, index) => (
              <polygon
                key={`${object.id}-${index}`}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-label={`${object.group ? (mode === "sentence" ? "문장" : "블록") : "텍스트"} 선택: ${object.text}`}
                aria-pressed={selected?.id === object.id}
                aria-disabled={disabled}
                points={bounds.map((p) => p.join(",")).join(" ")}
                visibility={
                  (inlineEditing || moving) && selected?.id === object.id ? "hidden" : undefined
                }
                strokeDasharray={selected?.id === object.id ? undefined : "5 4"}
                data-editability={
                  !object.editBlocked
                    ? "editable"
                    : object.fontChangeBlocked === null || object.group?.canFlow
                      ? "font-required"
                      : "blocked"
                }
                className={`cursor-text fill-transparent stroke-1 outline-none hover:fill-emerald-500/5 hover:stroke-2 focus:stroke-2 ${!object.editBlocked ? "stroke-emerald-600" : object.fontChangeBlocked === null || object.group?.canFlow ? "stroke-amber-600" : "stroke-stone-400"}`}
                onMouseEnter={() => {
                  keepHover();
                  if (!inlineEditing) setHovered(object);
                }}
                onMouseLeave={() => {
                  hoverTimer.current = setTimeout(() => setHovered(null), 180);
                }}
                onClick={(event) => clickText(object, event)}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  point.current = { x: event.clientX, y: event.clientY };
                  if (!disabled) onBeginEdit(object);
                }}
                onKeyDown={(event) => {
                  if (!disabled && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    point.current = null;
                    if (event.key === "Enter") onBeginEdit(object);
                    else onSelect(object);
                  }
                }}
              >
                <title>
                  {object.editBlocked
                    ? `${object.fontChangeBlocked === null || object.group?.canFlow ? "글꼴 전환 후 편집 가능" : object.editBlocked}: ${object.text}`
                    : `편집 가능: ${object.text}`}
                </title>
              </polygon>
            )),
          )}
          {multiple.map((t) => (
            <polygon
              key={`multi-${t.id}`}
              points={t.screenBounds.map((p) => p.join(",")).join(" ")}
              className="pointer-events-none fill-emerald-500/10 stroke-emerald-600"
            />
          ))}
          {marquee && (
            <rect
              x={Math.min(marquee.x, marquee.endX)}
              y={Math.min(marquee.y, marquee.endY)}
              width={Math.abs(marquee.endX - marquee.x)}
              height={Math.abs(marquee.endY - marquee.y)}
              className="pointer-events-none fill-emerald-500/10 stroke-emerald-600"
            />
          )}
        </svg>
      )}
      {editingEnabled && selected && !inlineEditing && (
        <div
          ref={moveTarget}
          role="button"
          tabIndex={0}
          aria-label="선택 블록 이동"
          aria-disabled={disabled || !canMove}
          className="absolute z-10 cursor-move border-2 border-emerald-600 bg-emerald-500/5 outline-none focus:ring-2 focus:ring-emerald-300"
          style={{
            left,
            top,
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            width,
            height,
            touchAction: "none",
          }}
          onClick={(event) => {
            if (Math.hypot(offset.x, offset.y) < 3) clickText(selected, event);
          }}
          onDoubleClick={(event) => {
            point.current = { x: event.clientX, y: event.clientY };
            if (!disabled) onBeginEdit(selected);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !disabled) {
              event.preventDefault();
              onBeginEdit(selected);
            }
          }}
          onPointerDown={(event) => {
            if (disabled || !canMove || !source || event.button !== 0) return;
            if (!pdfDelta(source, 1, 1)) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
          }}
          onPointerMove={(event) => {
            const d = drag.current;
            if (d && d.pointer === event.pointerId)
              movePreview(event.clientX - d.x, event.clientY - d.y);
          }}
          onPointerCancel={() => {
            drag.current = null;
            resetMove();
          }}
          onLostPointerCapture={() => {
            if (drag.current) {
              drag.current = null;
              resetMove();
            }
          }}
          onPointerUp={(event) => {
            const d = drag.current;
            drag.current = null;
            if (!d || d.pointer !== event.pointerId) return;
            if (Math.hypot(event.clientX - d.x, event.clientY - d.y) < 3) {
              resetMove();
              return;
            }
            movePreview(event.clientX - d.x, event.clientY - d.y);
            const { x, y } = snapped.current;
            requester.current?.requestEnd();
            requester.current = null;
            const delta = source && pdfDelta(source, x, y);
            if (Math.hypot(x, y) > 3 && delta)
              void Promise.resolve(onMove(...delta)).then((ok) => {
                if (ok === false) resetMove();
              }, resetMove);
            else resetMove();
          }}
        >
          {["-left-1 -top-1", "-right-1 -top-1", "-left-1 -bottom-1", "-right-1 -bottom-1"].map(
            (position) => (
              <span
                key={position}
                className={`pointer-events-none absolute h-2 w-2 rounded-full bg-emerald-600 ${position}`}
              />
            ),
          )}
        </div>
      )}
      <span ref={inertDragTarget} className="hidden" />
      {editingEnabled && selected && !inlineEditing && canMove && (
        <Moveable
          ref={moveable}
          target={moveTarget}
          dragTarget={inertDragTarget}
          draggable
          snappable
          origin={false}
          hideDefaultLines
          renderDirections={[]}
          verticalGuidelines={verticalGuidelines}
          horizontalGuidelines={horizontalGuidelines}
          snapDirections={{
            left: true,
            right: true,
            top: true,
            bottom: true,
            center: true,
            middle: true,
          }}
          snapThreshold={6}
          bounds={{ left: 0, top: 0, right: page.width, bottom: page.height }}
          isDisplaySnapDigit={false}
          onDrag={({ beforeTranslate }) => {
            const value = { x: beforeTranslate[0], y: beforeTranslate[1] };
            snapped.current = value;
            setOffset(value);
          }}
        />
      )}
      {editingEnabled && selected && editorSelection && inlineEditing && (
        <div
          className={`absolute z-10 ${completeSelection ? "bg-transparent" : "bg-white"}`}
          data-testid="inline-block"
          style={{
            left,
            top,
            width:
              blockSize || (selected.group?.bounds.length ?? 0) > 1 || selected.alignment
                ? width
                : page.width - left,
            minHeight: height,
            visibility: ready ? "visible" : "hidden",
          }}
        >
          <InlineTextEditor
            key={fontReadyKey}
            selected={editorSelection}
            objects={editorObjects}
            draft={draft}
            scale={scale}
            fontContext={{
              fileId: page.fileId,
              revision: page.state.revision,
              pageIndex: page.pageIndex,
            }}
            visible={ready}
            onFontsReady={() => setFontsReady(fontReadyKey)}
            onFontError={setBackgroundError}
            disabled={disabled}
            point={point.current}
            onDraft={onDraft}
            onApply={onApply}
            onComposition={onComposition}
          />
        </div>
      )}
      <MessageDialog
        title="편집 화면 준비 오류"
        message={backgroundError}
        onRetry={() => setPrepareAttempt((value) => value + 1)}
      />
      {inlineEditing && !ready && !backgroundError && (
        <p
          role="status"
          className="absolute left-0 top-0 z-30 bg-white px-3 py-2 text-xs text-stone-600"
        >
          원본 글꼴과 편집 화면을 준비하고 있습니다…
        </p>
      )}
      {editingEnabled && !inlineEditing && multiple.length > 1 && (
        <div className="absolute left-2 top-2 z-30 rounded-lg border bg-white p-2 shadow">
          <IconButton
            icon={Combine}
            label={`${multiple.length}개 블록 함께 편집`}
            disabled={disabled || !merge}
            onClick={() => {
              if (merge) {
                setMultiple([]);
                onBeginEdit(merge);
              }
            }}
          />
          {!merge && (
            <p className="text-xs text-stone-500">완전한 편집 가능 문단 블록끼리 선택해 주세요.</p>
          )}
          <IconButton icon={X} label="취소" onClick={() => setMultiple([])} />
        </div>
      )}
      {editingEnabled && !inlineEditing && hovered && (
        <div
          onMouseEnter={keepHover}
          onMouseLeave={() => {
            if (!iconDrag.current) setHovered(null);
          }}
          className="absolute z-30 flex rounded border border-stone-200 bg-white shadow"
          style={{
            left: Math.max(
              0,
              Math.min(page.width - 80, Math.min(...hovered.screenBounds.map((p) => p[0]))),
            ),
            top: Math.min(page.height - 32, Math.max(...hovered.screenBounds.map((p) => p[1]))),
          }}
        >
          <button
            aria-label="블록 옮기기"
            title="드래그하여 옮기기"
            disabled={disabled || (!!hovered.fontChangeBlocked && !hovered.group?.canFlow)}
            className="cursor-move px-3 py-1 disabled:opacity-30"
            style={{ touchAction: "none" }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              iconDrag.current = { x: e.clientX, y: e.clientY, target: hovered };
              onSelect(hovered);
            }}
            onPointerMove={(e) => {
              const d = iconDrag.current;
              if (d) movePreview(e.clientX - d.x, e.clientY - d.y);
            }}
            onPointerUp={(e) => {
              const d = iconDrag.current;
              iconDrag.current = null;
              if (!d) return;
              if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) {
                resetMove();
                return;
              }
              movePreview(e.clientX - d.x, e.clientY - d.y);
              const { x, y } = snapped.current;
              requester.current?.requestEnd();
              requester.current = null;
              const source = d.target.group
                ? page.text.objects.find((o) => o.id === d.target.group!.runs[0].object)
                : d.target;
              const delta = source && pdfDelta(source, x, y);
              if (delta && Math.hypot(x, y) > 3)
                void Promise.resolve(onMove(...delta, d.target)).then((ok) => {
                  if (ok === false) resetMove();
                }, resetMove);
              else resetMove();
            }}
            onPointerCancel={() => {
              iconDrag.current = null;
              resetMove();
            }}
            onLostPointerCapture={() => {
              if (iconDrag.current) {
                iconDrag.current = null;
                resetMove();
              }
            }}
          >
            <Move size={16} aria-hidden="true" />
          </button>
          <button
            aria-label="블록 삭제"
            title="삭제 (실행 취소 가능)"
            disabled={
              disabled || !(hovered.group?.canFlow || (!hovered.group && !hovered.editBlocked))
            }
            onClick={() => {
              onDelete(hovered);
              setHovered(null);
            }}
            className="px-3 py-1 text-red-700 disabled:opacity-30"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {editingEnabled && !inlineEditing && selected?.group?.canFlow && (
        <button
          aria-label="블록 크기 조절"
          disabled={disabled}
          className="absolute z-20 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-emerald-600"
          style={{ left: left + width - 6, top: top + height - 6, touchAction: "none" }}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            resize.current = {
              x: event.clientX,
              y: event.clientY,
              width: width / scale,
              height: height / scale,
            };
          }}
          onPointerMove={(event) => {
            const r = resize.current;
            if (r)
              onResize({
                width: Math.max(
                  12,
                  Math.min((page.width - left) / scale, r.width + (event.clientX - r.x) / scale),
                ),
                height: Math.max(
                  12,
                  Math.min((page.height - top) / scale, r.height + (event.clientY - r.y) / scale),
                ),
              });
          }}
          onPointerUp={() => {
            resize.current = null;
          }}
          onPointerCancel={() => {
            resize.current = null;
          }}
          onLostPointerCapture={() => {
            resize.current = null;
          }}
        />
      )}
    </div>
  );
}
