import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ZoomSurface } from "./ZoomSurface";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the viewport center anchored and does not animate again on bitmap replacement", () => {
  const area = document.createElement("section");
  Object.defineProperties(area, { clientWidth: { value: 600 }, clientHeight: { value: 500 } });
  area.scrollLeft = 100;
  area.scrollTop = 200;
  area.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  const viewport = { current: area };
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(performance, "now").mockReturnValue(0);
  const request = vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const view = render(
    <ZoomSurface width={800} height={1000} targetWidth={800} viewport={viewport}>
      <span>page</span>
    </ZoomSurface>,
  );
  const surface = view.container.firstElementChild as HTMLElement;
  surface.getBoundingClientRect = () =>
    ({
      left: -area.scrollLeft,
      top: -area.scrollTop,
      width: Number.parseFloat(surface.style.width),
      height: Number.parseFloat(surface.style.height),
    }) as DOMRect;
  view.rerender(
    <ZoomSurface width={800} height={1000} targetWidth={1200} viewport={viewport}>
      <span>page</span>
    </ZoomSurface>,
  );
  act(() => frame!(0));
  act(() => frame!(100));
  expect(Number.parseFloat(surface.style.width)).toBeGreaterThan(800);
  expect(Number.parseFloat(surface.style.width)).toBeLessThan(1200);
  act(() => frame!(200));
  expect(area.scrollLeft).toBeCloseTo(300);
  expect(area.scrollTop).toBeCloseTo(425);
  const calls = request.mock.calls.length;
  view.rerender(
    <ZoomSurface width={1200} height={1500} targetWidth={1200} viewport={viewport}>
      <span>new bitmap</span>
    </ZoomSurface>,
  );
  expect(request.mock.calls.length).toBe(calls);
  expect(area.scrollTop).toBeCloseTo(425);
  expect(surface.style.width).toBe("1200px");
});

function pointerSurface() {
  const area = document.createElement("section");
  Object.defineProperties(area, { clientWidth: { value: 600 }, clientHeight: { value: 500 } });
  area.scrollLeft = 100;
  area.scrollTop = 200;
  area.getBoundingClientRect = () => ({ left: 50, top: 80 }) as DOMRect;
  const viewport = { current: area };
  const zoomPoint = { current: { x: 250, y: 250 } as { x: number; y: number } | null };
  let frame: FrameRequestCallback;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const content = (targetWidth: number) => (
    <ZoomSurface
      width={800}
      height={1000}
      targetWidth={targetWidth}
      viewport={viewport}
      zoomPoint={zoomPoint}
    >
      <span>page</span>
    </ZoomSurface>
  );
  const view = render(content(800));
  const surface = view.container.firstElementChild as HTMLElement;
  surface.getBoundingClientRect = () =>
    ({
      left: 50 + 24 - area.scrollLeft,
      top: 80 + 24 - area.scrollTop,
      width: parseFloat(surface.style.width),
      height: parseFloat(surface.style.height),
    }) as DOMRect;
  const pointUnderCursor = () => {
    const box = surface.getBoundingClientRect();
    return {
      x: (zoomPoint.current!.x - box.left) / box.width,
      y: (zoomPoint.current!.y - box.top) / box.height,
    };
  };
  return {
    view,
    area,
    surface,
    zoomPoint,
    pointUnderCursor,
    zoom: (width: number) => view.rerender(content(width)),
    tick: (time: number) => act(() => frame(time)),
  };
}

it("keeps the document point under an off-center cursor fixed throughout zoom in and out", () => {
  const test = pointerSurface();
  const initial = test.pointUnderCursor();
  test.zoom(1200);
  for (const time of [0, 75, 150, 200]) {
    test.tick(time);
    expect(test.pointUnderCursor().x).toBeCloseTo(initial.x, 8);
    expect(test.pointUnderCursor().y).toBeCloseTo(initial.y, 8);
  }
  expect(test.area.scrollLeft).toBeCloseTo(238);
  expect(test.area.scrollTop).toBeCloseTo(373);
  test.zoom(800);
  for (const time of [250, 325, 400, 450]) {
    test.tick(time);
    expect(test.pointUnderCursor().x).toBeCloseTo(initial.x, 8);
    expect(test.pointUnderCursor().y).toBeCloseTo(initial.y, 8);
  }
  expect(test.area.scrollLeft).toBeCloseTo(100);
  expect(test.area.scrollTop).toBeCloseTo(200);
});

it("reanchors at the latest cursor when a new zoom interrupts an animation", () => {
  const test = pointerSurface();
  test.zoom(1200);
  test.tick(0);
  test.tick(75);
  test.zoomPoint.current = { x: 500, y: 450 };
  const next = test.pointUnderCursor();
  test.zoom(1600);
  for (const time of [80, 150, 280]) {
    test.tick(time);
    expect(test.pointUnderCursor().x).toBeCloseTo(next.x, 8);
    expect(test.pointUnderCursor().y).toBeCloseTo(next.y, 8);
  }
  expect(test.surface.style.width).toBe("1600px");
});

it("anchors immediately when reduced motion is enabled", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const test = pointerSurface();
  const initial = test.pointUnderCursor();
  test.zoom(1200);
  test.tick(0);
  expect(test.surface.style.width).toBe("1200px");
  expect(test.pointUnderCursor().x).toBeCloseTo(initial.x, 8);
  expect(test.pointUnderCursor().y).toBeCloseTo(initial.y, 8);
});
