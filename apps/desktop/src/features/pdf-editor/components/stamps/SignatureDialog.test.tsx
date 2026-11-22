import { within } from "@testing-library/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignatureDialog } from "./SignatureDialog";
import { signaturePng } from "@/features/pdf-editor/lib/stamps/canvas";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { useToolStore } from "@/features/library/model/tool-store";

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
  useAuthStore.setState({ session: null });
  useToolStore.setState(useToolStore.getInitialState());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("previews a saved signature and inserts its original PNG only on confirmation", async () => {
  useAuthStore.setState({ session: { user: { id: "owner" } } as never });
  useToolStore.setState({
    owner: "owner",
    load: vi.fn(),
    tools: [
      {
        id: "sig",
        name: "업무용 서명",
        kind: "signature",
        content: "data:image/png;base64,AQID",
        createdAt: 1,
      },
      { id: "text", name: "별도 문구", kind: "text", content: "문구", createdAt: 2 },
    ],
  });
  const apply = vi.fn().mockResolvedValue(true);
  render(<SignatureDialog onApply={apply} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "내 도구함 · 전자서명" }));
  expect(
    screen
      .getByRole("dialog")
      .contains(screen.getByRole("region", { name: "내 도구함 · 전자서명" })),
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "별도 문구" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "업무용 서명" }));
  await screen.findByRole("img", { name: "업무용 서명" });
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(apply).toHaveBeenCalledWith([1, 2, 3]);
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
  const create = await screen.findByRole("button", { name: "적용" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  act(() => {
    mock.pad!.empty = false;
    mock.pad!.emit();
  });
  fireEvent.click(screen.getByRole("button", { name: "다시 그리기" }));
  expect(mock.pad!.empty).toBe(false);
  const reset = await screen.findByRole("alertdialog", { name: "서명 초기화" });
  fireEvent.click(within(reset).getByRole("button", { name: "초기화" }));
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(true));
  act(() => {
    mock.pad!.empty = false;
    mock.pad!.emit();
  });
  fireEvent.click(create);
  expect(signaturePng).toHaveBeenCalledWith(screen.getByLabelText("서명 그리기 영역"));
  expect(onApply).toHaveBeenCalledWith([7, 8]);
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
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
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await screen.findByRole("alert");
  expect(mock.pad!.empty).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  view.unmount();
  expect(mock.off).toHaveBeenCalledOnce();
});
