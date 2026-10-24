import { selectOption } from "@/test/controls";
import { within } from "@testing-library/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  save: vi.fn(),
  open: vi.fn(),
  onClose: vi.fn(),
  destroy: vi.fn(),
  fonts: vi.fn(),
  watermark: vi.fn(),
  watermarkSource: vi.fn(),
}));
// Domain tests stub the modal boundary; MessageDialog.test covers real focus/response behavior.
vi.mock("@/shared/ui/MessageDialog", () => ({
  useDiscardDialog: () => ({ confirm: mocks.confirm, dialog: null }),
  MessageDialog: ({ message, onRetry }: { message: string | null; onRetry?: () => void }) =>
    message ? (
      <div role="alert">
        {message}
        {onRetry && <button onClick={onRetry}>다시 시도</button>}
      </div>
    ) : null,
}));
vi.mock("@/shared/pdf/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/pdf/api")>()),
  listFonts: mocks.fonts,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
  Channel: class {
    onmessage = (_percent: number) => {};
  },
}));
vi.mock("@/features/pdf-editor/lib/stamps/watermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/pdf-editor/lib/stamps/watermark")>()),
  watermarkPng: mocks.watermark,
  watermarkSource: mocks.watermarkSource,
}));
vi.mock("@/features/pdf-editor/components/stamps/SignatureDialog", () => ({
  SignatureDialog: ({
    onApply,
    onClose,
  }: {
    onApply: (png: number[]) => Promise<boolean>;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="서명 입력">
      <button
        onClick={async () => {
          if (await onApply([7, 8, 9])) onClose();
        }}
      >
        서명 생성
      </button>
    </div>
  ),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: mocks.confirm,
  save: mocks.save,
  open: mocks.open,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onClose, destroy: mocks.destroy }),
}));
import { PdfPreview } from "./PdfPreview";
import { useFileStore } from "@/features/file-input/model/file-store";
import { rememberGraphic } from "@/features/pdf-editor/lib/graphics/graphic-clipboard";

const file = { id: "file-1", path: "C:\\example.pdf", name: "example.pdf", sizeBytes: 100 };
const page = (index = 0, width = 800) => ({
  fileId: file.id,
  pageIndex: index,
  pageCount: 2,
  width,
  height: width * 1.5,
  imageUrl: "data:image/png;base64,iVBORw0KGgo=",
  text: { objects: [], warning: null },
  state: { revision: 0, dirty: false, canUndo: false, canRedo: false },
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mocks.invoke.mockReset();
  mocks.watermarkSource.mockReset().mockResolvedValue({
    canvas: document.createElement("canvas"),
    url: "data:image/png;base64,V0FURVI=",
    width: 600,
    height: 200,
  });
  mocks.watermark.mockReset().mockResolvedValue({
    png: [1, 2, 3],
    url: "data:image/png;base64,V0FURVI=",
    width: 600,
    height: 200,
  });
  mocks.fonts.mockReset().mockResolvedValue([
    { id: "pretendard", name: "Pretendard" },
    { id: "nanum-gothic", name: "나눔고딕" },
  ]);
  mocks.confirm.mockReset().mockResolvedValue(false);
  mocks.save.mockReset().mockResolvedValue(null);
  mocks.open.mockReset().mockResolvedValue(null);
  mocks.onClose.mockReset().mockResolvedValue(() => {});
  mocks.destroy.mockReset().mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") return page(args.pageIndex, args.width);
    if (command === "clear_selection") return { revision: args.revision, file: null, error: null };
  });
  useFileStore.setState({ file, ready: true, phase: "selected", revision: 1, error: null });
});

const object = {
  id: 0,
  text: "Hello World",
  font: "Helvetica",
  fontSize: 16,
  color: [51, 77, 102, 255],
  matrix: [1, 0, 0, 1, 20, 220],
  bounds: [
    [20, 220],
    [100, 220],
    [100, 236],
    [20, 236],
  ],
  screenBounds: [
    [80, 320],
    [400, 320],
    [400, 256],
    [80, 256],
  ],
  editBlocked: null,
  fontChangeBlocked: null,
};

it("applies a watermark from the toolbar with the current revision and enables undo", async () => {
  let revision = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    const state = () => ({ revision, dirty: revision > 0, canUndo: revision > 0, canRedo: false });
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), state: state() };
    if (command === "edit_document") {
      revision++;
      return state();
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.click(screen.getByRole("button", { name: "워터마크" }));
  fireEvent.click(await screen.findByRole("switch", { name: "워터마크 사용" }));
  await screen.findByRole("img", { name: "워터마크 미리보기" });
  fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "addWatermark", page: null, png: [1, 2, 3], widthRatio: 0.6 },
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "실행 취소" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 1,
      action: { kind: "undo" },
    }),
  );
});

it("inserts a generated signature on the active page and keeps the dialog on failure", async () => {
  let failure = true;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") return page(args.pageIndex, args.width);
    if (command === "edit_document") {
      if (failure) throw new Error("서명 삽입 실패");
      return { revision: 1, dirty: true, canUndo: true, canRedo: false };
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "전자서명" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "전자서명" }));
  fireEvent.click(screen.getByRole("button", { name: "서명 생성" }));
  await screen.findByText("서명 삽입 실패");
  expect(screen.getByRole("dialog", { name: "서명 입력" })).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
    fileId: file.id,
    revision: 0,
    action: { kind: "addSignature", page: 1, png: [7, 8, 9] },
  });
  failure = false;
  fireEvent.click(screen.getByRole("button", { name: "서명 생성" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("opens the image file picker from the ribbon and can insert the same file again", async () => {
  let revision = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    const state = () => ({ revision, dirty: revision > 0, canUndo: revision > 0, canRedo: false });
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), state: state() };
    if (command === "edit_document") {
      revision++;
      return state();
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  const button = screen.getByRole("button", { name: "이미지 삽입" });
  expect(screen.getByLabelText("편집 도구").contains(button)).toBe(true);
  expect(
    screen
      .getByLabelText("편집 도구")
      .contains(screen.getByRole("button", { name: "이미지·도형 붙여넣기" })),
  ).toBe(true);
  const input = screen.getByLabelText("삽입할 이미지 파일") as HTMLInputElement;
  const picker = vi.spyOn(input, "click").mockImplementation(() => {});
  fireEvent.click(button);
  expect(picker).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { files: [] } });
  expect(mocks.invoke.mock.calls.some(([command]) => command === "edit_document")).toBe(false);
  const image = new File([new Uint8Array([1, 2, 3, 4])], "picture.png", { type: "image/png" });
  Object.defineProperty(image, "arrayBuffer", {
    value: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  });
  for (const expectedRevision of [0, 1]) {
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(input, { target: { files: [image] } });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
        fileId: file.id,
        revision: expectedRevision,
        action: { kind: "pasteImage", page: 0, png: [1, 2, 3, 4] },
      }),
    );
    expect(input.value).toBe("");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  }
});

it("reports image file read failures without modifying the PDF", async () => {
  render(<PdfPreview file={file} />);
  await enableEditing();
  const image = new File([], "broken.png", { type: "image/png" });
  Object.defineProperty(image, "arrayBuffer", {
    value: async () => {
      throw new Error("이미지 파일을 읽지 못했습니다.");
    },
  });
  fireEvent.change(screen.getByLabelText("삽입할 이미지 파일"), { target: { files: [image] } });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "이미지 파일을 읽지 못했습니다.",
  );
  expect(mocks.invoke.mock.calls.some(([command]) => command === "edit_document")).toBe(false);
  expect((screen.getByRole("button", { name: "이미지 삽입" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it("pastes copied PDF objects from the ribbon", async () => {
  const marker = rememberGraphic([37, 80, 68, 70]);
  vi.stubGlobal(
    "navigator",
    Object.create(navigator, {
      clipboard: {
        value: {
          read: vi
            .fn()
            .mockResolvedValue([
              { types: ["text/plain"], getType: async () => ({ text: async () => marker }) },
            ]),
        },
      },
    }),
  );
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") return page(args.pageIndex, args.width);
    if (command === "edit_document")
      return { revision: 1, dirty: true, canUndo: true, canRedo: false };
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.click(screen.getByRole("button", { name: "이미지·도형 붙여넣기" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "pasteGraphic", page: 0, source: [37, 80, 68, 70] },
    }),
  );
});

it("duplicates and deletes pages with the current revision and keeps undo navigation in range", async () => {
  let count = 2,
    revision = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    const state = () => ({
      revision,
      pageCount: count,
      dirty: revision > 0,
      canUndo: revision > 0,
      canRedo: false,
    });
    if (command === "render_selected_page")
      return {
        ...page(args.pageIndex, args.width),
        text: { objects: [object], warning: null },
        pageCount: count,
        state: state(),
      };
    if (command === "edit_document") {
      expect(args.revision).toBe(revision);
      if (args.action.kind === "undo") count++;
      else if (args.action.operation === "duplicate") count++;
      else if (args.action.operation === "delete") count--;
      revision++;
      return state();
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  expect(screen.queryByRole("combobox", { name: "선택 단위" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "2페이지 복제" }));
  await screen.findByRole("img", { name: "example.pdf · 3페이지" });
  expect(screen.getByLabelText("전체 3페이지")).toBeTruthy();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "3페이지 삭제" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "3페이지 삭제" }));
  await screen.findByRole("img", { name: "example.pdf · 2페이지" });
  expect(screen.getByLabelText("전체 2페이지")).toBeTruthy();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "실행 취소" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
  await screen.findByLabelText("전체 3페이지");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("separates bundled and installed fonts and sends the chosen installed face ID", async () => {
  mocks.fonts.mockResolvedValue([
    { id: "pretendard", name: "Pretendard", source: "bundled" },
    { id: "installed:MalgunGothic", name: "맑은 고딕", source: "installed" },
  ]);
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
    if (command === "editing_background") return "data:image/png;base64,AA==";
    if (command === "edit_document") throw "test stops before mutation";
  });
  render(<PdfPreview file={file} />);
  await enableEditing("object");
  fireEvent.click(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "글꼴" }), { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "맑은 고딕" }).closest('[role="group"]')).toBe(
    screen.getByRole("group", { name: "이 PC의 글꼴" }),
  );
  expect(screen.getByRole("option", { name: "Pretendard" }).closest('[role="group"]')).toBe(
    screen.getByRole("group", { name: "기본 제공 글꼴" }),
  );
  fireEvent.click(screen.getByRole("option", { name: "맑은 고딕" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "changeFont", page: 0, object: 0, font: "installed:MalgunGothic" },
    }),
  );
});

it("detects weight and applies the actual bold face from the toolbar", async () => {
  mocks.fonts.mockResolvedValue([
    { id: "pretendard", name: "Pretendard", postscriptNames: ["Pretendard-Regular"] },
    { id: "pretendard-bold", name: "Pretendard Bold", postscriptNames: ["Pretendard-Bold"] },
  ]);
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return {
        ...page(args.pageIndex, args.width),
        text: {
          objects: [{ ...object, font: "ABCDEF+Pretendard-Regular", fontWeight: 400 }],
          warning: null,
        },
      };
    if (command === "edit_document") throw "stop before mutation";
  });
  render(<PdfPreview file={file} />);
  await enableEditing("object");
  fireEvent.click(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  expect(screen.getByRole("button", { name: "굵게" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByLabelText("글자 크기").textContent).toBe("16 pt");
  expect(screen.queryByLabelText("편집 영역 안내")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "굵게" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "changeFont", page: 0, object: 0, font: "pretendard-bold" },
    }),
  );
});

it("selects on click, edits on double click and protects the draft from wheel rerenders", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
  });
  render(<PdfPreview file={file} />);
  await enableEditing("object");
  fireEvent.click(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull();
  fireEvent.doubleClick(screen.getByRole("button", { name: "선택 블록 이동" }));
  const input = await screen.findByRole("textbox", { name: "내용" });
  fireEvent.input(input, { target: { textContent: "Changed" } });
  fireEvent.wheel(screen.getByRole("region", { name: "PDF 페이지" }), {
    deltaY: -120,
    ctrlKey: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(input.textContent).toBe("Changed");
  expect(
    (screen.getByRole("combobox", { name: "확대 비율" }) as HTMLButtonElement).textContent,
  ).toBe("100%");
});

it("zooms with Ctrl wheel but leaves ordinary wheel for scrolling", async () => {
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  const area = screen.getByRole("region", { name: "PDF 페이지" });
  fireEvent.wheel(area, { deltaY: -120, ctrlKey: true });
  await waitFor(() =>
    expect(
      (screen.getByRole("combobox", { name: "확대 비율" }) as HTMLButtonElement).textContent,
    ).toBe("115%"),
  );
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  fireEvent.wheel(area, { deltaY: 120 });
  expect(
    (screen.getByRole("combobox", { name: "확대 비율" }) as HTMLButtonElement).textContent,
  ).toBe("115%");
});

it("accumulates rapid wheel input immediately and renders only the final zoom", async () => {
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  const area = screen.getByRole("region", { name: "PDF 페이지" });
  const select = screen.getByRole("combobox", { name: "확대 비율" }) as HTMLButtonElement;
  mocks.invoke.mockClear();
  for (let i = 0; i < 5; i++) fireEvent.wheel(area, { deltaY: -120, ctrlKey: true });
  expect(select.textContent).toBe("175%");
  for (let i = 0; i < 2; i++) fireEvent.wheel(area, { deltaY: 120, ctrlKey: true });
  expect(select.textContent).toBe("145%");
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("render_selected_page", {
      fileId: file.id,
      pageIndex: 0,
      width: 1160,
      onProgress: expect.any(Object),
    }),
  );
  const pageRenders = mocks.invoke.mock.calls.filter(
    ([command, args]) => command === "render_selected_page" && args.width !== 300,
  );
  expect(pageRenders).toHaveLength(1);
});

it.each([
  { zoom: 25, width: 300, delta: 120 },
  { zoom: 400, width: 1600, delta: -120 },
])("supports expanded zoom with bounded rendering: %j", async ({ zoom, width, delta }) => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), height: Math.min(2200, args.width * 1.5) };
  });
  render(<PdfPreview file={file} />);
  const select = screen.getByRole("combobox", { name: "확대 비율" }) as HTMLButtonElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  await selectOption(select, `${zoom}%`);
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("render_selected_page", {
      fileId: file.id,
      pageIndex: 0,
      width,
      onProgress: expect.any(Object),
    }),
  );
  await waitFor(() => expect(select.disabled).toBe(false));
  fireEvent.wheel(screen.getByRole("region", { name: "PDF 페이지" }), {
    ctrlKey: true,
    deltaY: delta,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(select.textContent).toBe(`${zoom}%`);
});

it("retains text tools at minimum wheel zoom without mistaking editor requests for thumbnails", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") {
      if (args.thumbnail || args.pageIndex === 1) return page(args.pageIndex, args.width);
      return groupedPage(args.pageIndex, args.width);
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  const area = screen.getByRole("region", { name: "PDF 페이지" });
  for (let i = 0; i < 8; i++) fireEvent.wheel(area, { ctrlKey: true, deltaY: 120 });
  expect(
    (screen.getByRole("combobox", { name: "확대 비율" }) as HTMLButtonElement).textContent,
  ).toBe("25%");
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "example.pdf · 1페이지" }).getAttribute("width")).toBe(
      "300",
    ),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("render_selected_page", {
    fileId: file.id,
    pageIndex: 0,
    width: 300,
    onProgress: expect.any(Object),
  });
  expect(mocks.invoke).toHaveBeenCalledWith("render_selected_page", {
    fileId: file.id,
    pageIndex: 0,
    width: 300,
    thumbnail: true,
  });
  expect(screen.queryByText(/선택 가능한 텍스트 객체가 없습니다/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "블록 선택: Hello World" }));
  expect(screen.getByRole("button", { name: "선택 블록 이동" })).toBeTruthy();
  fireEvent.wheel(area, { ctrlKey: true, deltaY: 120 });
  expect(screen.queryByText(/선택 가능한 텍스트 객체가 없습니다/)).toBeNull();
  // An actually empty page must still report its missing text rather than reuse page 1's tools.
  fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
  await screen.findByText(/선택 가능한 텍스트 객체가 없습니다/);
});

it("keeps the old page visible during zoom and replaces it after rendering", async () => {
  let finish: (value: ReturnType<typeof page>) => void = () => {};
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") {
      if (args.width === 920)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return page(args.pageIndex, args.width);
    }
  });
  render(<PdfPreview file={file} />);
  const original = await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  fireEvent.wheel(screen.getByRole("region", { name: "PDF 페이지" }), {
    ctrlKey: true,
    deltaY: -120,
  });
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "render_selected_page",
      expect.objectContaining({ width: 920 }),
    ),
  );
  expect(screen.getByRole("img", { name: "example.pdf · 1페이지" })).toBe(original);
  await waitFor(() =>
    expect(original.closest("[data-pdf-zoom-surface]")?.getAttribute("style")).toContain(
      "scale(1.15)",
    ),
  );
  await act(async () => finish(page(0, 920)));
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "example.pdf · 1페이지" }).getAttribute("width")).toBe(
      "920",
    ),
  );
});

function groupedPage(index: number, width: number, uncertain = false) {
  const objects = [
    { ...object, text: "Hello" },
    { ...object, id: 1, text: "World", font: "Helvetica-Bold" },
  ];
  const base = {
    text: "Hello World",
    uncertain,
    editBlocked: uncertain ? "열 또는 셀 경계가 불확실합니다. 객체 단위로 편집해 주세요." : null,
    runs: [
      { object: 0, start: 0, end: 5, objectStart: 0 },
      { object: 1, start: 6, end: 11, objectStart: 0 },
    ],
    bounds: [object.bounds],
    screenBounds: [object.screenBounds],
  };
  return {
    ...page(index, width),
    text: {
      objects,
      warning: null,
      groups: [
        { ...base, id: 0, kind: "paragraph" },
        { ...base, id: 1, kind: "sentence" },
      ],
    },
  };
}

it("prepares a shared original font once despite repeated double clicks and focuses the block", async () => {
  vi.stubGlobal(
    "FontFace",
    class {
      async load() {
        return this;
      }
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn() },
  });
  let finishFont!: (value: string) => void;
  const pendingFont = new Promise<string>((resolve) => {
    finishFont = resolve;
  });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") {
      const result = groupedPage(args.pageIndex, args.width);
      return {
        ...result,
        text: {
          ...result.text,
          objects: result.text.objects.map((o) => ({ ...o, font: "GulimChe", fontObjectId: 0 })),
        },
      };
    }
    if (command === "document_font") return pendingFont;
    if (command === "editing_background") return "data:image/png;base64,AA==";
  });
  render(<PdfPreview file={file} />);
  await enableEditing("paragraph");
  fireEvent.doubleClick(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
  fireEvent.doubleClick(screen.getByRole("button", { name: "선택 블록 이동" }));
  expect(await screen.findByText("원본 글꼴을 준비하고 있습니다…")).toBeTruthy();
  await act(async () => finishFont("AAECAw=="));
  const input = await screen.findByRole("textbox", { name: "내용" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "document_font")).toHaveLength(1);
  expect(input.textContent).toBe("Hello World");
});

it("shows dashed blocks before selection and explicitly converts a blocked block font", async () => {
  let revision = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") {
      const value = groupedPage(args.pageIndex, args.width);
      return {
        ...value,
        state: { revision, dirty: revision > 0, canUndo: revision > 0, canRedo: false },
        text: {
          ...value.text,
          objects: value.text.objects.map((o) => ({
            ...o,
            font: revision ? "Pretendard-Regular" : "UnknownFont",
            editBlocked: revision ? null : "원본 글꼴 편집 제한",
          })),
          groups: value.text.groups.map((g) => ({
            ...g,
            canChangeFont: true,
            canReflow: revision > 0,
            editBlocked: revision ? null : "원본 글꼴 편집 제한",
          })),
        },
      };
    }
    if (command === "edit_document") {
      revision++;
      return { revision, dirty: true, canUndo: true, canRedo: false };
    }
  });
  const view = render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  expect(view.container.querySelector("[data-editability]")).toBeNull();
  await enableEditing("paragraph");
  const block = await screen.findByRole("button", { name: "블록 선택: Hello World" });
  expect(block.getAttribute("stroke-dasharray")).toBe("5 4");
  expect(block.getAttribute("data-editability")).toBe("font-required");
  fireEvent.click(block, { altKey: true });
  expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull();
  const fonts = screen.getByRole("combobox", { name: "글꼴" }) as HTMLButtonElement;
  await waitFor(() => expect(fonts.disabled).toBe(false));
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "edit_document")).toHaveLength(0);
  await selectOption(fonts, "Pretendard");
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "changeBlockFont", page: 0, group: 0, font: "pretendard" },
    }),
  );
  await waitFor(() =>
    expect(
      within(screen.getByRole("combobox", { name: "글꼴" })).getByText("Pretendard-Regular"),
    ).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "내용 수정" }));
  expect((await screen.findByRole("textbox", { name: "내용" })).getAttribute("aria-readonly")).toBe(
    "false",
  );
});

it("selects without editing and sends a PDF-coordinate drag as one mutation", async () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  let revision = 0;
  let finishRefresh!: () => void;
  const refresh = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "editing_background")
      return args.foreground ? "data:image/png;base64,AA==" : "data:image/png;base64,AQ==";
    if (command === "render_selected_page") {
      if (revision > 0 && args.width === 800) await refresh;
      return {
        ...page(args.pageIndex, args.width),
        state: { revision, dirty: revision > 0, canUndo: revision > 0, canRedo: false },
        text: {
          objects: [{ ...object, matrix: [1, 0, 0, 1, 20 + revision * 10, 220 - revision * 5] }],
          warning: null,
        },
      };
    }
    if (command === "edit_document") {
      revision++;
      return { revision, dirty: true, canUndo: true, canRedo: false };
    }
  });
  try {
    render(<PdfPreview file={file} />);
    await enableEditing();
    fireEvent.click(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }), {
      altKey: true,
    });
    expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull();
    const handle = screen.getByRole("button", { name: "선택 블록 이동" });
    const area = screen.getByRole("region", { name: "PDF 페이지" });
    area.scrollTop = 280;
    const bitmap = screen.getByRole("img", { name: "example.pdf · 1페이지" });
    expect(bitmap.getAttribute("draggable")).toBe("false");
    expect(bitmap.parentElement?.className).toContain("select-none");
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 150, clientY: 280, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 190, clientY: 300, pointerId: 1 });
    await waitFor(() =>
      expect(screen.getByTestId("moving-text").style.transform).toBe("translate(40px, 20px)"),
    );
    expect(screen.getByLabelText("페이지 중앙 가이드")).toBeTruthy();
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "edit_document")).toHaveLength(0);
    fireEvent.pointerUp(handle, { clientX: 190, clientY: 300, pointerId: 1 });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
        fileId: file.id,
        revision: 0,
        action: { kind: "move", page: 0, object: 0, dx: 10, dy: -5 },
      }),
    );
    await waitFor(() => expect(area.getAttribute("aria-busy")).toBe("true"));
    expect(screen.getByRole("img", { name: "example.pdf · 1페이지" })).toBe(bitmap);
    expect(screen.getByTestId("moving-text").style.transform).toBe("translate(40px, 20px)");
    expect(screen.queryByText("PDF 페이지를 불러오고 있습니다…")).toBeNull();
    expect(area.scrollTop).toBe(280);
    await act(async () => finishRefresh());
    await waitFor(() => expect(area.getAttribute("aria-busy")).toBe("false"));
    expect(screen.queryByTestId("moving-text")).toBeNull();
    expect(area.scrollTop).toBe(280);
    await screen.findByRole("button", { name: "선택 블록 이동" });
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "edit_document")).toHaveLength(1);
  } finally {
    delete (HTMLElement.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture;
  }
});

it.each([false, true])(
  "resizes a flowing block and can restore automatic width (automatic=%s)",
  async (automatic) => {
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerId = 1;
      },
    );
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "render_selected_page") {
        const value = groupedPage(args.pageIndex, args.width);
        return {
          ...value,
          text: { ...value.text, groups: value.text.groups.map((g) => ({ ...g, canFlow: true })) },
        };
      }
      if (command === "edit_document")
        return { revision: 1, dirty: true, canUndo: true, canRedo: false };
    });
    try {
      render(<PdfPreview file={file} />);
      await enableEditing("paragraph");
      fireEvent.click(await screen.findByRole("button", { name: "블록 선택: Hello World" }), {
        altKey: true,
      });
      const handle = screen.getByRole("button", { name: "블록 크기 조절" });
      fireEvent.pointerDown(handle, { clientX: 400, clientY: 320, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 480, clientY: 400, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 480, clientY: 400, pointerId: 1 });
      fireEvent.click(screen.getByRole("button", { name: "텍스트 상세 설정" }));
      expect(
        screen.getByRole("button", { name: "너비 자동 확장" }).getAttribute("aria-pressed"),
      ).toBe("false");
      if (automatic) {
        fireEvent.click(screen.getByRole("button", { name: "너비 자동 확장" }));
        fireEvent.click(
          within(await screen.findByRole("alertdialog", { name: "텍스트 너비 초기화" })).getByRole(
            "button",
            { name: "초기화" },
          ),
        );
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "텍스트 상세 설정" }));
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "너비 자동 확장" }).getAttribute("aria-pressed"),
          ).toBe("true"),
        );
        expect(
          screen.getByRole("button", { name: "너비 자동 확장" }).getAttribute("aria-pressed"),
        ).toBe("true");
      }
      fireEvent.click(screen.getByRole("button", { name: "내용 수정" }));
      await screen.findByTestId("inline-block");
      if (!automatic) expect(screen.getByTestId("inline-block").style.width).toBe("400px");
      const value = "A much longer paragraph that wraps and keeps growing beyond the old line.";
      fireEvent.input(screen.getByRole("textbox", { name: "내용" }), {
        target: { textContent: value },
      });
      fireEvent.keyDown(screen.getByRole("textbox", { name: "내용" }), { key: "Enter" });
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
          fileId: file.id,
          revision: 0,
          action: {
            kind: "flowBlock",
            page: 0,
            group: 0,
            text: value,
            ...(automatic ? {} : { width: 100, height: 36 }),
          },
        }),
      );
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull());
    } finally {
      delete (HTMLElement.prototype as unknown as { setPointerCapture?: unknown })
        .setPointerCapture;
    }
  },
);

it.each([false, true])(
  "validates shared fonts once for text edits and skips font checks for resize only (edit=%s)",
  async (editText) => {
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerId = 1;
      },
    );
    const capture = HTMLElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = vi.fn();
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "render_selected_page") {
        const value = groupedPage(args.pageIndex, args.width);
        return {
          ...value,
          text: {
            ...value.text,
            objects: value.text.objects.map((o) => ({ ...o, font: "Gulim", fontObjectId: 0 })),
            groups: value.text.groups.map((g) => ({ ...g, canFlow: true })),
          },
        };
      }
      if (command === "document_font") return "AA==";
      if (command === "editing_background") return "data:image/png;base64,AA==";
      if (command === "edit_document")
        return { revision: 1, dirty: true, canUndo: true, canRedo: false };
    });
    try {
      render(<PdfPreview file={file} />);
      await enableEditing();
      fireEvent.click(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
      const handle = screen.getByRole("button", { name: "블록 가로 조절" });
      fireEvent.pointerDown(handle, { clientX: 400, clientY: 300 });
      fireEvent.pointerMove(handle, { clientX: 480, clientY: 300 });
      fireEvent.pointerUp(handle);
      const value = editText ? "Hello inserted World" : "Hello World";
      if (editText) {
        fireEvent.click(screen.getByRole("button", { name: "내용 수정" }));
        const input = await screen.findByRole("textbox", { name: "내용" });
        fireEvent.input(input, { target: { textContent: value } });
        fireEvent.keyDown(input, { key: "Enter" });
      } else fireEvent.click(screen.getByRole("button", { name: "적용" }));
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
          fileId: file.id,
          revision: 0,
          action: { kind: "flowBlock", page: 0, group: 0, text: value, width: 100, height: 16 },
        }),
      );
      const validation = mocks.invoke.mock.calls.filter(
        ([command, args]) => command === "document_font" && args.validateOnly,
      );
      expect(validation).toHaveLength(editText ? 1 : 0);
      if (editText)
        expect(validation[0][1]).toEqual({
          fileId: file.id,
          revision: 0,
          pageIndex: 0,
          objectId: 0,
          text: value,
          validateOnly: true,
        });
    } finally {
      HTMLElement.prototype.setPointerCapture = capture;
    }
  },
);

it("stretches text horizontally and vertically without requiring another font", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
    if (command === "edit_document")
      return { revision: 1, dirty: true, canUndo: true, canRedo: false };
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.click(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  fireEvent.click(screen.getByRole("button", { name: "텍스트 상세 설정" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "텍스트 가로" }), {
    target: { value: "160" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "텍스트 세로" }), {
    target: { value: "24" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "텍스트 크기" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "scaleText", page: 0, objects: [0], sx: 2, sy: 1.5 },
    }),
  );
  expect(mocks.invoke.mock.calls.some(([command]) => command === "document_font")).toBe(false);
});

it("changes the font with a resized block in one transaction", async () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") {
      const value = groupedPage(args.pageIndex, args.width);
      return {
        ...value,
        text: {
          ...value.text,
          groups: value.text.groups.map((g) => ({ ...g, canFlow: true, canChangeFont: true })),
        },
      };
    }
    if (command === "edit_document")
      return { revision: 1, dirty: true, canUndo: true, canRedo: false };
  });
  try {
    render(<PdfPreview file={file} />);
    await enableEditing("paragraph");
    fireEvent.click(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
    const handle = screen.getByRole("button", { name: "블록 크기 조절" });
    fireEvent.pointerDown(handle, { clientX: 400, clientY: 320, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 480, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    const select = screen.getByRole("combobox", { name: "글꼴" }) as HTMLButtonElement;
    expect(select.disabled).toBe(false);
    await selectOption(select, "Pretendard");
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
        fileId: file.id,
        revision: 0,
        action: {
          kind: "changeBlockFont",
          page: 0,
          group: 0,
          font: "pretendard",
          text: "Hello World",
          width: 100,
          height: 36,
        },
      }),
    );
  } finally {
    delete (HTMLElement.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture;
  }
});

it("edits over the original non-text background without a white input panel", async () => {
  vi.stubGlobal("FontFace", class {});
  const background = "data:image/png;base64,YmFja2dyb3VuZA==";
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") {
      const value = groupedPage(args.pageIndex, args.width);
      return {
        ...value,
        text: { ...value.text, groups: value.text.groups.map((g) => ({ ...g, canFlow: true })) },
      };
    }
    if (command === "editing_background") return background;
  });
  try {
    render(<PdfPreview file={file} />);
    await enableEditing("paragraph");
    fireEvent.doubleClick(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "example.pdf · 1페이지" }).getAttribute("src")).toBe(
        background,
      ),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("editing_background", {
      fileId: file.id,
      revision: 0,
      pageIndex: 0,
      width: 800,
      objects: [0, 1],
    });
    const editor = screen.getByTestId("inline-block");
    expect(editor.className).toContain("bg-transparent");
    expect(editor.style.backgroundColor).not.toBe("white");
    expect(screen.getByRole("textbox", { name: "내용" }).getAttribute("aria-readonly")).toBe(
      "false",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("edits a whole block in place, preserves the DOM during IME and saves after committing the latest revision", async () => {
  let revision = 0;
  mocks.save.mockResolvedValue("C:\\block-edited.pdf");
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") {
      const value = groupedPage(args.pageIndex, args.width);
      value.text.groups[0] = {
        ...value.text.groups[0],
        canReflow: true,
      } as (typeof value.text.groups)[0];
      return {
        ...value,
        state: { revision, dirty: revision > 0, canUndo: revision > 0, canRedo: false },
      };
    }
    if (command === "edit_document") {
      if (args.action.kind !== "save") revision++;
      return { revision, dirty: args.action.kind !== "save", canUndo: true, canRedo: false };
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing("paragraph");
  fireEvent.doubleClick(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
  const editor = await screen.findByRole("textbox", { name: "내용" });
  expect(editor.tagName).toBe("DIV");
  expect(editor.getAttribute("contenteditable")).toBe("plaintext-only");
  expect(screen.getByTestId("inline-block").querySelector("button")).toBeNull();
  fireEvent.compositionStart(editor);
  fireEvent.input(editor, { target: { textContent: "한" } });
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
  expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "edit_document")).toHaveLength(0);
  expect(await screen.findByRole("textbox", { name: "내용" })).toBe(editor);
  fireEvent.compositionEnd(editor);
  fireEvent.input(editor, { target: { textContent: "New\ntext" } });
  fireEvent.click(screen.getByRole("button", { name: "새 PDF로 저장" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "reflowBlock", page: 0, group: 0, text: "New\ntext" },
    }),
  );
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 1,
      action: { kind: "save", path: "C:\\block-edited.pdf" },
    }),
  );
});

it("does not open a save dialog or discard inline input when block commit fails", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") return groupedPage(args.pageIndex, args.width);
    if (command === "edit_document") throw "블록 범위를 벗어납니다.";
  });
  render(<PdfPreview file={file} />);
  await enableEditing("paragraph");
  fireEvent.doubleClick(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
  const editor = await screen.findByRole("textbox", { name: "내용" });
  fireEvent.input(editor, { target: { textContent: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "새 PDF로 저장" }));
  await screen.findByText("블록 범위를 벗어납니다.");
  expect(mocks.save).not.toHaveBeenCalled();
  expect(editor.textContent).toBe("Keep this draft");
  expect(await screen.findByRole("textbox", { name: "내용" })).toBe(editor);
});

it("places the caret at the clicked character and does not replace text nodes on draft updates", async () => {
  const caret = vi.fn(() => ({
    offsetNode: screen.getByRole("textbox", { name: "내용" }).firstChild!,
    offset: 3,
  }));
  Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: caret });
  try {
    mocks.invoke.mockImplementation(async (command, args) =>
      command === "render_selected_page"
        ? { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } }
        : undefined,
    );
    render(<PdfPreview file={file} />);
    await enableEditing();
    fireEvent.doubleClick(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }), {
      clientX: 130,
      clientY: 270,
    });
    const editor = await screen.findByRole("textbox", { name: "내용" });
    await waitFor(() => expect(caret).toHaveBeenCalledWith(130, 270));
    expect(window.getSelection()?.focusOffset).toBe(3);
    const node = editor.firstChild!;
    node.textContent = "Hallo World";
    fireEvent.input(editor);
    expect(editor.firstChild).toBe(node);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "edit_document")).toBe(false);
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "edit_document")).toBe(false);
  } finally {
    Reflect.deleteProperty(document, "caretPositionFromPoint");
  }
});

it("commits before selecting another block and resolves its new ID after rendering", async () => {
  let revision = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return {
        ...page(args.pageIndex, args.width),
        state: { revision, dirty: revision > 0, canUndo: revision > 0, canRedo: false },
        text: {
          warning: null,
          objects: [
            { ...object, text: revision ? "Hello" : "Hello World" },
            { ...object, id: revision ? 7 : 1, text: "Second", matrix: [1, 0, 0, 1, 20, 100] },
          ],
        },
      };
    if (command === "edit_document") {
      revision++;
      return { revision, dirty: true, canUndo: true, canRedo: false };
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  fireEvent.input(await screen.findByRole("textbox", { name: "내용" }), {
    target: { textContent: "Hello" },
  });
  fireEvent.doubleClick(screen.getByRole("button", { name: "텍스트 선택: Second" }));
  await waitFor(async () =>
    expect((await screen.findByRole("textbox", { name: "내용" })).textContent).toBe("Second"),
  );
  fireEvent.input(await screen.findByRole("textbox", { name: "내용" }), {
    target: { textContent: "Next" },
  });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 1,
      action: { kind: "replace", page: 0, object: 7, text: "Next" },
    }),
  );
  expect(mocks.confirm).not.toHaveBeenCalled();
});

it("selects a reconstructed sentence and submits one revision-scoped transaction, showing mixed fonts", async () => {
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "render_selected_page"
      ? groupedPage(args.pageIndex, args.width)
      : command === "edit_document"
        ? { revision: 1, dirty: true, canUndo: true, canRedo: false }
        : undefined,
  );
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
  expect(within(screen.getByRole("combobox", { name: "글꼴" })).getByText("혼합")).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "글꼴" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.input(await screen.findByRole("textbox", { name: "내용" }), {
    target: { textContent: "Hallo World" },
  });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "replaceGroup", page: 0, group: 0, text: "Hallo World" },
    }),
  );
});

it("keeps rejected block input with no selection mode switch", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page") return groupedPage(args.pageIndex, args.width);
    if (command === "edit_document") throw "글자 수와 공백 위치를 유지해야 합니다.";
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
  fireEvent.input(await screen.findByRole("textbox", { name: "내용" }), {
    target: { textContent: "Short" },
  });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await screen.findByText("글자 수와 공백 위치를 유지해야 합니다.");
  expect((await screen.findByRole("textbox", { name: "내용" })).textContent).toBe("Short");
  expect(screen.queryByRole("combobox", { name: "선택 단위" })).toBeNull();
  expect(screen.queryByRole("button", { name: "텍스트 선택: Hello" })).toBeNull();
});

it("marks uncertain groups read-only while retaining explicit object selection", async () => {
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "render_selected_page" ? groupedPage(args.pageIndex, args.width, true) : undefined,
  );
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
  expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull();
  expect(screen.getByText(/열 또는 셀 경계가 불확실/, { selector: "span" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "적용" }) as HTMLButtonElement).disabled).toBe(true);
});

it("switches from text selection to recognized graphics without a text hit layer", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return {
        ...groupedPage(args.pageIndex, args.width),
        text: {
          ...groupedPage(args.pageIndex, args.width).text,
          graphics: [
            { id: 9, kind: "image", bounds: object.bounds, screenBounds: object.screenBounds },
          ],
        },
      };
  });
  render(<PdfPreview file={file} />);
  await enableEditing("graphic");
  const image = await screen.findByRole("button", { name: "이미지 10 선택" });
  expect(screen.getByLabelText("텍스트 객체 선택")).toBeTruthy();
  fireEvent.click(image);
  expect(image.getAttribute("aria-pressed")).toBe("true");
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "edit_document")).toHaveLength(
    0,
  );
});

async function enableEditing(_mode?: string) {
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "편집 사용" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "편집 사용" }));
}

it.each([
  { dirty: true, pick: null, discard: false, replaced: false, confirms: 0 },
  { dirty: true, pick: "C:\\next.pdf", discard: false, replaced: false, confirms: 1 },
  { dirty: true, pick: "C:\\next.pdf", discard: true, replaced: true, confirms: 1 },
  { dirty: false, pick: "C:\\next.pdf", discard: false, replaced: true, confirms: 0 },
])("opens a replacement in place: %j", async ({ dirty, pick, discard, replaced, confirms }) => {
  const next = { ...file, id: "next-file", path: "C:\\next.pdf", name: "next.pdf" };
  useFileStore.setState({ openedFileId: file.id });
  mocks.open.mockResolvedValue(pick);
  mocks.confirm.mockResolvedValue(discard);
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return {
        ...page(args.pageIndex, args.width),
        state: { revision: 0, dirty, canUndo: dirty, canRedo: false },
      };
    if (command === "receive_file_input")
      return { revision: args.revision, file: next, error: null };
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  const snapshots: (string | null)[] = [];
  const unsubscribe = useFileStore.subscribe((state) => snapshots.push(state.openedFileId));
  fireEvent.click(screen.getByRole("button", { name: "다른 파일 열기" }));
  await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "다른 파일 열기" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(mocks.confirm).toHaveBeenCalledTimes(confirms);
  expect(useFileStore.getState().file?.id).toBe(replaced ? next.id : file.id);
  expect(useFileStore.getState().openedFileId).toBe(replaced ? next.id : file.id);
  expect(snapshots).not.toContain(null);
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "clear_selection")).toBe(false);
  unsubscribe();
});

it("opens read-only, blocks editing shortcuts, and enables an input at the text position", async () => {
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "render_selected_page"
      ? { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } }
      : undefined,
  );
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  expect(screen.getByRole("note").textContent).toContain("원본을 보호하고 있습니다.");
  expect(screen.queryByRole("button", { name: "텍스트 선택: Hello World" })).toBeNull();
  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "edit_document")).toBe(false);
  await enableEditing();
  fireEvent.doubleClick(screen.getByRole("button", { name: "텍스트 선택: Hello World" }));
  const input = await screen.findByRole("textbox", { name: "내용" });
  expect(document.activeElement).toBe(input);
  expect(input.parentElement?.style.left).toBe("80px");
  expect(input.parentElement?.style.top).toBe("256px");
  fireEvent.input(input, { target: { textContent: "Hello" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "edit_document")).toBe(false);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(await screen.findByRole("textbox", { name: "내용" })).toBe(input);
});

it("selects a real object, applies an edit with its revision and refreshes page and thumbnails", async () => {
  let revision = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return {
        ...page(args.pageIndex, args.width),
        state: { revision, dirty: revision > 0, canUndo: revision > 0, canRedo: false },
        text: {
          objects: [{ ...object, text: revision ? "Hello PDF" : "Hello World" }],
          warning: null,
        },
      };
    if (command === "edit_document") {
      revision++;
      return { revision, dirty: true, canUndo: true, canRedo: false };
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  expect(screen.queryByRole("complementary", { name: "텍스트 속성" })).toBeNull();
  expect(
    screen
      .getByLabelText("PDF 페이지")
      .contains(await screen.findByRole("textbox", { name: "내용" })),
  ).toBe(true);
  fireEvent.input(await screen.findByRole("textbox", { name: "내용" }), {
    target: { textContent: "Hello PDF" },
  });
  expect(
    (screen.getByRole("button", { name: "새 PDF로 저장" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await screen.findByRole("button", { name: "텍스트 선택: Hello PDF" });
  expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
    fileId: file.id,
    revision: 0,
    action: { kind: "replace", page: 0, object: 0, text: "Hello PDF" },
  });
  expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull();
  expect(screen.getByText("저장하지 않은 변경 있음")).toBeTruthy();
  expect(
    mocks.invoke.mock.calls.filter(
      ([command, args]) =>
        command === "render_selected_page" && args.width === 300 && args.pageIndex === 0,
    ).length,
  ).toBeGreaterThanOrEqual(2);
});

it("keeps input on rejected edits and requires confirmation before discarding a draft", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "editing_background") return "data:image/png;base64,AA==";
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
    if (command === "edit_document") throw "새 텍스트가 기존 영역을 벗어납니다.";
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  fireEvent.input(await screen.findByRole("textbox", { name: "내용" }), {
    target: { textContent: "Too long" },
  });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect((await screen.findByRole("alert")).textContent).toContain("영역");
  expect((await screen.findByRole("textbox", { name: "내용" })).textContent).toBe("Too long");
  fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
  await waitFor(() =>
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "edit_document")).toHaveLength(2),
  );
  expect(mocks.confirm).not.toHaveBeenCalled();
  await waitFor(async () =>
    expect(
      (await screen.findByRole("textbox", { name: "내용" })).getAttribute("aria-disabled"),
    ).toBe("false"),
  );
  expect(screen.getByText("1 / 2")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  await waitFor(async () =>
    expect(
      (await screen.findByRole("textbox", { name: "내용" })).getAttribute("aria-disabled"),
    ).toBe("false"),
  );
  expect(await screen.findByRole("textbox", { name: "내용" })).toBeTruthy();
  mocks.confirm.mockResolvedValueOnce(true);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull());
});

it("does not silently substitute an unavailable original font", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return {
        ...page(args.pageIndex, args.width),
        text: { objects: [{ ...object, editBlocked: "Original unavailable" }], warning: null },
      };
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: /Hello World/ }));
  expect(await screen.findByText("Original unavailable")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull();
  expect(
    mocks.invoke.mock.calls.some(
      ([command]) => command === "editor_font" || command === "edit_document",
    ),
  ).toBe(false);
});

it("retries original font recovery instead of blocking solely on an earlier font warning", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return {
        ...page(args.pageIndex, args.width),
        text: {
          objects: [{ ...object, editBlocked: "Original font needs recovery" }],
          warning: null,
        },
      };
    if (command === "document_font") return "AA==";
    if (command === "editing_background") return "data:image/png;base64,AA==";
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  const input = await screen.findByRole("textbox", { name: "내용" });
  expect(input.getAttribute("contenteditable")).toBe("plaintext-only");
  expect(mocks.invoke).toHaveBeenCalledWith("document_font", {
    fileId: file.id,
    revision: 0,
    pageIndex: 0,
    objectId: 0,
    text: "Hello World",
    validateOnly: true,
  });
  expect(mocks.invoke.mock.calls.some(([command]) => command === "editor_font")).toBe(false);
});

it("preserves an unsupported block when explicit font replacement fails", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "editing_background") return "data:image/png;base64,AA==";
    if (command === "render_selected_page") {
      const value = groupedPage(args.pageIndex, args.width);
      return {
        ...value,
        text: {
          ...value.text,
          groups: value.text.groups.map((g) => ({
            ...g,
            canChangeFont: true,
            editBlocked: "원본 글꼴 미지원",
          })),
        },
      };
    }
    if (command === "edit_document") throw "블록 범위를 벗어납니다.";
  });
  render(<PdfPreview file={file} />);
  await enableEditing("paragraph");
  fireEvent.doubleClick(await screen.findByRole("button", { name: "블록 선택: Hello World" }));
  await screen.findByRole("textbox", { name: "내용" });
  await selectOption(screen.getByRole("combobox", { name: "글꼴" }), "Pretendard");
  await screen.findByText("블록 범위를 벗어납니다.");
  expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
    fileId: file.id,
    revision: 0,
    action: { kind: "changeBlockFont", page: 0, group: 0, font: "pretendard" },
  });
  expect(screen.getByRole("textbox", { name: "내용" })).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("retains the draft when the original font lacks new glyphs, then imports the exact face", async () => {
  let imported = false;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
    if (command === "document_font") {
      if (!imported) throw "원본 글꼴에 입력한 문자가 없습니다. 입력 내용은 유지했습니다.";
      return "AA==";
    }
    if (command === "import_original_font") {
      imported = true;
      return ["Helvetica"];
    }
    if (command === "edit_document")
      return { revision: 1, dirty: true, canUndo: true, canRedo: false };
  });
  render(<PdfPreview file={file} />);
  await enableEditing("object");
  fireEvent.doubleClick(await screen.findByRole("button", { name: /Hello World/ }));
  const input = await screen.findByRole("textbox", { name: "내용" });
  const value = "Hello \uD55C\uAE00";
  fireEvent.input(input, { target: { textContent: value } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("dialog", { name: "반영할 글꼴을 선택해 주세요" });
  expect(input.textContent).toBe(value);
  expect(
    mocks.invoke.mock.calls.some(([cmd]) => cmd === "editor_font" || cmd === "edit_document"),
  ).toBe(false);
  mocks.open.mockResolvedValue("C:/fonts/original.ttf");
  fireEvent.click(
    screen.getByRole("button", { name: "\uC6D0\uBCF8 \uAE00\uAF34 \uBD88\uB7EC\uC624\uAE30" }),
  );
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("import_original_font", {
      path: "C:/fonts/original.ttf",
      expected: ["Helvetica"],
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "내용" }).textContent).toBe(value),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "내용" }).getAttribute("aria-disabled")).toBe(
      "false",
    ),
  );
  fireEvent.keyDown(screen.getByRole("textbox", { name: "내용" }), { key: "Enter" });
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "replace", page: 0, object: 0, text: value },
    }),
  );
});

it("commits empty text as deletion without requesting a font for the empty draft", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
    if (command === "editing_background") return "data:image/png;base64,AA==";
    if (command === "document_font") throw "원본 글꼴 데이터를 사용할 수 없습니다.";
    if (command === "edit_document")
      return { revision: 1, dirty: true, canUndo: true, canRedo: false };
  });
  render(<PdfPreview file={file} />);
  await enableEditing("object");
  fireEvent.doubleClick(await screen.findByRole("button", { name: /Hello World/ }));
  const input = await screen.findByRole("textbox", { name: "내용" });
  mocks.invoke.mockClear();
  fireEvent.input(input, { target: { textContent: "" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: { kind: "replace", page: 0, object: 0, text: "" },
    }),
  );
  expect(mocks.invoke.mock.calls.some(([command]) => command === "document_font")).toBe(false);
});

it("warns before applying missing glyphs and only substitutes after explicit choice", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
    if (command === "editing_background") return "data:image/png;base64,AA==";
    if (command === "document_font") throw "원본 글꼴에 입력한 문자가 없습니다.";
    if (command === "edit_document") throw "저장 검증 실패 테스트";
  });
  render(<PdfPreview file={file} />);
  await enableEditing("object");
  fireEvent.doubleClick(await screen.findByRole("button", { name: /Hello World/ }));
  const input = await screen.findByRole("textbox", { name: "내용" });
  fireEvent.input(input, { target: { textContent: "Hello 한글" } });
  await screen.findByText(
    "원본 글꼴로 반영할 수 없는 문자가 있습니다. 입력은 유지됩니다.",
    {},
    { timeout: 3000 },
  );
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "edit_document")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "반영 방법 선택" }));
  fireEvent.click(screen.getByRole("button", { name: "계속 편집" }));
  expect(input.textContent).toBe("Hello 한글");
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("dialog", { name: "반영할 글꼴을 선택해 주세요" });
  await selectOption(screen.getByRole("combobox", { name: "대체 글꼴" }), "나눔고딕");
  fireEvent.click(screen.getByRole("button", { name: "대체 글꼴로 반영" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 0,
      action: {
        kind: "flexibleEdit",
        page: 0,
        groups: [],
        object: 0,
        text: "Hello 한글",
        fonts: { 0: "nanum-gothic" },
      },
    }),
  );
  await screen.findByText("저장 검증 실패 테스트");
  expect(input.textContent).toBe("Hello 한글");
  expect(mocks.save).not.toHaveBeenCalled();
});

it("preserves dirty state on save cancellation/failure and clears it after verified save", async () => {
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "render_selected_page"
      ? {
          ...page(args.pageIndex, args.width),
          state: { revision: 1, dirty: true, canUndo: true, canRedo: false },
        }
      : undefined,
  );
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  await enableEditing();
  fireEvent.click(screen.getByRole("button", { name: "새 PDF로 저장" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "새 PDF로 저장" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "edit_document")).toBe(false);
  mocks.save.mockResolvedValue("C:\\edited.pdf");
  mocks.invoke.mockRejectedValueOnce("이미 존재하는 파일입니다.");
  fireEvent.click(screen.getByRole("button", { name: "새 PDF로 저장" }));
  await screen.findByRole("alert");
  expect(screen.getByText("저장하지 않은 변경 있음")).toBeTruthy();
  mocks.invoke.mockResolvedValueOnce({ revision: 1, dirty: false, canUndo: true, canRedo: false });
  fireEvent.click(screen.getByRole("button", { name: "새 PDF로 저장" }));
  await screen.findByText("새 PDF로 저장하고 다시 열어 검증했습니다.");
  expect(screen.queryByText("저장하지 않은 변경 있음")).toBeNull();
});

it("confirms native close and document close when unsaved changes exist", async () => {
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "render_selected_page"
      ? {
          ...page(args.pageIndex, args.width),
          state: { revision: 1, dirty: true, canUndo: true, canRedo: false },
        }
      : undefined,
  );
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  fireEvent.click(screen.getByRole("button", { name: "닫기 · 다른 파일" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "clear_selection")).toBe(false);
  const event = { preventDefault: vi.fn() };
  await act(async () => mocks.onClose.mock.calls[0][0](event));
  expect(event.preventDefault).toHaveBeenCalled();
  expect(mocks.destroy).not.toHaveBeenCalled();
  mocks.confirm.mockResolvedValueOnce(true);
  await act(async () => mocks.onClose.mock.calls[0][0](event));
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("changes the selected font through Rust and restores selection after object IDs change", async () => {
  let revision = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "document_font") return "AA==";
    if (command === "render_selected_page")
      return {
        ...page(args.pageIndex, args.width),
        state: { revision, dirty: revision > 0, canUndo: revision > 0, canRedo: false },
        text: {
          objects: [
            {
              ...object,
              id: revision ? 4 : 0,
              font: revision ? "Pretendard-Regular" : "Helvetica",
            },
          ],
          warning: null,
        },
      };
    if (command === "edit_document") {
      revision++;
      return { revision, dirty: true, canUndo: true, canRedo: false };
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  const fonts = screen.getByRole("combobox", { name: "글꼴" }) as HTMLButtonElement;
  expect(fonts.disabled).toBe(true);
  fireEvent.doubleClick(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  await waitFor(() => expect(fonts.disabled).toBe(false));
  await selectOption(fonts, "Pretendard");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "글꼴" }).textContent).toContain(
      "Pretendard-Regular",
    ),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
    fileId: file.id,
    revision: 0,
    action: { kind: "changeFont", page: 0, object: 0, font: "pretendard" },
  });
  expect((await screen.findByRole("textbox", { name: "내용" })).textContent).toBe("Hello World");
  fireEvent.input(await screen.findByRole("textbox", { name: "내용" }), {
    target: { textContent: "Hello" },
  });
  expect(fonts.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("edit_document", {
      fileId: file.id,
      revision: 1,
      action: { kind: "replace", page: 0, object: 4, text: "Hello" },
    }),
  );
});

it("preserves the original font when replacement fails", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "editing_background") return "data:image/png;base64,AA==";
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
    if (command === "edit_document") throw "선택한 글꼴에 없는 문자가 포함되어 있습니다.";
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(await screen.findByRole("button", { name: "텍스트 선택: Hello World" }));
  const fonts = screen.getByRole("combobox", { name: "글꼴" }) as HTMLButtonElement;
  await waitFor(() => expect(fonts.disabled).toBe(false));
  await selectOption(fonts, "Pretendard");
  expect((await screen.findByRole("alert")).textContent).toContain("없는 문자");
  expect(
    within(screen.getByRole("combobox", { name: "글꼴" })).getByText("Helvetica"),
  ).toBeTruthy();
  expect(screen.queryByText("저장하지 않은 변경 있음")).toBeNull();
});

it("places navigation below the page and synchronizes typed jumps with thumbnails", async () => {
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  const navigation = screen.getByRole("navigation", { name: "페이지 탐색" });
  const input = screen.getByRole("textbox", { name: "현재 페이지" }) as HTMLInputElement;
  expect(navigation.closest("header")).toBeNull();
  expect(screen.getByLabelText("PDF 페이지").nextElementSibling).toBe(navigation);
  expect(input.value).toBe("1");
  expect((screen.getByRole("button", { name: "이전 페이지" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(input, { target: { value: "02" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("img", { name: "example.pdf · 2페이지" });
  expect(input.value).toBe("2");
  expect(screen.getByRole("button", { name: "2페이지로 이동" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect((screen.getByRole("button", { name: "다음 페이지" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "1페이지로 이동" }));
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  expect(input.value).toBe("1");
});

it("rejects invalid page numbers and restores the current number with Escape", async () => {
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  const input = screen.getByRole("textbox", { name: "현재 페이지" }) as HTMLInputElement;
  for (const value of ["", "0", "-1", "3", "1.5", "1e0", "abc", "9007199254740992"]) {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("1부터 2까지");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("img", { name: "example.pdf · 1페이지" })).toBeTruthy();
  }
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("1");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    mocks.invoke.mock.calls.filter(
      ([cmd, args]) => cmd === "render_selected_page" && args.width === 800,
    ),
  ).toHaveLength(1);
});

it("preserves a failed draft and commits it before a successful typed page jump", async () => {
  let accept = false;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "render_selected_page")
      return { ...page(args.pageIndex, args.width), text: { objects: [object], warning: null } };
    if (command === "edit_document") {
      if (!accept) throw "변경을 적용하지 못했습니다.";
      return { revision: 1, dirty: true, canUndo: true, canRedo: false };
    }
  });
  render(<PdfPreview file={file} />);
  await enableEditing();
  fireEvent.doubleClick(screen.getByRole("button", { name: "텍스트 선택: Hello World" }));
  fireEvent.input(await screen.findByRole("textbox", { name: "내용" }), {
    target: { textContent: "Hello" },
  });
  const input = screen.getByRole("textbox", { name: "현재 페이지" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "2" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(await screen.findByRole("textbox", { name: "내용" })).toBeTruthy();
  fireEvent.change(input, { target: { value: "2" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input.value).toBe("1"));
  expect((await screen.findByRole("textbox", { name: "내용" })).textContent).toBe("Hello");
  await waitFor(() => expect(input.disabled).toBe(false));
  accept = true;
  fireEvent.change(input, { target: { value: "2" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("img", { name: "example.pdf · 2페이지" });
  expect(input.value).toBe("2");
  expect(screen.queryByRole("textbox", { name: "내용" })).toBeNull();
});

it("renders the selected file, navigates and rerenders at a new zoom", async () => {
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  expect(screen.getByText("1 / 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
  await screen.findByRole("img", { name: "example.pdf · 2페이지" });
  await selectOption(screen.getByRole("combobox", { name: "확대 비율" }), "145%");
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "example.pdf · 2페이지" }).getAttribute("width")).toBe(
      "1160",
    ),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("render_selected_page", {
    fileId: file.id,
    pageIndex: 1,
    width: 1160,
    onProgress: expect.any(Object),
  });
});

it("reports native page progress and waits for a finished page before hiding it", async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementation((command, args) => {
    if (command === "render_selected_page") {
      args.onProgress?.onmessage(40);
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  });
  render(<PdfPreview file={file} />);
  await waitFor(() =>
    expect(
      screen.getByRole("progressbar", { name: "페이지 로딩 진행률" }).getAttribute("value"),
    ).toBe("40"),
  );
  expect(screen.queryByRole("img", { name: "example.pdf · 1페이지" })).toBeNull();
  await act(async () => finish(page()));
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
  expect(screen.queryByRole("progressbar", { name: "페이지 로딩 진행률" })).toBeNull();
});

it("shows engine errors and retries without discarding the selection", async () => {
  mocks.invoke.mockRejectedValueOnce("암호가 필요한 PDF입니다.");
  render(<PdfPreview file={file} />);
  expect((await screen.findByRole("alert")).textContent).toContain("암호");
  expect(useFileStore.getState().file?.id).toBe(file.id);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByRole("img", { name: "example.pdf · 1페이지" });
});

it("closes while rendering and releases the document on unmount", async () => {
  let resolve!: (value: ReturnType<typeof page>) => void;
  mocks.invoke.mockImplementation((command, args) =>
    command === "render_selected_page"
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve({ revision: args?.revision ?? 1, file: null, error: null }),
  );
  const view = render(<PdfPreview file={file} />);
  fireEvent.click(screen.getByRole("button", { name: "닫기 · 다른 파일" }));
  await waitFor(() => expect(useFileStore.getState().file).toBeNull());
  view.unmount();
  expect(mocks.invoke).toHaveBeenCalledWith("release_preview", { fileId: file.id });
  await act(async () => {
    resolve(page());
  });
  expect(screen.queryByRole("img")).toBeNull();
});

it("rejects a render response for another document", async () => {
  mocks.invoke.mockResolvedValueOnce({ ...page(), fileId: "old-file" });
  render(<PdfPreview file={file} />);
  expect((await screen.findByRole("alert")).textContent).toContain("응답이 올바르지");
  expect(screen.queryByRole("img")).toBeNull();
});

it("lists page thumbnails and navigates from the sidebar", async () => {
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "2페이지 썸네일" });
  expect(screen.getByRole("button", { name: "1페이지로 이동" }).getAttribute("aria-current")).toBe(
    "page",
  );
  fireEvent.click(screen.getByRole("button", { name: "2페이지로 이동" }));
  await screen.findByRole("img", { name: "example.pdf · 2페이지" });
  expect(screen.getByRole("button", { name: "2페이지로 이동" }).getAttribute("aria-current")).toBe(
    "page",
  );
});

it("collapses and reopens the sidebar without resetting the selected page", async () => {
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "2페이지 썸네일" });
  fireEvent.click(screen.getByRole("button", { name: "2페이지로 이동" }));
  await screen.findByRole("img", { name: "example.pdf · 2페이지" });
  const rendersBefore = mocks.invoke.mock.calls.filter(
    ([command]) => command === "render_selected_page",
  ).length;
  fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
  expect(screen.queryByRole("complementary", { name: "페이지 목록" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "페이지 목록 펼치기" }).getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.getByRole("img", { name: "example.pdf · 2페이지" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "페이지 목록 펼치기" }));
  expect(screen.getByRole("complementary", { name: "페이지 목록" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "2페이지로 이동" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(
    mocks.invoke.mock.calls.filter(([command]) => command === "render_selected_page").length,
  ).toBe(rendersBefore);
});

it("scrolls to later pages without rendering every thumbnail at once", async () => {
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "render_selected_page"
      ? { ...page(args.pageIndex, args.width), pageCount: 100 }
      : undefined,
  );
  render(<PdfPreview file={file} />);
  await screen.findByRole("img", { name: "1페이지 썸네일" });
  expect(screen.queryByRole("button", { name: "90페이지로 이동" })).toBeNull();
  fireEvent.scroll(screen.getByLabelText("페이지 썸네일 스크롤"), {
    target: { scrollTop: 89 * 196 },
  });
  await screen.findByRole("img", { name: "90페이지 썸네일" });
  fireEvent.click(screen.getByRole("button", { name: "90페이지로 이동" }));
  await screen.findByRole("img", { name: "example.pdf · 90페이지" });
  expect(
    mocks.invoke.mock.calls.filter(
      ([command, args]) => command === "render_selected_page" && args.width === 300,
    ).length,
  ).toBeLessThan(25);
});
