import { Button } from "@/shared/ui/button";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { renderThumbnail } from "@/shared/pdf/api";
import { RotateCcw, RotateCw, Copy, Trash2 } from "lucide-react";
import appIcon from "../../../../../app-icon.svg";
import { IconButton } from "@/shared/ui/icon-button";

const ROW_HEIGHT = 196;
const CACHE_LIMIT = 64;
export interface ThumbnailChange {
  fromRevision: number;
  revision: number;
  operation: "move" | "duplicate" | "rotate" | "delete" | "content" | "save";
  page: number;
  destination?: number;
}

export function PageSidebar({
  fileId,
  pageCount,
  selectedPage,
  onSelect,
  open,
  revision = 0,
  paused = false,
  editable = false,
  onPageAction,
  thumbnailChange,
}: {
  fileId: string;
  pageCount: number;
  selectedPage: number;
  onSelect: (page: number) => void;
  open: boolean;
  revision?: number;
  paused?: boolean;
  editable?: boolean;
  onPageAction?: (
    operation: "move" | "duplicate" | "rotate" | "delete",
    page: number,
    destination?: number,
  ) => void;
  thumbnailChange?: ThumbnailChange | null;
}) {
  const drag = useRef<{
    page: number;
    y: number;
    x: number;
    startY: number;
    target: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragView, setDragView] = useState<{
    page: number;
    target: number;
    x: number;
    y: number;
  } | null>(null);
  const dropAt = dragView?.target;
  const canEdit = editable && !paused && !!onPageAction;
  function finishDrag(cancel = false) {
    const current = drag.current;
    drag.current = null;
    setDragView(null);
    if (current?.moved) {
      suppressClick.current = true;
      if (!cancel && canEdit && current.page !== current.target)
        onPageAction?.("move", current.page, current.target);
    }
  }
  const container = useRef<HTMLDivElement>(null);
  function updateDrag() {
    const current = drag.current;
    const element = container.current;
    if (!current?.moved || !element) return;
    current.target = Math.max(
      0,
      Math.min(
        pageCount - 1,
        Math.floor(
          (current.y - element.getBoundingClientRect().top + element.scrollTop) / ROW_HEIGHT,
        ),
      ),
    );
    setDragView({ page: current.page, target: current.target, x: current.x, y: current.y });
  }
  const dragging = dragView !== null;
  useEffect(() => {
    if (!dragging) return;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    let frame: number;
    let lastTime = 0;
    const tick = (time: number) => {
      const element = container.current;
      const current = drag.current;
      if (!element || !current) return;
      const bounds = element.getBoundingClientRect();
      const delta = Math.min(32, lastTime ? time - lastTime : 16);
      lastTime = time;
      const speed =
        current.y < bounds.top + 48
          ? -Math.min(1, (bounds.top + 48 - current.y) / 48)
          : current.y > bounds.bottom - 48
            ? Math.min(1, (current.y - bounds.bottom + 48) / 48)
            : 0;
      if (speed && bounds.height > 0) {
        element.scrollTop = Math.max(
          0,
          Math.min(pageCount * ROW_HEIGHT - bounds.height, element.scrollTop + speed * delta * 0.8),
        );
        setScrollTop(element.scrollTop);
        updateDrag();
      }
      frame = requestAnimationFrame(tick);
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finishDrag(true);
      }
    };
    const blur = () => finishDrag(true);
    frame = requestAnimationFrame(tick);
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", blur);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", blur);
    };
  }, [dragging, pageCount]);
  useEffect(() => {
    finishDrag(true);
  }, [fileId, revision, open, canEdit, pageCount]);
  const cache = useRef(new Map<number, { url: string; revision: number }>());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [images, setImages] = useState(new Map<number, string>());
  const [failed, setFailed] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const measuredHeight = useRef(600);
  const viewport = useRef({ first: 0, last: 0, open: open && !paused, revision });
  const pumping = useRef(false);
  const mounted = useRef(false);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 2);
  const last = Math.min(pageCount - 1, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 2);
  viewport.current = { first, last, open: open && !paused, revision };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      measuredHeight.current = element.clientHeight || 600;
      setHeight(measuredHeight.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element || !open) return;
    const top = selectedPage * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < element.scrollTop || bottom > element.scrollTop + measuredHeight.current) {
      element.scrollTop = Math.max(0, top - (measuredHeight.current - ROW_HEIGHT) / 2);
      setScrollTop(element.scrollTop);
    }
  }, [selectedPage, open]);

  useEffect(() => {
    if (!thumbnailChange || thumbnailChange.revision !== revision) return;
    const change = thumbnailChange;
    const remapped = new Map<number, { url: string; revision: number }>();
    for (const [index, entry] of cache.current) {
      if (entry.revision !== change.fromRevision) continue;
      if (
        (change.operation === "rotate" ||
          change.operation === "content" ||
          change.operation === "delete") &&
        index === change.page
      )
        continue;
      let target = index;
      if (change.operation === "move" && change.destination !== undefined) {
        if (index === change.page) target = change.destination;
        else if (
          change.page < change.destination &&
          index > change.page &&
          index <= change.destination
        )
          target--;
        else if (
          change.page > change.destination &&
          index >= change.destination &&
          index < change.page
        )
          target++;
      } else if (change.operation === "duplicate" && index > change.page) target++;
      else if (change.operation === "delete" && index > change.page) target--;
      const next = { ...entry, revision };
      remapped.set(target, next);
      if (change.operation === "duplicate" && index === change.page) remapped.set(index + 1, next);
    }
    cache.current = remapped;
    setImages((previous) => {
      const next = new Map([...remapped].map(([index, entry]) => [index, entry.url]));
      // Keep the old thumbnail visible until the changed page has been decoded.
      if (
        (change.operation === "rotate" || change.operation === "content") &&
        previous.has(change.page)
      )
        next.set(change.page, previous.get(change.page)!);
      return next;
    });
  }, [thumbnailChange, revision]);

  useEffect(() => {
    if (!open || paused || pumping.current) return;
    pumping.current = true;
    setFailed(null);
    // Keep one request in flight across scroll updates. Re-read the viewport after each result.
    void (async () => {
      try {
        while (mounted.current && viewport.current.open) {
          const { first, last, revision: requestedRevision } = viewport.current;
          const index = Array.from({ length: last - first + 1 }, (_, i) => first + i).find(
            (index) => cache.current.get(index)?.revision !== requestedRevision,
          );
          if (index === undefined) break;
          try {
            const result = await renderThumbnail(fileId, index, 300);
            if (typeof Image.prototype.decode === "function") {
              const image = new Image();
              image.src = result.imageUrl;
              await image.decode();
            }
            if (!mounted.current) return;
            if (viewport.current.revision !== requestedRevision) continue;
            cache.current.set(index, { url: result.imageUrl, revision: requestedRevision });
            while (cache.current.size > CACHE_LIMIT)
              cache.current.delete(cache.current.keys().next().value!);
            setImages(new Map([...cache.current].map(([index, value]) => [index, value.url])));
          } catch {
            if (mounted.current) setFailed(index);
            break;
          }
        }
      } finally {
        pumping.current = false;
      }
    })();
  }, [fileId, first, last, retry, open, revision, paused]);

  const rows = Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => first + offset);
  // Keep the captured source mounted while auto-scrolling a virtualized list.
  if (drag.current && !rows.includes(drag.current.page)) rows.push(drag.current.page);
  return (
    <aside
      id="page-sidebar"
      aria-label="페이지 목록"
      aria-hidden={!open}
      inert={!open}
      className={`sidebar-shell flex min-h-0 w-44 shrink-0 flex-col overflow-hidden border-r border-stone-200 bg-stone-100 transition-[margin-left] duration-250 ease-out sm:w-52 ${open ? "ml-0" : "-ml-44 sm:-ml-52"}`}
    >
      <div className="flex h-[73px] shrink-0 items-center gap-2 whitespace-nowrap border-b border-stone-200 px-4 text-sm font-semibold text-emerald-900">
        <img src={appIcon} alt="" className="size-6" />
        Paperkit
      </div>
      <p className="border-b border-stone-200 px-4 py-3 text-xs font-semibold text-stone-500">
        페이지 · {pageCount}
      </p>
      <div
        ref={container}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{ overflowAnchor: "none", scrollbarGutter: "stable" }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        tabIndex={0}
        aria-label="페이지 썸네일 스크롤"
      >
        <div className="relative" style={{ height: pageCount * ROW_HEIGHT }}>
          {rows.map((index) => (
            <div
              key={index}
              className="group absolute inset-x-0 px-3 py-2 transition-transform duration-200 ease-out motion-reduce:transition-none"
              data-page-row={index}
              style={{
                top: index * ROW_HEIGHT,
                height: ROW_HEIGHT,
                opacity: dragView?.page === index ? 0 : 1,
                transform: `translateY(${dragView && index !== dragView.page && index >= Math.min(dragView.page, dragView.target) && index <= Math.max(dragView.page, dragView.target) ? (dragView.target > dragView.page ? -ROW_HEIGHT : ROW_HEIGHT) : 0}px)`,
              }}
            >
              <Button
                variant="ghost"
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onSelect(index);
                }}
                onPointerDown={(event) => {
                  suppressClick.current = false;
                  if (!canEdit || event.button !== 0) return;
                  drag.current = {
                    page: index,
                    y: event.clientY,
                    x: event.clientX,
                    startY: event.clientY,
                    target: index,
                    moved: false,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const current = drag.current;
                  const viewport = container.current;
                  if (!current || !viewport || !canEdit) return;
                  if (
                    Math.hypot(event.clientY - current.startY, event.clientX - current.x) < 5 &&
                    !current.moved
                  )
                    return;
                  current.moved = true;
                  current.x = event.clientX;
                  current.y = event.clientY;
                  updateDrag();
                }}
                onPointerUp={() => finishDrag()}
                onPointerCancel={() => finishDrag(true)}
                onLostPointerCapture={() => finishDrag(true)}
                onKeyDown={(event) => {
                  if (!canEdit || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key))
                    return;
                  event.preventDefault();
                  const target = index + (event.key === "ArrowUp" ? -1 : 1);
                  if (target >= 0 && target < pageCount) onPageAction?.("move", index, target);
                }}
                title={canEdit ? "드래그하여 순서 변경 · Alt+↑/↓로 이동" : undefined}
                aria-label={`${index + 1}페이지로 이동`}
                aria-current={selectedPage === index ? "page" : undefined}
                className={`flex h-full w-full flex-col items-center rounded-lg border-2 p-2 focus-visible:outline-2 focus-visible:outline-emerald-700 ${canEdit ? "touch-none cursor-grab active:cursor-grabbing" : ""} ${selectedPage === index ? "border-emerald-700 bg-emerald-50" : "border-transparent hover:bg-stone-200"}`}
              >
                <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                  {images.has(index) ? (
                    <img
                      draggable={false}
                      src={images.get(index)}
                      alt={`${index + 1}페이지 썸네일`}
                      className="max-h-full max-w-full bg-white object-contain shadow-sm"
                    />
                  ) : (
                    <div className="grid h-full w-24 place-items-center rounded border border-stone-200 bg-white text-xs text-stone-400">
                      {failed === index ? "표시 실패" : "불러오는 중…"}
                    </div>
                  )}
                </div>
                <span className="mt-2 text-xs tabular-nums">{index + 1}</span>
              </Button>
              {editable && onPageAction && !dragging && (
                <div
                  role="group"
                  aria-label={`${index + 1}페이지 작업`}
                  className="pointer-events-none absolute bottom-0 left-1/2 z-10 flex -translate-x-1/2 divide-x divide-stone-200 rounded-md border border-stone-200 bg-white opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                >
                  <IconButton
                    label={`${index + 1}페이지 복제`}
                    icon={Copy}
                    disabled={!canEdit}
                    onClick={() => onPageAction("duplicate", index)}
                    className="h-7 w-8 rounded-none"
                  />
                  <IconButton
                    label={`${index + 1}페이지 회전`}
                    icon={RotateCw}
                    disabled={!canEdit}
                    onClick={() => onPageAction("rotate", index)}
                    className="h-7 w-8 rounded-none"
                  />
                  <IconButton
                    label={`${index + 1}페이지 삭제`}
                    icon={Trash2}
                    disabled={!canEdit || pageCount <= 1}
                    onClick={() => onPageAction("delete", index)}
                    className="h-7 w-8 rounded-none text-red-600"
                  />
                </div>
              )}
            </div>
          ))}
          {dragView && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-3 rounded-lg border-2 border-dashed border-emerald-500 bg-emerald-50/80"
              style={{ top: dropAt! * ROW_HEIGHT + 8, height: ROW_HEIGHT - 16 }}
            >
              <div className="absolute -inset-x-2 -top-2 h-1 rounded-full bg-emerald-600" />
              <div className="grid h-full place-items-center text-xs font-medium text-emerald-800">
                여기에 놓기 · {dragView.target + 1}번째
              </div>
            </div>
          )}
        </div>
      </div>
      <span role="status" className="sr-only">
        {dragView
          ? `${dragView.page + 1}페이지를 ${dragView.target + 1}번째 위치로 이동 · Esc로 취소`
          : ""}
      </span>
      {dragView &&
        createPortal(
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-40 w-28 rotate-3 rounded-lg border-2 border-emerald-600 bg-white p-2 shadow-2xl"
            style={{ left: dragView.x + 16, top: dragView.y - 44 }}
          >
            {images.has(dragView.page) && (
              <img
                src={images.get(dragView.page)}
                alt=""
                className="max-h-32 w-full object-contain"
              />
            )}
            <p className="mt-1 text-center text-xs font-semibold text-emerald-800">
              {dragView.page + 1}페이지 이동 중
            </p>
          </div>,
          document.body,
        )}
      {failed !== null && (
        <IconButton
          label="썸네일 다시 불러오기"
          icon={RotateCcw}
          onClick={() => setRetry((value) => value + 1)}
        />
      )}
    </aside>
  );
}
