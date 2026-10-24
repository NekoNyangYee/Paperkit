import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

// Animate document geometry and scrolling together; bitmap resolution is independent.
export function ZoomSurface({
  width,
  height,
  targetWidth,
  viewport,
  children,
}: {
  width: number;
  height: number;
  targetWidth: number;
  viewport: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [displayWidth, setDisplayWidth] = useState(targetWidth);
  const currentWidth = useRef(targetWidth);
  const surface = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const area = viewport.current;
    const node = surface.current;
    if (!area || !node || targetWidth === currentWidth.current) return;
    const view = area.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    anchor.current =
      box.width > 0 && box.height > 0
        ? {
            x: (view.left + area.clientWidth / 2 - box.left) / box.width,
            y: (view.top + area.clientHeight / 2 - box.top) / box.height,
          }
        : null;
    const from = currentWidth.current;
    let start: number | undefined;
    const duration = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200;
    let frame: number;
    const tick = (time: number) => {
      start ??= time;
      const progress = duration === 0 ? 1 : Math.min(1, (time - start) / duration);
      currentWidth.current = from + (targetWidth - from) * (1 - Math.pow(1 - progress, 3));
      setDisplayWidth(currentWidth.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [targetWidth, viewport]);
  useLayoutEffect(() => {
    const area = viewport.current;
    const node = surface.current;
    if (!area || !node || !anchor.current) return;
    const view = area.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    area.scrollLeft += box.left + box.width * anchor.current.x - view.left - area.clientWidth / 2;
    area.scrollTop += box.top + box.height * anchor.current.y - view.top - area.clientHeight / 2;
  }, [displayWidth, viewport]);
  return (
    <div
      ref={surface}
      className="mx-auto"
      style={{ width: displayWidth, height: (height * displayWidth) / width }}
    >
      <div
        data-pdf-zoom-surface
        style={{ width, transformOrigin: "top left", transform: `scale(${displayWidth / width})` }}
      >
        {children}
      </div>
    </div>
  );
}
