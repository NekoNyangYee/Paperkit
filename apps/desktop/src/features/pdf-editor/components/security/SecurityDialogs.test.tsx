import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { renderPage } from "@/shared/pdf/api";
import type { PreviewPage } from "@/shared/pdf/types";
import { MaskDialog } from "./MaskDialog";
import { SignatureStatus } from "./SignatureStatus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@/shared/pdf/api", () => ({ renderPage: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keeps masks across pages and tab switches and exports against the displayed revision", async () => {
  const initial: PreviewPage = {
    fileId: "document",
    pageIndex: 0,
    pageCount: 2,
    width: 400,
    height: 600,
    imageUrl: "data:image/png;base64,AQID",
    text: { objects: [], warning: null },
    state: { revision: 3, dirty: true, canUndo: true, canRedo: false },
  };
  vi.mocked(renderPage).mockResolvedValue({ ...initial, pageIndex: 1 });
  vi.mocked(save).mockResolvedValueOnce(null).mockResolvedValueOnce("copy.pdf");
  const props = {
    initial,
    file: { id: "document", name: "file.pdf", path: "file.pdf", sizeBytes: 100 },
    onClose: vi.fn(),
    onSaved: vi.fn(),
  };
  const view = render(<MaskDialog active {...props} />);
  const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
  const key = (key: string, ctrlKey = false, shiftKey = false) =>
    fireEvent.keyDown(screen.getByRole("dialog"), { key, ctrlKey, shiftKey });
  key("+", true);
  expect((screen.getByLabelText("확대 비율") as HTMLSelectElement).value).toBe("115");
  key("0", true);
  expect((screen.getByLabelText("확대 비율") as HTMLSelectElement).value).toBe("100");
  expect(renderPage).not.toHaveBeenCalled();
  key("PageDown");
  await screen.findByRole("img", { name: "2페이지 마스킹 미리보기" });
  click("페이지 전체 가리기");
  expect(screen.getByRole("button", { name: "페이지 전체 가리기" }).hasAttribute("disabled")).toBe(
    true,
  );
  click("페이지 전체 가리기");
  expect(screen.queryByText("2쪽 · 영역 2")).toBeNull();
  key("Delete");
  expect(screen.queryByText("2쪽 · 영역 1")).toBeNull();
  key("z", true);
  expect(screen.getByText("2쪽 · 영역 1")).toBeTruthy();
  key("z", true, true);
  expect(screen.queryByText("2쪽 · 영역 1")).toBeNull();
  key("z", true);
  view.rerender(<MaskDialog active={false} {...props} />);
  view.rerender(<MaskDialog active {...props} />);
  click("이전");
  expect(screen.getByText("2쪽 · 영역 1")).toBeTruthy();
  key("s", true);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "저장" }).hasAttribute("disabled")).toBe(false),
  );
  expect(invoke).not.toHaveBeenCalled();
  click("저장");
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("save_masked_copy", {
    fileId: "document",
    revision: 3,
    path: "copy.pdf",
    masks: [{ page: 1, x: 0, y: 0, right: 1, bottom: 1, stars: false, blur: true }],
  });
});

it("shows post-signing additions and trust separately from signed bytes", () => {
  render(
    <SignatureStatus
      reports={[{ signer: "Test", integrity: "matches", trust: "unknown", laterBytes: true }]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "원본 서명 후 변경 있음" }));
  for (const label of [
    "Test",
    "서명된 바이트 일치",
    "추가 데이터 있음",
    "신뢰 또는 폐기 여부 확인 불가",
  ]) {
    expect(screen.getByText(label)).toBeTruthy();
  }
});

it("moves and resizes an existing blur in page coordinates and undoes one drag at a time", async () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
      isPrimary = true;
    },
  );
  try {
    const initial: PreviewPage = {
      fileId: "d",
      pageIndex: 0,
      pageCount: 1,
      width: 1600,
      height: 1600,
      imageUrl: "data:image/png;base64,AQID",
      text: { objects: [], warning: null },
      state: { revision: 7, dirty: false, canUndo: false, canRedo: false },
    };
    render(
      <MaskDialog
        active
        initial={initial}
        file={{ id: "d", name: "d.pdf", path: "d.pdf", sizeBytes: 100 }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const area = screen.getByLabelText("마스킹 영역 선택");
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 256,
      height: 256,
    } as DOMRect);
    function drag(target: Element, from: number[], to: number[]) {
      fireEvent.pointerDown(target, { button: 0, clientX: from[0], clientY: from[1] });
      fireEvent.pointerMove(area, { clientX: to[0], clientY: to[1] });
      fireEvent.pointerUp(area, { clientX: to[0], clientY: to[1] });
    }
    drag(area, [64, 64], [128, 128]);
    const blur = area.querySelector<HTMLElement>('[data-region="0"]')!;
    drag(blur, [80, 80], [112, 112]);
    expect(blur.style.left).toBe("37.5%");
    drag(blur.querySelector('[data-handle="se"]')!, [160, 160], [224, 192]);
    expect(blur.style.width).toBe("50%");
    expect(blur.style.height).toBe("37.5%");
    fireEvent.keyDown(area, { key: "z", ctrlKey: true });
    expect(blur.style.width).toBe("25%");
    vi.mocked(save).mockResolvedValue("blur.pdf");
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_masked_copy", {
        fileId: "d",
        revision: 7,
        path: "blur.pdf",
        masks: [
          { page: 0, x: 0.375, y: 0.375, right: 0.625, bottom: 0.625, stars: false, blur: true },
        ],
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("replaces a Unicode text selection in the masked copy and can undo it independently of blur", async () => {
  const text = "가😀나다라";
  const initial: PreviewPage = {
    fileId: "d",
    pageIndex: 0,
    pageCount: 1,
    width: 400,
    height: 600,
    imageUrl: "original.png",
    text: {
      objects: [
        {
          id: 3,
          text,
          screenBounds: [
            [5, 5],
            [55, 5],
            [55, 20],
            [5, 20],
          ],
          font: "F",
          fontSize: 10,
          matrix: [],
          bounds: [],
          color: [],
          editBlocked: null,
          fontChangeBlocked: null,
        },
      ],
      warning: null,
    },
    state: { revision: 8, dirty: false, canUndo: false, canRedo: false },
  };
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:masked";
      }
      static revokeObjectURL() {}
    },
  );
  try {
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(4));
    vi.mocked(save).mockResolvedValue("copy.pdf");
    render(
      <MaskDialog
        active
        initial={initial}
        file={{ id: "d", name: "d.pdf", path: "d.pdf", sizeBytes: 100 }}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
    click("페이지 전체 가리기");
    click("별표 대체");
    click("텍스트 선택: " + text);
    const input = screen.getByLabelText("대체할 글자 범위") as HTMLTextAreaElement;
    input.setSelectionRange(1, 4);
    click("적용");
    const textMasks = [{ page: 0, object: 3, start: 1, end: 3 }];
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "1페이지 마스킹 미리보기" }).getAttribute("src")).toBe(
        "blob:masked",
      ),
    );
    expect(invoke).toHaveBeenCalledWith("preview_text_masks", {
      fileId: "d",
      revision: 8,
      page: 0,
      textMasks,
    });
    click("저장");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_masked_copy", {
        fileId: "d",
        revision: 8,
        path: "copy.pdf",
        textMasks,
        masks: [{ page: 0, x: 0, y: 0, right: 1, bottom: 1, stars: false, blur: true }],
      }),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "z", ctrlKey: true });
    expect(screen.getByRole("img", { name: "1페이지 마스킹 미리보기" }).getAttribute("src")).toBe(
      "original.png",
    );
    expect(screen.getByText("1쪽 · 영역 1")).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});
