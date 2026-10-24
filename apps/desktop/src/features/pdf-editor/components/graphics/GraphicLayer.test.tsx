import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GraphicLayer } from "./GraphicLayer";
import { invoke } from "@tauri-apps/api/core";
import type { PreviewPage } from "@/shared/pdf/types";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
}));
const bounds = [
  [10, 70],
  [110, 70],
  [110, 20],
  [10, 20],
];
const page: PreviewPage = {
  fileId: "a",
  pageIndex: 0,
  pageCount: 1,
  width: 600,
  height: 800,
  imageUrl: "",
  state: { revision: 0, dirty: false, canUndo: false, canRedo: false },
  text: {
    objects: [],
    warning: null,
    graphics: [
      {
        id: 0,
        kind: "image",
        bounds,
        screenBounds: [
          [10, 20],
          [110, 20],
          [110, 70],
          [10, 70],
        ],
      },
      { id: 1, kind: "path", bounds, screenBounds: bounds },
    ],
  },
};
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Element.prototype.setPointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("moves the actual image with a live preview, without an information panel", async () => {
  const edit = vi.fn().mockResolvedValue(false);
  render(<GraphicLayer page={page} disabled={false} onEdit={edit} onSelect={() => {}} />);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByRole("button", { name: "도형 2 선택" }).style.pointerEvents).toBe("stroke");
  const originalHitArea = screen.getByRole("button", { name: "이미지 1 선택" });
  fireEvent.click(originalHitArea);
  const handle = screen.getByRole("button", { name: "선택한 이미지·도형 이동" });
  await waitFor(() => expect(handle.style.cursor).toBe("move"));
  fireEvent.pointerDown(handle, { clientX: 20, clientY: 30 });
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 40 });
  expect(handle.style.left).toBe("30px");
  expect(handle.style.top).toBe("30px");
  expect(originalHitArea.getAttribute("visibility")).toBe("hidden");
  expect((await screen.findByTestId("moving-graphic")).style.transform).toContain(
    "translate(20px,10px)",
  );
  fireEvent.pointerUp(handle);
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith({
      kind: "transformGraphic",
      page: 0,
      object: 0,
      matrix: [1, 0, 0, 1, 20, -10],
    }),
  );
  await waitFor(() => expect(screen.queryByTestId("moving-graphic")).toBeNull());
});
it("accepts the first drag before preview preparation and captures across page content", async () => {
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(() => {}));
  const edit = vi.fn().mockResolvedValue(false);
  render(
    <GraphicLayer page={page} disabled={false} onEdit={edit} onSelect={() => {}} graphicMode />,
  );
  expect(screen.getByRole("button", { name: "도형 2 선택" }).style.pointerEvents).toBe("all");
  const image = screen.getByRole("button", { name: "이미지 1 선택" });
  fireEvent.pointerDown(image, { clientX: 20, clientY: 30 });
  fireEvent.pointerMove(image, { clientX: 320, clientY: 430 });
  const handle = screen.getByRole("button", { name: "선택한 이미지·도형 이동" });
  expect(handle.style.left).toBe("310px");
  expect(handle.style.top).toBe("420px");
  fireEvent.pointerUp(image);
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith({
      kind: "transformGraphic",
      page: 0,
      object: 0,
      matrix: [1, 0, 0, 1, 300, -400],
    }),
  );
});
it("resizes and deletes the selected object", async () => {
  const edit = vi.fn().mockResolvedValue(false);
  render(<GraphicLayer page={page} disabled={false} onEdit={edit} onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "이미지 1 선택" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "선택한 이미지·도형 이동" }).style.cursor).toBe(
      "move",
    ),
  );
  const handle = screen.getByRole("button", { name: "이미지·도형 크기 조절" });
  fireEvent.pointerDown(handle, { clientX: 110, clientY: 70 });
  fireEvent.pointerMove(handle, { clientX: 210, clientY: 120 });
  fireEvent.pointerUp(handle);
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith({
      kind: "transformGraphic",
      page: 0,
      object: 0,
      matrix: [2, 0, 0, 2, -10, -70],
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "이미지·도형 삭제" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "이미지·도형 삭제" }));
  await waitFor(() =>
    expect(edit).toHaveBeenLastCalledWith({ kind: "deleteGraphic", page: 0, object: 0 }),
  );
});

it("changes only the requested dimension with side handles", async () => {
  const edit = vi.fn().mockResolvedValue(false);
  render(<GraphicLayer page={page} disabled={false} onEdit={edit} onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "이미지 1 선택" }));
  const horizontal = screen.getByRole("button", { name: "이미지·도형 가로 조절" });
  fireEvent.pointerDown(horizontal, { clientX: 110, clientY: 45 });
  fireEvent.pointerMove(horizontal, { clientX: 210, clientY: 150 });
  fireEvent.pointerUp(horizontal);
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith({
      kind: "transformGraphic",
      page: 0,
      object: 0,
      matrix: [2, 0, 0, 1, -10, 0],
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "이미지·도형 삭제" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  const vertical = screen.getByRole("button", { name: "이미지·도형 세로 조절" });
  fireEvent.pointerDown(vertical, { clientX: 50, clientY: 70 });
  fireEvent.pointerMove(vertical, { clientX: 300, clientY: 120 });
  fireEvent.pointerUp(vertical);
  await waitFor(() =>
    expect(edit).toHaveBeenLastCalledWith({
      kind: "transformGraphic",
      page: 0,
      object: 0,
      matrix: [1, 0, 0, 2, 0, -70],
    }),
  );
});

it("copies a snapshot and pastes it after changing pages, without using stale object IDs", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText } } }));
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "copy_graphic" ? [37, 80, 68, 70] : "data:image/png;base64,AA==",
  );
  const edit = vi.fn().mockResolvedValue(false);
  const { rerender } = render(
    <GraphicLayer page={page} disabled={false} onEdit={edit} onSelect={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "이미지 1 선택" }));
  fireEvent.click(screen.getByRole("button", { name: "이미지·도형 복사" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("copy_graphic", {
    fileId: "a",
    revision: 0,
    pageIndex: 0,
    objectId: 0,
  });
  const marker = writeText.mock.calls[0][0];
  rerender(
    <GraphicLayer
      page={{ ...page, pageIndex: 1, state: { ...page.state, revision: 3 } }}
      disabled={false}
      onEdit={edit}
      onSelect={() => {}}
    />,
  );
  fireEvent.paste(document, { clipboardData: { getData: () => marker, items: [] } });
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith({ kind: "pasteGraphic", page: 1, source: [37, 80, 68, 70] }),
  );
  edit.mockClear();
  fireEvent.paste(document, {
    clipboardData: { getData: () => "unrelated copied text", items: [] },
  });
  expect(edit).not.toHaveBeenCalled();
});

it("pastes an external clipboard image and leaves native text paste alone", async () => {
  const edit = vi.fn().mockResolvedValue(false);
  render(<GraphicLayer page={page} disabled={false} onEdit={edit} onSelect={() => {}} />);
  const image = {
    type: "image/png",
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  };
  const clipboardData = {
    getData: () => "",
    items: [{ type: "image/png", getAsFile: () => image }],
  };
  fireEvent.paste(document, { clipboardData });
  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith({ kind: "pasteImage", page: 0, png: [1, 2, 3, 4] }),
  );
  edit.mockClear();
  const input = document.createElement("textarea");
  document.body.append(input);
  fireEvent.paste(input, { clipboardData });
  expect(edit).not.toHaveBeenCalled();
  input.remove();
});
