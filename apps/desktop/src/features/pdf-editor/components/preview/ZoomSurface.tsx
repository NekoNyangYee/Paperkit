import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

export interface ZoomPoint {
  x: number;
  y: number;
}

// Animate document geometry and scrolling together; bitmap resolution is independent.
export function ZoomSurface({
  width,
  height,
  targetWidth,
  viewport,
  zoomPoint,
  children,
}: {
  width: number;
  height: number;
  targetWidth: number;
  viewport: RefObject<HTMLElement | null>;
  zoomPoint?: RefObject<ZoomPoint | null>;
  children: ReactNode;
}) {
  const initialWidth = useRef(targetWidth);
  const currentWidth = useRef(targetWidth);
  const surface = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  useLayoutEffect(() => {
    const area = viewport.current;
    const node = surface.current;
    if (!area || !node || !content.current) return;
    const paint = (value: number) => {
      node.style.width = `${value}px`;
      node.style.height = `${(height * value) / width}px`;
      content.current!.style.transform = `scale(${value / width})`;
      const fixed = anchor.current;
      if (!fixed) return;
      const box = node.getBoundingClientRect();
      area.scrollLeft += box.left + box.width * fixed.x - fixed.clientX;
      area.scrollTop += box.top + box.height * fixed.y - fixed.clientY;
    };
    if (targetWidth === currentWidth.current) {
      paint(currentWidth.current);
      return;
    }
    const view = area.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const clientX = zoomPoint?.current?.x ?? view.left + area.clientLeft + area.clientWidth / 2;
    const clientY = zoomPoint?.current?.y ?? view.top + area.clientTop + area.clientHeight / 2;
    anchor.current =
      box.width > 0 && box.height > 0
        ? {
            x: (clientX - box.left) / box.width,
            y: (clientY - box.top) / box.height,
            clientX,
            clientY,
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
      // Update two DOM nodes, without rendering the text/object tree every frame.
      paint(currentWidth.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [targetWidth, viewport, zoomPoint, width, height]);
  return (
    <div
      ref={surface}
      className="mx-auto"
      style={{ width: initialWidth.current, height: (height * initialWidth.current) / width }}
    >
      <div
        ref={content}
        data-pdf-zoom-surface
        style={{
          width,
          transformOrigin: "top left",
          transform: `scale(${initialWidth.current / width})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
