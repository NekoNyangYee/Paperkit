import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TextPage } from "./TextPage";
import type { PreviewPage, TextObject } from "@/shared/pdf/types";
import { groupSelection } from "@/shared/pdf/selection";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(): PreviewPage {
  const objects: TextObject[] = [0, 1].map((id) => ({
    id,
    text: id ? "둘째" : "첫째",
    font: "Helvetica",
    fontSize: 12,
    matrix: [1, 0, 0, 1, 10, 100 - id * 30],
    color: [0, 0, 0, 255],
    bounds: [
      [10, 100 - id * 30],
      [80, 100 - id * 30],
      [80, 112 - id * 30],
      [10, 112 - id * 30],
    ],
    screenBounds: [
      [10, 10 + id * 40],
      [80, 10 + id * 40],
      [80, 30 + id * 40],
      [10, 30 + id * 40],
    ],
    editBlocked: null,
    fontChangeBlocked: null,
  }));
  return {
    fileId: "test",
    pageIndex: 0,
    pageCount: 1,
    width: 800,
    height: 1000,
    imageUrl: "data:image/png;base64,AA==",
    state: { revision: 0, dirty: false, canUndo: false, canRedo: false },
    text: {
      warning: null,
      objects,
      groups: objects.map((o) => ({
        id: o.id,
        kind: "paragraph",
        canFlow: true,
        text: o.text,
        uncertain: false,
        editBlocked: null,
        runs: [{ object: o.id, start: 0, end: 2, objectStart: 0 }],
        bounds: [o.bounds],
        screenBounds: [o.screenBounds],
      })),
    },
  };
}
it("offers temporary merged editing after a rectangle selection and hover actions", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const capture = SVGElement.prototype.setPointerCapture;
  SVGElement.prototype.setPointerCapture = vi.fn();
  const begin = vi.fn(),
    remove = vi.fn();
  try {
    render(
      <TextPage
        page={fixture()}
        name="test"
        selected={null}
        disabled={false}
        editingEnabled
        mode="paragraph"
        draft=""
        onDraft={vi.fn()}
        onApply={vi.fn()}
        onSelect={vi.fn()}
        onComposition={vi.fn()}
        inlineEditing={false}
        onBeginEdit={begin}
        onMove={vi.fn()}
        onDelete={remove}
        blockSize={null}
        onResize={vi.fn()}
      />,
    );
    const first = screen.getByRole("button", { name: "블록 선택: 첫째" });
    fireEvent.mouseEnter(first);
    expect(screen.getByRole("button", { name: "블록 옮기기" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "블록 삭제" }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ text: "첫째" }));
    const area = screen.getByLabelText("텍스트 객체 선택");
    fireEvent.pointerDown(area, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(area, { clientX: 100, clientY: 90 });
    fireEvent.pointerUp(area, { clientX: 100, clientY: 90 });
    fireEvent.click(screen.getByRole("button", { name: "2개 블록 함께 편집" }));
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({ text: "첫째\n\n둘째", mergedGroups: [0, 1] }),
    );
    const selection = begin.mock.calls[0][0];
    expect(selection.group.runs[1].start).toBe(4);
  } finally {
    SVGElement.prototype.setPointerCapture = capture;
  }
});

function selectedProps() {
  const page = fixture();
  return {
    page,
    name: "test",
    selected: page.text.objects[0],
    disabled: false,
    editingEnabled: true,
    mode: "object" as const,
    draft: "첫째",
    onDraft: vi.fn(),
    onApply: vi.fn(),
    onSelect: vi.fn(),
    onComposition: vi.fn(),
    inlineEditing: false,
    onBeginEdit: vi.fn(),
    onMove: vi.fn(),
    onDelete: vi.fn(),
    blockSize: null,
    onResize: vi.fn(),
  };
}

it("shows and focuses the editor after background preparation with browser font support", async () => {
  vi.stubGlobal("FontFace", class {});
  mocks.invoke.mockReset().mockResolvedValue("data:image/png;base64,AA==");
  const props = selectedProps();
  render(<TextPage {...props} inlineEditing />);
  const input = await screen.findByRole("textbox", { name: "내용" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.getAttribute("contenteditable")).toBe("plaintext-only");
  expect(
    window.getSelection()?.anchorNode && input.contains(window.getSelection()!.anchorNode),
  ).toBeTruthy();
});

it("recognizes a double click across the text polygon and newly inserted selection overlay", () => {
  mocks.invoke.mockReset().mockResolvedValue("data:image/png;base64,AA==");
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  try {
    const props = selectedProps();
    const view = render(<TextPage {...props} selected={null} />);
    fireEvent.click(screen.getByRole("button", { name: "텍스트 선택: 첫째" }), {
      clientX: 20,
      clientY: 20,
    });
    expect(props.onSelect).toHaveBeenCalledWith(props.selected);
    view.rerender(<TextPage {...props} />);
    clock.mockReturnValue(1100);
    fireEvent.click(screen.getByRole("button", { name: "선택 블록 이동" }), {
      clientX: 20,
      clientY: 20,
    });
    expect(props.onBeginEdit).toHaveBeenCalledExactlyOnceWith(props.selected);
  } finally {
    clock.mockRestore();
  }
});

it("restores the original bitmap when a move is rejected without a busy-state transition", async () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
    },
  );
  const capture = HTMLElement.prototype.setPointerCapture;
  HTMLElement.prototype.setPointerCapture = vi.fn();
  mocks.invoke
    .mockReset()
    .mockImplementation(async (_command, args) =>
      args.foreground ? "data:image/png;base64,AA==" : "data:image/png;base64,AQ==",
    );
  const move = vi.fn(async () => false);
  try {
    const props = selectedProps();
    render(<TextPage {...props} onMove={move} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    const handle = screen.getByRole("button", { name: "선택 블록 이동" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 60, clientY: 60, pointerId: 1 });
    await screen.findByTestId("moving-text");
    fireEvent.pointerUp(handle, { clientX: 60, clientY: 60, pointerId: 1 });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("moving-text")).toBeNull());
    expect(screen.getByRole("img", { name: "test · 1페이지" }).getAttribute("src")).toBe(
      props.page.imageUrl,
    );
  } finally {
    HTMLElement.prototype.setPointerCapture = capture;
  }
});

it("reuses prepared layers when double clicking into editing", async () => {
  vi.stubGlobal("FontFace", class {});
  mocks.invoke.mockReset().mockResolvedValue("data:image/png;base64,AA==");
  const props = selectedProps();
  const view = render(<TextPage {...props} />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  view.rerender(<TextPage {...props} inlineEditing />);
  await waitFor(() => expect(screen.getByTestId("inline-block").style.visibility).toBe("visible"));
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it("moves downstream content locally as a paragraph grows and reuses layers while typing or resizing", async () => {
  vi.stubGlobal("FontFace", class {});
  let measure = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        measure = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    },
  );
  mocks.invoke
    .mockReset()
    .mockImplementation(async (_command, args) =>
      args.foreground ? "data:image/png;base64,AQ==" : "data:image/png;base64,AA==",
    );
  const props = selectedProps();
  const group = { ...props.page.text.groups![0], followingObjects: [1] };
  const selected = groupSelection(group, props.page.text.objects)!;
  const view = render(<TextPage {...props} selected={selected} mode="paragraph" inlineEditing />);
  await screen.findByTestId("flowing-content");
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(4));
  expect(mocks.invoke).toHaveBeenCalledWith(
    "editing_background",
    expect.objectContaining({
      objects: [0, 1],
    }),
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input.style.fontFamily).not.toBe("sans-serif"));
  Object.defineProperty(input, "scrollHeight", { configurable: true, value: 84 });
  act(() => measure());
  // Original one-row box is 28 px high; two added rows push the next block 56 px.
  expect(screen.getByTestId("flowing-content").style.transform).toBe("translateY(56px)");
  input.textContent = "입력 중인 문단";
  fireEvent.input(input);
  expect(props.onDraft).toHaveBeenCalledWith("입력 중인 문단");
  view.rerender(
    <TextPage
      {...props}
      selected={selected}
      mode="paragraph"
      inlineEditing
      draft="입력 중인 문단"
      blockSize={{ width: 30, height: 12 }}
    />,
  );
  act(() => measure());
  expect(screen.getByTestId("flowing-content").style.transform).toBe("translateY(56px)");
  expect(mocks.invoke).toHaveBeenCalledTimes(4);
  view.rerender(<TextPage {...props} selected={selected} mode="paragraph" />);
  expect(screen.queryByTestId("flowing-content")).toBeNull();
  expect(screen.getByRole("img", { name: "test · 1페이지" }).getAttribute("src")).toBe(
    props.page.imageUrl,
  );
});

it("shows the native failure and retries without losing the draft", async () => {
  vi.stubGlobal("FontFace", class {});
  mocks.invoke
    .mockReset()
    .mockRejectedValueOnce("다른 페이지를 처리하고 있습니다.")
    .mockResolvedValue("data:image/png;base64,AA==");
  render(<TextPage {...selectedProps()} inlineEditing draft="작성 중인 내용" />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "다른 페이지를 처리하고 있습니다.",
  );
  expect(screen.getByTestId("inline-block").style.visibility).toBe("hidden");
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(screen.getByTestId("inline-block").style.visibility).toBe("visible"));
  expect(screen.getByRole("textbox", { name: "내용" }).textContent).toBe("작성 중인 내용");
  expect(screen.getByRole("textbox", { name: "내용" }).className).toContain("select-text");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("hugs the growing text width, tracks its handles, and keeps manual widths fixed", async () => {
  vi.stubGlobal("FontFace", class {});
  let measure = (_width: number, _height: number) => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(element: HTMLElement) {
        measure = (width, height) =>
          this.callback(
            [
              {
                target: element,
                contentRect: new DOMRect(0, 0, width, height),
                borderBoxSize: [],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
              },
            ],
            this as unknown as ResizeObserver,
          );
      }
      constructor(private callback: ResizeObserverCallback) {}
      disconnect() {}
    },
  );
  mocks.invoke.mockReset().mockResolvedValue("data:image/png;base64,AA==");
  const props = selectedProps();
  const selected = groupSelection(props.page.text.groups![0], props.page.text.objects)!;
  const view = render(<TextPage {...props} selected={selected} mode="paragraph" inlineEditing />);
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(screen.getByTestId("inline-block").style.visibility).toBe("visible"));
  expect(input.style.width).toBe("max-content");
  expect(input.style.minWidth).toBe("70px");
  expect(input.style.maxWidth).toBe("790px");
  act(() => measure(220, 28));
  expect(screen.getByTestId("inline-block").style.width).toBe("220px");
  expect(screen.getByRole("button", { name: "블록 가로 조절" }).style.left).toBe("224px");
  const before = mocks.invoke.mock.calls.length;
  fireEvent.input(input, { target: { textContent: "가로로 더 길게 추가한 문장" } });
  expect(props.onDraft).toHaveBeenCalledWith("가로로 더 길게 추가한 문장");
  act(() => measure(500, 28));
  expect(screen.getByTestId("inline-block").style.width).toBe("500px");
  expect(mocks.invoke.mock.calls.length).toBe(before);
  view.rerender(
    <TextPage
      {...props}
      selected={selected}
      mode="paragraph"
      inlineEditing
      blockSize={{ width: 60, height: 12 }}
    />,
  );
  expect(input.style.width).toBe("100%");
  expect(input.style.maxWidth).toBe("");
  expect(screen.getByTestId("inline-block").style.width).toBe("100px");
  view.rerender(<TextPage {...props} selected={selected} mode="paragraph" inlineEditing />);
  expect(input.style.width).toBe("max-content");
  expect(input.textContent).toBe("가로로 더 길게 추가한 문장");
});

it("reports an invalid layer instead of waiting indefinitely", async () => {
  vi.stubGlobal("FontFace", class {});
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  render(<TextPage {...selectedProps()} inlineEditing />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "이미지 응답이 올바르지 않습니다.",
  );
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
});
vi.mock("@/shared/ui/MessageDialog", () => ({
  MessageDialog: ({ message, onRetry }: { message: string | null; onRetry?: () => void }) =>
    message ? (
      <div role="alert">
        {message}
        <button onClick={onRetry}>다시 시도</button>
      </div>
    ) : null,
}));
