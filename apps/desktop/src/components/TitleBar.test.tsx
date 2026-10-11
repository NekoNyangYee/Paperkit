import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const controls = vi.hoisted(() => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => controls }));
vi.mock("./VersionDialog", () => ({ VersionDialog: () => <button>앱 정보</button> }));
import { TitleBar } from "./TitleBar";
afterEach(cleanup);
it("keeps app info outside the drag region and requests close without destroying the window", async () => {
  render(<TitleBar />);
  expect(screen.getByText("앱 정보").closest("[data-tauri-drag-region]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "창 최소화" }));
  fireEvent.click(screen.getByRole("button", { name: "창 최대화 / 복원" }));
  fireEvent.click(screen.getByRole("button", { name: "앱 닫기" }));
  await waitFor(() => expect(controls.close).toHaveBeenCalledTimes(1));
  expect(controls.minimize).toHaveBeenCalledTimes(1);
  expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);
});
