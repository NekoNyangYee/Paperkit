import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GraphicLayer } from "./GraphicLayer";
import type { PreviewPage } from "../lib/preview";
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
  expect(screen.getByTestId("moving-graphic").style.transform).toContain("translate(20px,10px)");
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
