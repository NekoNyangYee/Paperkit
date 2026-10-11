import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ renderPage: vi.fn() }));
vi.mock("../lib/preview", () => ({ renderPage: mocks.renderPage }));
import { PageSidebar } from "./PageSidebar";

let resize: () => void;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  mocks.renderPage.mockReset();
});
afterEach(cleanup);
const props = { fileId: "one", pageCount: 100, selectedPage: 0, onSelect: vi.fn(), open: true };

it("keeps thumbnails and scroll position while refreshing a new revision", async () => {
  mocks.renderPage.mockResolvedValue({ imageUrl: "data:image/png;base64,OLD" });
  const view = render(<PageSidebar {...props} />);
  const scroll = screen.getByLabelText("페이지 썸네일 스크롤");
  fireEvent.scroll(scroll, { target: { scrollTop: 1960 } });
  const thumbnail = await screen.findByRole("img", { name: "11페이지 썸네일" });
  await waitFor(() => expect(screen.getByRole("img", { name: "16페이지 썸네일" })).toBeTruthy());
  let finish!: (value: { imageUrl: string }) => void;
  mocks.renderPage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  view.rerender(<PageSidebar {...props} revision={1} />);
  expect(screen.getByRole("img", { name: "11페이지 썸네일" })).toBe(thumbnail);
  expect(thumbnail.getAttribute("src")).toContain("OLD");
  expect(scroll.scrollTop).toBe(1960);
  // The first refreshed visible row is page 9; other old thumbnails remain visible.
  await act(async () => finish({ imageUrl: "data:image/png;base64,NEW" }));
  expect(screen.getByRole("img", { name: "9페이지 썸네일" }).getAttribute("src")).toContain("NEW");
  expect(thumbnail.getAttribute("src")).toContain("OLD");
  expect(scroll.scrollTop).toBe(1960);
});

it("keeps one request in flight during rapid scrolling and next loads the latest viewport", async () => {
  let resolve!: (page: { imageUrl: string }) => void;
  mocks.renderPage.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<PageSidebar {...props} />);
  const scroll = screen.getByLabelText("페이지 썸네일 스크롤");
  for (const index of [10, 25, 50, 80])
    fireEvent.scroll(scroll, { target: { scrollTop: index * 196 } });
  expect(mocks.renderPage).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ imageUrl: "data:image/png;base64,FIRST" }));
  expect(mocks.renderPage).toHaveBeenCalledTimes(2);
  expect(mocks.renderPage.mock.calls[1][1]).toBe(78);
  expect(scroll.scrollTop).toBe(80 * 196);
});

it("does not jump to the selected page when an error or resize changes the viewport height", async () => {
  let reject!: (cause: Error) => void;
  mocks.renderPage.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  render(<PageSidebar {...props} />);
  const scroll = screen.getByLabelText("페이지 썸네일 스크롤");
  fireEvent.scroll(scroll, { target: { scrollTop: 80 * 196 } });
  await act(async () => reject(new Error("Busy")));
  await screen.findByRole("button", { name: "썸네일 다시 불러오기" });
  Object.defineProperty(scroll, "clientHeight", { value: 550, configurable: true });
  act(() => resize());
  expect(scroll.scrollTop).toBe(80 * 196);
  expect(screen.getByRole("button", { name: "81페이지로 이동" })).toBeTruthy();
});

it("caches an in-flight result when collapsed and resumes on reopening", async () => {
  let resolve!: (page: { imageUrl: string }) => void;
  mocks.renderPage.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<PageSidebar {...props} />);
  view.rerender(<PageSidebar {...props} open={false} />);
  await act(async () => resolve({ imageUrl: "data:image/png;base64,FIRST" }));
  expect(mocks.renderPage).toHaveBeenCalledTimes(1);
  mocks.renderPage.mockResolvedValue({ imageUrl: "data:image/png;base64,NEXT" });
  view.rerender(<PageSidebar {...props} />);
  await waitFor(() => expect(mocks.renderPage.mock.calls.length).toBeGreaterThan(1));
  expect(mocks.renderPage.mock.calls.filter((call) => call[1] === 0)).toHaveLength(1);
});
