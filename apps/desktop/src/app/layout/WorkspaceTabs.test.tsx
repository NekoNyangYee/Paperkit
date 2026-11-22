import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/shared/desktop/workspace", () => ({ writeWorkspace: async () => {} }));
vi.mock("@/shared/desktop/files", () => ({ closeFile: async () => {}, isDesktop: () => true }));
import { useFileStore } from "@/features/file-input/model/file-store";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { useAuthStore } from "@/features/auth/model/auth-store";

beforeEach(() => {
  useAuthStore.setState({ session: { user: { id: "owner" } } as never });
  useFileStore.setState({
    ...useFileStore.getInitialState(),
    ready: true,
    scopeOwner: "owner",
    activeTabId: "a",
    tabs: [
      { id: "a", file: { id: "file-a", name: "a.pdf", path: "a.pdf", sizeBytes: 100 } },
      { id: "b", file: { id: "file-b", name: "b.pdf", path: "b.pdf", sizeBytes: 100 } },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps one guest tab and explains the login requirement for both entry points", () => {
  useAuthStore.setState({ session: null });
  useFileStore.setState({ scopeOwner: null, tabs: [{ id: "a", file: null }] });
  render(<WorkspaceTabs />);
  fireEvent.click(screen.getByRole("button", { name: "새 탭" }));
  expect(screen.getByRole("button", { name: "Google로 로그인" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  fireEvent.keyDown(window, { ctrlKey: true, key: "t" });
  expect(useFileStore.getState().tabs).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "로그인이 필요합니다" })).toBeTruthy();
});
it("adds, switches and closes tabs with keyboard shortcuts", async () => {
  render(<WorkspaceTabs />);
  fireEvent.keyDown(window, { ctrlKey: true, key: "Tab" });
  expect(screen.getByRole("tab", { name: "b.pdf" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: "Tab" });
  expect(useFileStore.getState().activeTabId).toBe("a");
  fireEvent.keyDown(window, { ctrlKey: true, key: "t" });
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  await act(async () => {
    fireEvent.keyDown(window, { ctrlKey: true, key: "w" });
  });
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(useFileStore.getState().activeTabId).toBe("b");
});
it("closes the requested tab without activating it or beginning a drag", async () => {
  render(<WorkspaceTabs />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "b.pdf 탭 종료" }));
  });
  expect(useFileStore.getState().tabs.map((tab) => tab.id)).toEqual(["a"]);
  expect(useFileStore.getState().activeTabId).toBe("a");
});

it("closes the background tab addressed by its context menu", async () => {
  render(<WorkspaceTabs />);
  fireEvent.contextMenu(screen.getByRole("tab", { name: "b.pdf" }));
  const item = await screen.findByRole("menuitem", { name: "탭 종료" });
  expect(useFileStore.getState().activeTabId).toBe("a");
  await act(async () => fireEvent.click(item));
  expect(useFileStore.getState().tabs.map((tab) => tab.id)).toEqual(["a"]);
});
it("supports accessible arrow navigation and keyboard reordering", () => {
  render(<WorkspaceTabs />);
  fireEvent.keyDown(screen.getByRole("tab", { name: "a.pdf" }), { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "b.pdf" }));
  fireEvent.keyDown(screen.getByRole("tab", { name: "b.pdf" }), {
    key: "ArrowLeft",
    altKey: true,
    shiftKey: true,
  });
  expect(useFileStore.getState().tabs.map((tab) => tab.id)).toEqual(["b", "a"]);
  expect(useFileStore.getState().activeTabId).toBe("b");
});
