import { useEffect, useRef, useState } from "react";
import { renderPage } from "../lib/preview";
import { RotateCcw } from "lucide-react";
import appIcon from "../../app-icon.svg";
import { IconButton } from "./ui/icon-button";

const ROW_HEIGHT = 196;
const CACHE_LIMIT = 64;

export function PageSidebar({
  fileId,
  pageCount,
  selectedPage,
  onSelect,
  open,
  revision = 0,
  paused = false,
}: {
  fileId: string;
  pageCount: number;
  selectedPage: number;
  onSelect: (page: number) => void;
  open: boolean;
  revision?: number;
  paused?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
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
            const result = await renderPage(fileId, index, 300);
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
              className="absolute inset-x-0 px-3 py-2"
              style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
            >
              <button
                onClick={() => onSelect(index)}
                aria-label={`${index + 1}페이지로 이동`}
                aria-current={selectedPage === index ? "page" : undefined}
                className={`flex h-full w-full flex-col items-center rounded-lg border-2 p-2 focus-visible:outline-2 focus-visible:outline-emerald-700 ${selectedPage === index ? "border-emerald-700 bg-emerald-50" : "border-transparent hover:bg-stone-200"}`}
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
              </button>
            </div>
          ))}
        </div>
      </div>
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
