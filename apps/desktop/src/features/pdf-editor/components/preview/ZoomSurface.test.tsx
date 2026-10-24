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
