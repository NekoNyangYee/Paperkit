import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../lib/ensemble/read-page", () => ({ readPage: mocks.read }));
import { PageTextDialog } from "./PageTextDialog";
beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue({ text: "추출한 한글", source: "pdfium" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows native text, copies from the result, and retains it if image recognition fails", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  render(<PageTextDialog fileId="file" revision={3} pageIndex={1} onClose={() => {}} />);
  await screen.findByDisplayValue("추출한 한글");
  fireEvent.click(screen.getByRole("button", { name: "복사" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith("추출한 한글"));
  mocks.read.mockRejectedValueOnce(new Error("internal worker path"));
  fireEvent.click(screen.getByRole("button", { name: "이미지에서 다시 읽기" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "페이지 글자를 읽지 못했어요. 잠시 후 다시 시도해 주세요.",
  );
  expect(screen.getByDisplayValue("추출한 한글")).toBeTruthy();
  expect(mocks.read.mock.calls.at(-1)?.[0].forceOcr).toBe(true);
});
it("cancels pending extraction when the document or dialog unmounts", async () => {
  mocks.read.mockReturnValue(new Promise(() => {}));
  const view = render(
    <PageTextDialog fileId="file" revision={3} pageIndex={1} onClose={() => {}} />,
  );
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  const signal = mocks.read.mock.calls[0][0].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
