import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { VersionDialog } from "./VersionDialog";
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it("shows installed version and a new release without rendering remote HTML", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.2.0",
        body: "<b>Release notes</b>",
        assets: [
          {
            name: "Paperkit_0.2.0_x64-setup.exe",
            browser_download_url:
              "https://github.com/NekoNyangYee/pdf-editor/releases/download/v0.2.0/Paperkit_0.2.0_x64-setup.exe",
          },
        ],
      }),
    }),
  );
  render(<VersionDialog />);
  fireEvent.click(screen.getByRole("button", { name: "앱 버전 확인" }));
  await screen.findByText("현재 버전 0.1.0");
  await screen.findByText(/새 버전이 있습니다/);
  expect(screen.getByText("<b>Release notes</b>").tagName).toBe("PRE");
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "업데이트" }));
  await waitFor(() =>
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/NekoNyangYee/pdf-editor/releases/download/v0.2.0/Paperkit_0.2.0_x64-setup.exe",
    ),
  );
});
it("does not offer an update for the installed version", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v0.1.0" }) }),
  );
  render(<VersionDialog />);
  fireEvent.click(screen.getByRole("button", { name: "앱 버전 확인" }));
  await screen.findByText(/최신 버전입니다/);
  expect(screen.queryByRole("button", { name: "업데이트" })).toBeNull();
});
it("disables updating when a newer release has no Windows installer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v0.2.0" }) }),
  );
  render(<VersionDialog />);
  fireEvent.click(screen.getByRole("button", { name: "앱 버전 확인" }));
  await screen.findByText(/새 버전이 있습니다/);
  expect((screen.getByRole("button", { name: "업데이트" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
it("cancels a request when the close button is clicked", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    }),
  );
  render(<VersionDialog />);
  fireEvent.click(screen.getByRole("button", { name: "앱 버전 확인" }));
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "버전 창 닫기" }));
  expect(signal?.aborted).toBe(true);
});
