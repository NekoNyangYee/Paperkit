import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const controls = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => controls }));
vi.mock("./VersionDialog", () => ({ VersionDialog: () => <button>앱 정보</button> }));
import { TitleBar } from "./TitleBar";
afterEach(cleanup);
it("keeps app info outside the drag region and requests close without destroying the window", async () => {
  render(<TitleBar />);
  expect(screen.getByText("앱 정보").closest("[data-tauri-drag-region]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "창 최소화" }));
  fireEvent.click(screen.getByRole("button", { name: "창 최대화" }));
  fireEvent.click(screen.getByRole("button", { name: "앱 닫기" }));
  await waitFor(() => expect(controls.close).toHaveBeenCalledTimes(1));
  expect(controls.minimize).toHaveBeenCalledTimes(1);
  expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);
});
it("syncs maximize and restore icons with native window state", async () => {
  let resized = () => {};
  const stop = vi.fn();
  controls.onResized.mockImplementationOnce(async (callback) => {
    resized = callback;
    return stop;
  });
  const view = render(<TitleBar />);
  await waitFor(() => expect(controls.onResized).toHaveBeenCalled());
  controls.isMaximized.mockResolvedValueOnce(true);
  await act(async () => resized());
  expect(
    screen.getByRole("button", { name: "이전 크기로 복원" }).querySelector(".lucide-copy"),
  ).toBeTruthy();
  controls.isMaximized.mockResolvedValueOnce(false);
  await act(async () => resized());
  expect(
    screen.getByRole("button", { name: "창 최대화" }).querySelector(".lucide-square"),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "앱 닫기" }).querySelector("svg")?.getAttribute("width"),
  ).toBe("22");
  view.unmount();
  expect(stop).toHaveBeenCalledOnce();
});
