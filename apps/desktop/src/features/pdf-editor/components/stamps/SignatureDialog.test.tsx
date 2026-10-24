import { within } from "@testing-library/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignatureDialog } from "./SignatureDialog";
import { signaturePng } from "@/features/pdf-editor/lib/stamps/canvas";

const mock = vi.hoisted(() => ({
  pad: null as null | { empty: boolean; emit: () => void },
  off: vi.fn(),
}));
vi.mock("signature_pad", () => ({
  default: class {
    empty = true;
    emit = () => {};
    constructor() {
      mock.pad = this;
    }
    addEventListener(_event: string, callback: () => void) {
      this.emit = callback;
    }
    isEmpty() {
      return this.empty;
    }
    toData() {
      return [];
    }
    fromData() {}
    clear() {
      this.empty = true;
    }
    off() {
      mock.off();
    }
  },
}));
vi.mock("@/features/pdf-editor/lib/stamps/canvas", () => ({
  signaturePng: vi.fn(),
  canvasContext: () => ({ setTransform: vi.fn() }),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(signaturePng).mockReturnValue({
    png: [7, 8],
    url: "data:image/png;base64,c2lnbg==",
    width: 200,
    height: 80,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("blocks empty signatures, clears strokes, and inserts the generated transparent PNG once", async () => {
  let finish: (value: boolean) => void = () => {};
  const onApply = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    ),
    onClose = vi.fn();
  render(<SignatureDialog onApply={onApply} onClose={onClose} />);
  const create = await screen.findByRole("button", { name: "서명 생성" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  act(() => {
    mock.pad!.empty = false;
    mock.pad!.emit();
  });
  fireEvent.click(screen.getByRole("button", { name: "다시 그리기" }));
  expect(mock.pad!.empty).toBe(false);
  const reset = await screen.findByRole("alertdialog", { name: "서명 초기화" });
  fireEvent.click(within(reset).getByRole("button", { name: "서명 지우기" }));
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(true));
  act(() => {
    mock.pad!.empty = false;
    mock.pad!.emit();
  });
  fireEvent.click(create);
  expect(signaturePng).toHaveBeenCalledWith(screen.getByLabelText("서명 그리기 영역"));
  expect(onApply).toHaveBeenCalledWith([7, 8]);
  fireEvent.click(screen.getByRole("button", { name: "서명 넣는 중…" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onApply).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => finish(true));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("keeps drawn strokes on insertion failure and releases signature listeners on unmount", async () => {
  const onApply = vi.fn().mockResolvedValue(false),
    onClose = vi.fn();
  const view = render(<SignatureDialog onApply={onApply} onClose={onClose} />);
  await screen.findByLabelText("서명 그리기 영역");
  act(() => {
    mock.pad!.empty = false;
    mock.pad!.emit();
  });
  fireEvent.click(screen.getByRole("button", { name: "서명 생성" }));
  await screen.findByRole("alert");
  expect(mock.pad!.empty).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  view.unmount();
  expect(mock.off).toHaveBeenCalledOnce();
});
