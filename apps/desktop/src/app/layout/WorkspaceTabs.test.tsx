import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/shared/desktop/workspace", () => ({ writeWorkspace: async () => {} }));
vi.mock("@/shared/desktop/files", () => ({ closeFile: async () => {} }));
import { useFileStore } from "@/features/file-input/model/file-store";
import { WorkspaceTabs } from "./WorkspaceTabs";

beforeEach(() => {
  useFileStore.setState({
    ...useFileStore.getInitialState(),
    ready: true,
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
    fireEvent.click(screen.getByRole("button", { name: "b.pdf 탭 닫기" }));
  });
  expect(useFileStore.getState().tabs.map((tab) => tab.id)).toEqual(["a"]);
  expect(useFileStore.getState().activeTabId).toBe("a");
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
