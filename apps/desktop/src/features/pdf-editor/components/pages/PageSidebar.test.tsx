import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ renderPage: vi.fn() }));
vi.mock("@/shared/pdf/api", () => ({ renderThumbnail: mocks.renderPage }));
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

it("groups duplicate rotate and delete actions and disables them while editing is busy", async () => {
  mocks.renderPage.mockResolvedValue({ imageUrl: "data:image/png;base64,ONE" });
  const onPageAction = vi.fn();
  const view = render(
    <PageSidebar {...props} pageCount={2} editable onPageAction={onPageAction} />,
  );
  expect(screen.getByRole("group", { name: "1페이지 작업" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "1페이지 복제" }));
  fireEvent.click(screen.getByRole("button", { name: "2페이지 회전" }));
  fireEvent.click(screen.getByRole("button", { name: "1페이지 삭제" }));
  expect(onPageAction.mock.calls).toEqual([
    ["duplicate", 0],
    ["rotate", 1],
    ["delete", 0],
  ]);
  view.rerender(<PageSidebar {...props} pageCount={1} editable onPageAction={onPageAction} />);
  expect((screen.getByRole("button", { name: "1페이지 삭제" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  view.rerender(
    <PageSidebar {...props} pageCount={2} editable paused onPageAction={onPageAction} />,
  );
  expect((screen.getByRole("button", { name: "1페이지 복제" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("reorders pages by pointer drag and keyboard without triggering navigation", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  mocks.renderPage.mockResolvedValue({ imageUrl: "data:image/png;base64,ONE" });
  const onPageAction = vi.fn(),
    onSelect = vi.fn();
  render(
    <PageSidebar
      {...props}
      pageCount={3}
      editable
      onSelect={onSelect}
      onPageAction={onPageAction}
    />,
  );
  const first = screen.getByRole("button", { name: "1페이지로 이동" });
  fireEvent.pointerDown(first, { button: 0, clientY: 80 });
  fireEvent.pointerMove(first, { clientY: 410 });
  expect(screen.getByRole("status").textContent).toContain("1페이지를 3번째 위치로 이동");
  expect(screen.getByText("1페이지 이동 중")).toBeTruthy();
  expect(screen.getByText("여기에 놓기 · 3번째")).toBeTruthy();
  expect(first.parentElement?.style.opacity).toBe("0");
  expect(
    screen.getByRole("button", { name: "2페이지로 이동" }).parentElement?.style.transform,
  ).toBe("translateY(-196px)");
  fireEvent.pointerUp(first);
  expect(screen.queryByText("1페이지 이동 중")).toBeNull();
  fireEvent.click(first);
  expect(onPageAction).toHaveBeenCalledWith("move", 0, 2);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  expect(onPageAction).toHaveBeenCalledWith("move", 0, 1);
  onPageAction.mockClear();
  fireEvent.pointerDown(first, { button: 0, clientY: 80 });
  fireEvent.pointerMove(first, { clientY: 410 });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(first);
  expect(onPageAction).not.toHaveBeenCalled();
  expect(screen.queryByText("1페이지 이동 중")).toBeNull();
  expect(first.parentElement?.style.opacity).toBe("1");
  vi.unstubAllGlobals();
});

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

it("reuses moved thumbnails and only renders the rotated page", async () => {
  mocks.renderPage.mockImplementation(async (_file, page) => ({
    imageUrl: `data:image/png;base64,PAGE${page}`,
  }));
  const view = render(<PageSidebar {...props} pageCount={3} />);
  await waitFor(() => expect(screen.getByRole("img", { name: "3페이지 썸네일" })).toBeTruthy());
  mocks.renderPage.mockClear();
  view.rerender(
    <PageSidebar
      {...props}
      pageCount={3}
      revision={1}
      thumbnailChange={{ fromRevision: 0, revision: 1, operation: "move", page: 0, destination: 2 }}
    />,
  );
  expect(screen.getByRole("img", { name: "3페이지 썸네일" }).getAttribute("src")).toContain(
    "PAGE0",
  );
  expect(mocks.renderPage).not.toHaveBeenCalled();
  view.rerender(
    <PageSidebar
      {...props}
      pageCount={3}
      revision={2}
      thumbnailChange={{ fromRevision: 1, revision: 2, operation: "rotate", page: 1 }}
    />,
  );
  await waitFor(() => expect(mocks.renderPage).toHaveBeenCalledTimes(1));
  expect(mocks.renderPage.mock.calls[0][1]).toBe(1);
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
