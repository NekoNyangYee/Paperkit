import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  release: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/shared/pdf/api", () => ({
  renderThumbnail: mocks.render,
  releasePreview: mocks.release,
}));
import { FileThumbnail } from "./FileThumbnail";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("decodes a sharp image before enabling preview and opens without a second render", async () => {
  let decoded!: () => void;
  const previous = Image.prototype.decode;
  Image.prototype.decode = () =>
    new Promise<void>((resolve) => {
      decoded = resolve;
    });
  mocks.render
    .mockReset()
    .mockResolvedValue({ imageUrl: "data:image/png;base64,AA==", width: 1600, height: 2200 });
  try {
    render(<FileThumbnail fileId="preview" />);
    await waitFor(() => expect(decoded).toBeTypeOf("function"));
    expect(screen.queryByRole("button", { name: "미리보기 확대" })).toBeNull();
    await act(async () => decoded());
    const trigger = await screen.findByRole("button", { name: "미리보기 확대" });
    fireEvent.click(trigger);
    const modal = screen.getByRole("dialog", { name: "PDF 미리보기" });
    expect(screen.getByRole("img", { name: "선택한 PDF 확대 미리보기" }).getAttribute("src")).toBe(
      "data:image/png;base64,AA==",
    );
    expect(mocks.render).toHaveBeenCalledExactlyOnceWith("preview", 0, 1600);
    fireEvent.keyDown(modal, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    expect(mocks.render).toHaveBeenCalledTimes(1);
  } finally {
    Image.prototype.decode = previous;
  }
});
