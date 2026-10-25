import { selectOption, slide } from "@/test/controls";
import { within } from "@testing-library/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WatermarkDialog } from "./WatermarkDialog";
import { invoke } from "@tauri-apps/api/core";
import { watermarkPng, watermarkSource } from "@/features/pdf-editor/lib/stamps/watermark";
import type { PreviewPage } from "@/shared/pdf/types";
import placeholderUrl from "@/features/pdf-editor/lib/stamps/watermark-placeholder.svg";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@/features/pdf-editor/lib/stamps/watermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/pdf-editor/lib/stamps/watermark")>()),
  watermarkPng: vi.fn(),
  watermarkSource: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const page: PreviewPage = {
  fileId: "doc",
  pageIndex: 2,
  pageCount: 5,
  width: 800,
  height: 1200,
  imageUrl: "data:image/png;base64,UEFHRQ==",
  text: { objects: [], warning: null },
  state: { revision: 4, dirty: true, canUndo: true, canRedo: false },
};
const image = { png: [1, 2, 3], url: "data:image/png;base64,V0FURVI=", width: 600, height: 200 };
const source = { ...image, canvas: document.createElement("canvas") };
beforeEach(() => {
  vi.mocked(watermarkSource).mockResolvedValue(source);
  vi.mocked(watermarkPng).mockResolvedValue(image);
});

it("previews and applies a date beside text, and restores the original text when disabled", async () => {
  vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
    format: () => "2026-10-25",
  } as Intl.DateTimeFormat);
  try {
    const onApply = vi.fn().mockResolvedValue(false);
    render(<WatermarkDialog page={page} onApply={onApply} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
    fireEvent.change(screen.getByLabelText("워터마크 텍스트"), {
      target: { value: "내부 검토용" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "날짜 추가" }));
    await waitFor(() =>
      expect(watermarkSource).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "내부 검토용", date: "2026-10-25" }),
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "워터마크 적용" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
    await screen.findByRole("alert");
    expect(watermarkPng).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "내부 검토용", date: "2026-10-25" }),
      source,
    );
    fireEvent.click(screen.getByRole("switch", { name: "날짜 추가" }));
    await waitFor(() =>
      expect(watermarkSource).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "내부 검토용", date: null }),
      ),
    );
    expect((screen.getByLabelText("워터마크 텍스트") as HTMLTextAreaElement).value).toBe(
      "내부 검토용",
    );
  } finally {
    vi.restoreAllMocks();
  }
});

it("previews text over the real page and submits all pages as one watermark action", async () => {
  vi.mocked(watermarkPng).mockResolvedValue(image);
  const onApply = vi.fn().mockResolvedValue(true),
    onClose = vi.fn();
  render(<WatermarkDialog page={page} onApply={onApply} onClose={onClose} />);
  fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
  await screen.findByRole("img", { name: "워터마크 미리보기" });
  expect(
    (screen.getByRole("img", { name: "워터마크 적용 전 페이지" }) as HTMLImageElement).src,
  ).toBe(page.imageUrl);
  fireEvent.change(screen.getByLabelText("워터마크 텍스트"), { target: { value: "내부 검토용" } });
  slide("워터마크 투명도", 35);
  slide("워터마크 각도", -15);
  slide("워터마크 크기", 70);
  await waitFor(() =>
    expect(watermarkSource).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "text", text: "내부 검토용" }),
    ),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "워터마크 적용" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
  await waitFor(() =>
    expect(onApply).toHaveBeenCalledWith({
      kind: "addWatermark",
      page: null,
      png: image.png,
      widthRatio: 0.7,
    }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(watermarkPng).toHaveBeenLastCalledWith(
    expect.objectContaining({ opacity: 35, angle: -15 }),
    source,
  );
});

it("selects an image, targets the current page, and preserves settings after a rejected edit", async () => {
  vi.mocked(watermarkSource).mockImplementation(async (options) => {
    if (options.kind === "image" && !options.image) throw new Error("이미지 파일을 선택해 주세요.");
    return source;
  });
  const onApply = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    onClose = vi.fn();
  render(<WatermarkDialog page={page} onApply={onApply} onClose={onClose} />);
  fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
  fireEvent.click(await screen.findByRole("radio", { name: "이미지" }));
  await screen.findByRole("img", { name: "워터마크 기본 이미지 미리보기" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "워터마크 적용" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  const file = new File(["png"], "brand.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("워터마크 이미지 파일"), { target: { files: [file] } });
  await selectOption(
    screen.getByRole("combobox", { name: "워터마크 적용 범위" }),
    "현재 페이지 (3페이지)",
  );
  await screen.findByRole("img", { name: "워터마크 미리보기" });
  fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
  await screen.findByRole("alert");
  expect(onClose).not.toHaveBeenCalled();
  expect(onApply).toHaveBeenLastCalledWith({
    kind: "addWatermark",
    page: 2,
    png: image.png,
    widthRatio: 0.8,
  });
  expect(screen.getByText("brand.png")).toBeTruthy();
  expect(watermarkSource).toHaveBeenLastCalledWith(
    expect.objectContaining({ image: file, kind: "image", text: "" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("clears text immediately on image mode, previews a placeholder and waits for a real file", async () => {
  const onApply = vi.fn();
  render(<WatermarkDialog page={page} onApply={onApply} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
  const oldText = await screen.findByRole("img", { name: "워터마크 미리보기" });
  fireEvent.change(screen.getByLabelText("워터마크 텍스트"), {
    target: { value: "남으면 안 되는 텍스트" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "이미지" }));
  const placeholder = screen.getByRole("img", {
    name: "워터마크 기본 이미지 미리보기",
  }) as HTMLImageElement;
  expect(screen.queryByRole("img", { name: "워터마크 미리보기" })).toBeNull();
  expect(oldText.isConnected).toBe(false);
  expect(placeholder.getAttribute("src")).toBe(placeholderUrl);
  expect(placeholder.style.transform).toContain("rotate(0deg)");
  expect(placeholder.style.width).toBe("80%");
  expect(screen.getByRole("slider", { name: "워터마크 크기" }).getAttribute("aria-valuenow")).toBe(
    "80",
  );
  expect(screen.getByRole("slider", { name: "워터마크 각도" }).getAttribute("aria-valuenow")).toBe(
    "0",
  );
  expect(screen.queryByLabelText("워터마크 텍스트")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
  expect(onApply).not.toHaveBeenCalled();
  expect(watermarkPng).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "텍스트" }));
  expect((screen.getByLabelText("워터마크 텍스트") as HTMLTextAreaElement).value).toBe(
    "CONFIDENTIAL",
  );
  expect(screen.getByRole("slider", { name: "워터마크 각도" }).getAttribute("aria-valuenow")).toBe(
    "-30",
  );
});

it("never mixes a late text preview with the selected image when applying over an existing watermark", async () => {
  let finishText!: (value: typeof source) => void;
  const imageSource = {
    ...source,
    url: "data:image/png;base64,SU1BR0U=",
    canvas: document.createElement("canvas"),
  };
  vi.mocked(watermarkSource).mockImplementation((options) =>
    options.kind === "text"
      ? new Promise((resolve) => {
          finishText = resolve;
        })
      : Promise.resolve(imageSource),
  );
  vi.mocked(invoke).mockResolvedValue("data:image/png;base64,Q0xFQU4=");
  const marked = { ...page, text: { ...page.text, watermarkPages: [2], watermarkObjects: [9] } };
  const onApply = vi.fn().mockResolvedValue(true);
  render(<WatermarkDialog page={marked} onApply={onApply} onClose={vi.fn()} />);
  await waitFor(() => expect(watermarkSource).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("radio", { name: "이미지" }));
  await screen.findByRole("img", { name: "워터마크 기본 이미지 미리보기" });
  const file = new File(["image"], "replacement.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("워터마크 이미지 파일"), { target: { files: [file] } });
  const selected = (await screen.findByRole("img", {
    name: "워터마크 미리보기",
  })) as HTMLImageElement;
  await act(async () => {
    finishText(source);
  });
  expect(selected.src).toBe(imageSource.url);
  expect(screen.getAllByRole("img")).toHaveLength(2);
  expect(
    (screen.getByRole("img", { name: "워터마크 적용 전 페이지" }) as HTMLImageElement).src,
  ).toBe("data:image/png;base64,Q0xFQU4=");
  fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
  await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  expect(watermarkPng).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "image", text: "", image: file, angle: 0 }),
    imageSource,
  );
  expect(onApply).toHaveBeenCalledWith({
    kind: "addWatermark",
    page: null,
    png: image.png,
    widthRatio: 0.8,
  });
});

it("ignores a stale generated preview and prevents cancellation or duplicate edits while applying", async () => {
  let complete: (value: typeof source) => void = () => {};
  vi.mocked(watermarkSource)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(source);
  let finish: (value: boolean) => void = () => {};
  const onApply = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    ),
    onClose = vi.fn();
  render(<WatermarkDialog page={page} onApply={onApply} onClose={onClose} />);
  fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
  await waitFor(() => expect(watermarkSource).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText("워터마크 텍스트"), { target: { value: "최종" } });
  await screen.findByRole("img", { name: "워터마크 미리보기" });
  complete({ ...source, png: [9], url: "data:image/png;base64,T0xE" });
  fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
  await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "적용 중…" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ png: [1, 2, 3] }));
  expect(watermarkPng).toHaveBeenLastCalledWith(expect.objectContaining({ text: "최종" }), source);
  expect(onClose).not.toHaveBeenCalled();
  finish(true);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("updates all sliders immediately without removing or regenerating the preview", async () => {
  const onApply = vi.fn().mockResolvedValue(true);
  render(<WatermarkDialog page={page} onApply={onApply} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
  const preview = (await screen.findByRole("img", {
    name: "워터마크 미리보기",
  })) as HTMLImageElement;
  const originalWidth = preview.style.width;
  for (const opacity of [30, 45, 77]) {
    slide("워터마크 투명도", opacity);
    expect(screen.getByRole("img", { name: "워터마크 미리보기" })).toBe(preview);
    expect(preview.style.opacity).toBe(String(opacity / 100));
    expect(preview.src).toBe(source.url);
  }
  slide("워터마크 각도", 48);
  expect(preview.style.transform).toContain("rotate(48deg)");
  slide("워터마크 크기", 80);
  expect(preview.style.width).not.toBe(originalWidth);
  expect(watermarkSource).toHaveBeenCalledOnce();
  expect(watermarkPng).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "워터마크 적용" }));
  await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  expect(watermarkPng).toHaveBeenLastCalledWith(
    expect.objectContaining({ opacity: 77, angle: 48 }),
    source,
  );
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ widthRatio: 0.8 }));
});

it("resets text, color, selected image, sliders and page scope to their initial values", async () => {
  render(<WatermarkDialog page={page} onApply={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
  await screen.findByRole("img", { name: "워터마크 미리보기" });
  fireEvent.change(screen.getByLabelText("워터마크 텍스트"), { target: { value: "변경한 내용" } });
  fireEvent.change(screen.getByLabelText("워터마크 색상"), { target: { value: "#ff0000" } });
  slide("워터마크 투명도", 80);
  slide("워터마크 크기", 85);
  slide("워터마크 각도", 60);
  await selectOption(
    screen.getByRole("combobox", { name: "워터마크 적용 범위" }),
    "현재 페이지 (3페이지)",
  );
  fireEvent.click(screen.getByRole("radio", { name: "이미지" }));
  fireEvent.change(screen.getByLabelText("워터마크 이미지 파일"), {
    target: { files: [new File(["png"], "selected.png", { type: "image/png" })] },
  });
  await screen.findByText("selected.png");
  fireEvent.click(screen.getByRole("button", { name: "초기화" }));
  const warning = await screen.findByRole("alertdialog", { name: "워터마크 설정 초기화" });
  expect(
    screen.getByRole("radio", { name: "이미지", hidden: true }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(within(warning).getByRole("button", { name: "초기화" }));
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "텍스트" }).getAttribute("aria-checked")).toBe("true"),
  );
  expect(screen.getByRole("radio", { name: "텍스트" }).getAttribute("aria-checked")).toBe("true");
  for (const [label, value] of [
    ["워터마크 텍스트", "CONFIDENTIAL"],
    ["워터마크 색상", "#64748b"],
    ["워터마크 투명도", "25"],
    ["워터마크 크기", "60"],
    ["워터마크 각도", "-30"],
    ["워터마크 적용 범위", "all"],
  ]) {
    if (label === "워터마크 적용 범위")
      expect(screen.getByRole("combobox", { name: label }).textContent).toBe("전체 페이지");
    else if (["워터마크 투명도", "워터마크 크기", "워터마크 각도"].includes(label!))
      expect(screen.getByRole("slider", { name: label }).getAttribute("aria-valuenow")).toBe(value);
    else expect((screen.getByLabelText(label!) as HTMLInputElement).value).toBe(value);
  }
  await waitFor(() =>
    expect(watermarkSource).toHaveBeenLastCalledWith({
      kind: "text",
      text: "CONFIDENTIAL",
      color: "#64748b",
      image: null,
      date: null,
    }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "이미지" }));
  expect(screen.queryByText("selected.png")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "워터마크 적용" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("starts disabled and keeps settings when reset is cancelled", async () => {
  const onApply = vi.fn();
  render(<WatermarkDialog page={page} onApply={onApply} onClose={vi.fn()} />);
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("img", { name: "워터마크 미리보기" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "워터마크 제거" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
  await screen.findByRole("img", { name: "워터마크 미리보기" });
  fireEvent.change(screen.getByLabelText("워터마크 텍스트"), { target: { value: "보관할 내용" } });
  fireEvent.click(screen.getByRole("button", { name: "초기화" }));
  const warning = await screen.findByRole("alertdialog");
  expect(document.activeElement).toBe(within(warning).getByRole("button", { name: "취소" }));
  fireEvent.click(within(warning).getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByLabelText("워터마크 텍스트") as HTMLTextAreaElement).value).toBe(
    "보관할 내용",
  );
  expect(onApply).not.toHaveBeenCalled();
});

it("previews removal without old watermarks, targets the chosen scope and keeps failed removal open", async () => {
  vi.mocked(invoke).mockResolvedValue("data:image/png;base64,Q0xFQU4=");
  const marked = {
    ...page,
    text: { ...page.text, watermarkPages: [0, 2, 4], watermarkObjects: [9] },
  };
  const onApply = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    onClose = vi.fn();
  render(<WatermarkDialog page={marked} onApply={onApply} onClose={onClose} />);
  await waitFor(() =>
    expect(
      (screen.getByRole("img", { name: "워터마크 적용 전 페이지" }) as HTMLImageElement).src,
    ).toBe("data:image/png;base64,Q0xFQU4="),
  );
  expect(invoke).toHaveBeenCalledWith("editing_background", {
    fileId: "doc",
    revision: 4,
    pageIndex: 2,
    width: 800,
    objects: [9],
  });
  fireEvent.click(screen.getByRole("switch", { name: "워터마크 사용" }));
  expect(screen.queryByRole("img", { name: "워터마크 미리보기" })).toBeNull();
  await selectOption(
    screen.getByRole("combobox", { name: "워터마크 적용 범위" }),
    "현재 페이지 (3페이지)",
  );
  fireEvent.click(screen.getByRole("button", { name: "워터마크 제거" }));
  await screen.findByRole("alert");
  expect(onClose).not.toHaveBeenCalled();
  expect(onApply).toHaveBeenLastCalledWith({ kind: "removeWatermark", page: 2 });
  expect(watermarkPng).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "워터마크 제거" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("does not edit on cancellation and waits for the exit animation before unmounting its owner", async () => {
  const onClose = vi.fn(),
    onApply = vi.fn();
  render(<WatermarkDialog page={page} onApply={onApply} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(onClose).not.toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
