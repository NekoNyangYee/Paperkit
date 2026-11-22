import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ZoomPoint } from "./ZoomSurface";

const clamp = (value: number) => Math.max(25, Math.min(400, value));

export function usePageZoom(
  viewport: RefObject<HTMLElement | null>,
  active: boolean,
  blocked: boolean,
  initial = 100,
  composing?: RefObject<boolean>,
) {
  const [zoom, setZoom] = useState(initial);
  const value = useRef(zoom);
  const zoomPoint = useRef<ZoomPoint | null>(null);
  useLayoutEffect(() => {
    value.current = zoom;
  }, [zoom]);

  const bindViewport = useCallback(
    (node: HTMLElement | null) => {
      viewport.current = node;
      if (!node) return;
      let frame: number | null = null;
      function wheel(event: WheelEvent) {
        if (!active || !event.ctrlKey || !Number.isFinite(event.deltaY) || !event.deltaY) return;
        event.preventDefault();
        if (blocked || composing?.current) return;
        zoomPoint.current = { x: event.clientX, y: event.clientY };
        // Pinch sends fractional Ctrl+wheel deltas, while a mouse wheel uses discrete steps.
        value.current = clamp(
          event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) < 80
            ? value.current * Math.exp(-event.deltaY / 100)
            : value.current + (event.deltaY < 0 ? 15 : -15),
        );
        if (frame === null)
          frame = requestAnimationFrame(() => {
            frame = null;
            setZoom(value.current);
          });
      }
      node.addEventListener("wheel", wheel, { passive: false });
      return () => {
        node.removeEventListener("wheel", wheel);
        if (frame !== null) cancelAnimationFrame(frame);
        viewport.current = null;
      };
    },
    [active, blocked, composing, viewport],
  );

  function zoomKey(key: string) {
    if (!["+", "=", "-", "0"].includes(key)) return false;
    zoomPoint.current = null;
    setZoom((current) => (key === "0" ? 100 : clamp(current + (key === "-" ? -15 : 15))));
    return true;
  }

  return { zoom, setZoom, zoomPoint, bindViewport, zoomKey };
}
