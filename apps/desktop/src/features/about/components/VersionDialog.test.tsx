import { fireEvent, render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { VersionDialog } from "./VersionDialog";
import { downloadUpdate, installUpdate } from "@/features/about/lib/updater";
import { registerExitGuard } from "@/shared/desktop/app-exit";
vi.mock("@/features/about/lib/updater", () => ({
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  installUpdate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("shows installed version and a new release without rendering remote HTML", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.2.0",
        body: "# Release notes\n\n## Changes\n\n- **Fixed** editing\n- [Details](https://github.com/NekoNyangYee/Paperkit/releases)\n\n<b>Raw HTML</b>\n\n[unsafe](javascript:alert(1))",
        assets: [
          {
            name: "Paperkit_0.2.0_x64-setup.exe",
            browser_download_url:
              "https://github.com/NekoNyangYee/Paperkit/releases/download/v0.2.0/Paperkit_0.2.0_x64-setup.exe",
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
    expect(openUrl).toHaveBeenCalledWith("https://github.com/NekoNyangYee/Paperkit"),
  );
  await screen.findByText(/새 버전이 있습니다/);
  expect(screen.getByRole("heading", { name: "Release notes", level: 1 })).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("Fixed").tagName).toBe("STRONG");
  expect(screen.getByText("<b>Raw HTML</b>").tagName).not.toBe("B");
  expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Details" }));
  await waitFor(() =>
    expect(openUrl).toHaveBeenCalledWith("https://github.com/NekoNyangYee/Paperkit/releases"),
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "업데이트" }));
  await waitFor(() => expect(downloadUpdate).toHaveBeenCalledWith("v0.2.0", expect.any(Function)));
  const restart = await screen.findByRole("button", { name: "재시작하여 업데이트" });
  expect(openUrl).toHaveBeenCalledTimes(2);
  const removeGuard = registerExitGuard(async () => false);
  fireEvent.click(restart);
  await screen.findByRole("button", { name: "재시작하여 업데이트" });
  expect(installUpdate).not.toHaveBeenCalled();
  removeGuard();
  fireEvent.click(screen.getByRole("button", { name: "재시작하여 업데이트" }));
  await waitFor(() => expect(installUpdate).toHaveBeenCalledOnce());
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
it("shows download progress, prevents duplicate requests and offers retry on failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.2.0",
        assets: [
          {
            name: "Paperkit_0.2.0_x64-setup.exe",
            browser_download_url:
              "https://github.com/NekoNyangYee/Paperkit/releases/download/v0.2.0/Paperkit_0.2.0_x64-setup.exe",
          },
        ],
      }),
    }),
  );
  let fail: (error: Error) => void = () => {};
  vi.mocked(downloadUpdate).mockImplementationOnce(async (_tag, progress) => {
    progress({ downloaded: 50, total: 100 });
    await new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
  });
  render(<VersionDialog />);
  fireEvent.click(screen.getByRole("button", { name: "앱 버전 확인" }));
  fireEvent.click(await screen.findByRole("button", { name: "업데이트" }));
  const downloading = await screen.findByRole("button", { name: "다운로드 중 50%" });
  expect((downloading as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(downloading);
  expect(downloadUpdate).toHaveBeenCalledOnce();
  await act(async () => fail(new Error("다운로드가 중단되었습니다.")));
  await screen.findByText("다운로드가 중단되었습니다.");
  expect((screen.getByRole("button", { name: "업데이트" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(installUpdate).not.toHaveBeenCalled();
  expect(openUrl).not.toHaveBeenCalled();
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

it("checks at startup and opens the updater from the notification below the info button", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v0.3.0" }) }),
  );
  render(<VersionDialog />);
  const bubble = await screen.findByRole("status", { name: "새 버전 알림" });
  expect(bubble.textContent).toContain("새로운 버전이 나왔어요!");
  expect(bubble.textContent).toContain("v0.3.0");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "업데이트 확인" }));
  await screen.findByRole("dialog");
  expect(screen.queryByRole("status", { name: "새 버전 알림" })).toBeNull();
  await screen.findByText(/새 버전이 있습니다/);
  fireEvent.click(screen.getByRole("button", { name: "버전 창 닫기" }));
  expect(screen.queryByRole("status", { name: "새 버전 알림" })).toBeNull();
});

it("can dismiss the startup notification while keeping the info button available", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v0.3.0" }) }),
  );
  render(<VersionDialog />);
  fireEvent.click(await screen.findByRole("button", { name: "새 버전 알림 닫기" }));
  expect(screen.queryByRole("status", { name: "새 버전 알림" })).toBeNull();
  expect(screen.getByRole("button", { name: "앱 버전 확인" })).toBeTruthy();
});

it.each(["v0.1.0", "v0.0.9"])("does not show a startup notification for %s", async (tag) => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: tag }) });
  vi.stubGlobal("fetch", fetcher);
  render(<VersionDialog />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(screen.queryByRole("status", { name: "새 버전 알림" })).toBeNull();
});

it("stays quiet on startup network failure and aborts checking on unmount", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const view = render(<VersionDialog />);
  await act(async () => {});
  expect(screen.queryByRole("status", { name: "새 버전 알림" })).toBeNull();
  expect(screen.queryByText("offline")).toBeNull();
  view.unmount();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    }),
  );
  const pending = render(<VersionDialog />);
  await waitFor(() => expect(signal).toBeDefined());
  pending.unmount();
  expect(signal?.aborted).toBe(true);
});
