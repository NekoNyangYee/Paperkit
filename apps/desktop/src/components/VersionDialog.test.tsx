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
        body: "# Release notes\n\n## Changes\n\n- **Fixed** editing\n- [Details](https://github.com/NekoNyangYee/pdf-editor/releases)\n\n<b>Raw HTML</b>\n\n[unsafe](javascript:alert(1))",
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
  expect(screen.getByRole("img", { name: "Paperkit 로고" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "GitHub 저장소 열기" }));
  await waitFor(() =>
    expect(openUrl).toHaveBeenCalledWith("https://github.com/NekoNyangYee/pdf-editor"),
  );
  await screen.findByText(/새 버전이 있습니다/);
  expect(screen.getByRole("heading", { name: "Release notes", level: 1 })).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("Fixed").tagName).toBe("STRONG");
  expect(screen.getByText("<b>Raw HTML</b>").tagName).not.toBe("B");
  expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Details" }));
  await waitFor(() =>
    expect(openUrl).toHaveBeenCalledWith("https://github.com/NekoNyangYee/pdf-editor/releases"),
  );
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
