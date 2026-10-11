import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragDropEvent } from "@tauri-apps/api/webview";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  isTauri: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
  render: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mocks.listen }),
}));
vi.mock("../lib/preview", () => ({ renderPage: mocks.render, releasePreview: mocks.release }));

import { FileInput } from "./FileInput";
import { App } from "../App";
vi.mock("./PdfPreview", () => ({ PdfPreview: () => <div>PDF 미리보기 화면</div> }));
import { useAppStore } from "../stores/app-store";

const original = {
  id: "file-1",
  path: "C:\\문서\\기존 파일.pdf",
  name: "기존 파일.pdf",
  sizeBytes: 1024,
};
const replacement = { id: "file-3", path: "C:\\새 파일.pdf", name: "새 파일.pdf", sizeBytes: 2048 };
const snapshot = (revision: number, file: typeof original | null = null, message?: string) => ({
  revision,
  file,
  error: message ? { code: "invalidHeader", message } : null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let listener: (event: { payload: DragDropEvent }) => void;
function drag(type: "enter" | "over" | "drop", paths: string[] = [], x = 150, y = 150) {
  // Only x/y are used by our event consumer.
  act(() => listener({ payload: { type, paths, position: { x, y } } as DragDropEvent }));
}
async function mount() {
  const result = render(
    <StrictMode>
      <FileInput />
    </StrictMode>,
  );
  await waitFor(() => expect(useAppStore.getState().ready).toBe(true));
  return result;
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.open.mockReset();
  mocks.listen.mockReset();
  mocks.render.mockReset();
  mocks.release.mockReset();
  mocks.render.mockImplementation(async (fileId) => ({
    fileId,
    imageUrl: "data:image/png;base64,iVBORw0KGgo=",
  }));
  mocks.release.mockResolvedValue(undefined);
  mocks.isTauri.mockReturnValue(true);
  mocks.open.mockResolvedValue(null);
  mocks.listen.mockImplementation((handler) => {
    listener = handler;
    return Promise.resolve(mocks.stop);
  });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "synchronize_selection") return snapshot(1);
    if (command === "clear_selection") return snapshot(args.revision);
    if (command === "receive_file_input") return snapshot(args.revision, original);
    throw new Error(`Unexpected command ${command}`);
  });
  useAppStore.setState({
    file: null,
    phase: "idle",
    error: null,
    ready: false,
    revision: 0,
    openedFileId: null,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 100,
    right: 300,
    top: 100,
    bottom: 300,
    width: 200,
    height: 200,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
  Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("file input UI → Zustand → IPC adapter (native IPC mocked)", () => {
  it("does not show a previous file thumbnail when a newer file is selected", async () => {
    const oldImage = deferred<{ imageUrl: string }>();
    mocks.render.mockImplementation((id) =>
      id === original.id
        ? oldImage.promise
        : Promise.resolve({ imageUrl: "data:image/png;base64,NEW" }),
    );
    mocks.invoke.mockImplementation(async (command, args) =>
      command === "synchronize_selection"
        ? snapshot(1, original)
        : snapshot(args.revision, replacement),
    );
    mocks.open.mockResolvedValue(replacement.path);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "다른 파일 선택" }));
    const image = await screen.findByRole("img", { name: "선택한 PDF의 첫 페이지" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,NEW");
    await act(async () => {
      oldImage.resolve({ imageUrl: "data:image/png;base64,OLD" });
    });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,NEW");
    expect(mocks.release).toHaveBeenCalledWith(original.id);
  });
  it("keeps the selected file in the confirmation card until PDF open is clicked", async () => {
    mocks.open.mockResolvedValue(original.path);
    render(<App />);
    await waitFor(() => expect(useAppStore.getState().ready).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "파일 선택" }));
    await screen.findByRole("heading", { name: "이 파일을 열까요?" });
    expect(screen.getByText(original.name)).toBeTruthy();
    expect(screen.getByText("1.0 KB")).toBeTruthy();
    expect(screen.queryByText("PDF 미리보기 화면")).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "render_selected_page")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "PDF 열기" }));
    expect(screen.getByText("PDF 미리보기 화면")).toBeTruthy();
  });

  it("replacing a selected file keeps the new file at the confirmation step", async () => {
    mocks.invoke.mockImplementation(async (command, args) =>
      command === "synchronize_selection"
        ? snapshot(1, original)
        : snapshot(args.revision, replacement),
    );
    mocks.open.mockResolvedValue(replacement.path);
    render(<App />);
    await screen.findByText(original.name);
    fireEvent.click(screen.getByRole("button", { name: "다른 파일 선택" }));
    await screen.findByText(replacement.name);
    expect(screen.queryByText(original.name)).toBeNull();
    expect(screen.queryByText("PDF 미리보기 화면")).toBeNull();
    expect(screen.getByRole("button", { name: "PDF 열기" })).toBeTruthy();
  });
  it("initializes once, selects a PDF and shows its first page without a clear button", async () => {
    mocks.open.mockResolvedValue(original.path);
    await mount();
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "synchronize_selection"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "파일 선택" }));
    await screen.findByText(original.name);
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: [{ name: "PDF 문서", extensions: ["pdf"] }],
      }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("receive_file_input", {
      paths: [original.path],
      revision: 2,
    });
    await screen.findByRole("img", { name: "선택한 PDF의 첫 페이지" });
    expect(mocks.render).toHaveBeenCalledWith(original.id, 0, 1600);
    expect(screen.queryByRole("button", { name: "선택 해제" })).toBeNull();
  });

  it("cancelling the dialog retains restored metadata without validation", async () => {
    mocks.invoke.mockResolvedValue(snapshot(5, original));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "다른 파일 선택" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "다른 파일 선택" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByText(original.name)).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("disables opening while a replacement file is being checked", async () => {
    const pending = deferred<ReturnType<typeof snapshot>>();
    mocks.open.mockResolvedValue(replacement.path);
    mocks.invoke.mockImplementation(async (command) =>
      command === "receive_file_input" ? pending.promise : snapshot(1, original),
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "다른 파일 선택" }));
    await waitFor(() => expect(useAppStore.getState().phase).toBe("checking"));
    expect((screen.getByRole("button", { name: "PDF 열기" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      pending.resolve(snapshot(2, replacement));
    });
    expect(screen.queryByText(original.name)).toBeNull();
    expect(screen.getByText(replacement.name)).toBeTruthy();
  });

  it("converts physical drag coordinates, highlights, and ignores outside drops", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 1.5, configurable: true });
    await mount();
    drag("enter", [original.path], 225, 225);
    expect(screen.getByRole("heading", { name: "여기에 놓아주세요" })).toBeTruthy();
    drag("over", [], 600, 600);
    expect(screen.getByRole("heading", { name: "PDF 파일을 끌어다 놓으세요" })).toBeTruthy();
    drag("drop", [original.path], 600, 600);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    drag("drop", [original.path], 225, 225);
    await screen.findByText(original.name);
  });

  it("shows structured errors and preserves the backend's previous selection", async () => {
    mocks.invoke.mockImplementation(async (command, args) =>
      command === "synchronize_selection"
        ? snapshot(1, original)
        : snapshot(args.revision, original, "PDF 한 개만 선택해 주세요."),
    );
    await mount();
    drag("drop", ["a.pdf", "b.pdf"]);
    expect((await screen.findByRole("alert")).textContent).toContain("PDF 한 개만");
    expect(screen.getByText(original.name)).toBeTruthy();
  });

  it("ignores an earlier response that arrives after the latest drop", async () => {
    const first = deferred<ReturnType<typeof snapshot>>();
    mocks.invoke.mockImplementation(async (command, args) =>
      command === "synchronize_selection"
        ? snapshot(1)
        : args.revision === 2
          ? first.promise
          : snapshot(args.revision, replacement),
    );
    await mount();
    drag("drop", [original.path]);
    drag("drop", [replacement.path]);
    await screen.findByText(replacement.name);
    await act(async () => {
      first.resolve(snapshot(2, original));
    });
    expect(screen.queryByText(original.name)).toBeNull();
    expect(screen.getByText(replacement.name)).toBeTruthy();
  });

  it("rejects malformed IPC metadata and can retry initialization", async () => {
    mocks.invoke.mockResolvedValueOnce({ revision: 1, file: { name: "broken" }, error: null });
    render(<FileInput />);
    expect((await screen.findByRole("alert")).textContent).toContain("응답이 올바르지");
    fireEvent.click(screen.getByRole("button", { name: "다시 연결" }));
    await waitFor(() => expect(useAppStore.getState().ready).toBe(true));
  });

  it("disables native actions in browser preview", () => {
    mocks.isTauri.mockReturnValue(false);
    render(<FileInput />);
    expect((screen.getByRole("button", { name: "파일 선택" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });
});
vi.mock("./MessageDialog", () => ({
  MessageDialog: ({ message }: { message: string | null }) =>
    message ? <p role="alert">{message}</p> : null,
}));
