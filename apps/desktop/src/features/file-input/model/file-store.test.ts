import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock("@/shared/desktop/files", () => ({
  isDesktop: () => true,
  errorMessage: (cause: unknown) => String(cause),
  synchronizeSelection: async () => ({ revision: 1, file: null, error: null }),
  inspectFile: mocks.inspect,
  clearSelection: vi.fn(),
  closeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/shared/desktop/workspace", () => ({
  readWorkspace: mocks.read,
  writeWorkspace: mocks.write,
}));
import { registerTabCloseGuard, useFileStore } from "./file-store";
const file = (path: string, revision: number) => ({
  id: `file-${revision}`,
  path,
  name: path,
  sizeBytes: 100,
});
beforeEach(() => {
  useFileStore.setState(useFileStore.getInitialState());
  mocks.read.mockReset().mockResolvedValue(null);
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.inspect.mockReset().mockImplementation(async ([path], revision) => ({
    revision,
    file: file(path, revision),
    error: null,
  }));
});
it("keeps independent documents and views, and focuses an already-open file", async () => {
  await useFileStore.getState().initialize();
  await useFileStore.getState().receive(["a.pdf"]);
  const first = useFileStore.getState().tabs[0];
  useFileStore
    .getState()
    .updateView(first.file!.id, { pageIndex: 3, zoom: 150, sidebarOpen: false });
  await useFileStore.getState().replaceFile(["b.pdf"]);
  expect(useFileStore.getState().tabs).toHaveLength(2);
  expect(useFileStore.getState().file?.path).toBe("b.pdf");
  await useFileStore.getState().receive(["a.pdf"]);
  expect(useFileStore.getState().tabs).toHaveLength(2);
  expect(useFileStore.getState().file?.id).toBe(first.file!.id);
  expect(useFileStore.getState().tabs[0].view).toEqual({
    pageIndex: 3,
    zoom: 150,
    sidebarOpen: false,
  });
  expect(mocks.write).toHaveBeenLastCalledWith(
    expect.objectContaining({
      activeTabId: first.id,
      tabs: [
        { id: first.id, path: "a.pdf", view: { pageIndex: 3, zoom: 150, sidebarOpen: false } },
        expect.objectContaining({ path: "b.pdf" }),
      ],
    }),
  );
});
it("preserves a cancelled dirty tab and always leaves an empty tab after the last close", async () => {
  await useFileStore.getState().initialize();
  await useFileStore.getState().receive(["a.pdf"]);
  const tab = useFileStore.getState().tabs[0];
  const guard = vi.fn().mockResolvedValue(false);
  const unregister = registerTabCloseGuard(tab.file!.id, guard);
  await useFileStore.getState().closeTab(tab.id);
  expect(useFileStore.getState().tabs[0]).toEqual(tab);
  guard.mockResolvedValue(true);
  await useFileStore.getState().closeTab(tab.id);
  expect(useFileStore.getState().tabs).toHaveLength(1);
  expect(useFileStore.getState().tabs[0].file).toBeNull();
  expect(useFileStore.getState().openedFileId).toBeNull();
  unregister();
});
it("reorders tabs without changing the active document and closes an inactive tab", async () => {
  await useFileStore.getState().initialize();
  await useFileStore.getState().receive(["a.pdf"]);
  await useFileStore.getState().receive(["b.pdf"]);
  const [first, second] = useFileStore.getState().tabs;
  useFileStore.getState().moveTab(second.id, first.id);
  expect(useFileStore.getState().tabs.map((tab) => tab.id)).toEqual([second.id, first.id]);
  await useFileStore.getState().closeTab(first.id);
  expect(useFileStore.getState().activeTabId).toBe(second.id);
  expect(useFileStore.getState().file?.path).toBe("b.pdf");
});
it("restores tab order, active tab and views through fresh native validation, skipping missing files", async () => {
  const view = { pageIndex: 2, zoom: 125, sidebarOpen: false };
  mocks.read.mockResolvedValue({
    version: 1,
    activeTabId: "second",
    tabs: [
      { id: "first", path: "a.pdf" },
      { id: "missing", path: "missing.pdf" },
      { id: "second", path: "b.pdf", view },
      { id: "blank", path: null },
    ],
  });
  mocks.inspect.mockImplementation(async ([path], revision) => {
    if (path === "missing.pdf") throw new Error("파일 없음");
    return { revision, file: file(path, revision), error: null };
  });
  await useFileStore.getState().initialize();
  expect(useFileStore.getState().tabs.map((tab) => tab.id)).toEqual(["first", "second", "blank"]);
  expect(useFileStore.getState().file?.path).toBe("b.pdf");
  expect(useFileStore.getState().tabs[1].view).toEqual(view);
  expect(useFileStore.getState().persistenceError).toContain("missing.pdf");
  expect(mocks.inspect.mock.calls.map((call) => call[1])).toEqual([2, 3, 4]);
  expect(mocks.write).not.toHaveBeenCalled();
});
it("retains the active tab when a native open error refers to a different last selection", async () => {
  await useFileStore.getState().initialize();
  await useFileStore.getState().receive(["a.pdf"]);
  const first = useFileStore.getState().tabs[0];
  await useFileStore.getState().receive(["b.pdf"]);
  useFileStore.getState().activateTab(first.id);
  mocks.inspect.mockImplementation(async (_, revision) => ({
    revision,
    file: file("b.pdf", 3),
    error: "잘못된 PDF",
  }));
  await useFileStore.getState().receive(["bad.pdf"]);
  expect(useFileStore.getState().file?.path).toBe("a.pdf");
  expect(useFileStore.getState().openedFileId).toBe(first.file!.id);
  expect(useFileStore.getState().error).toBe("잘못된 PDF");
});
it("continues opening files after a persistence failure and reports the failed write", async () => {
  await useFileStore.getState().initialize();
  mocks.write.mockRejectedValue(new Error("disk full"));
  await useFileStore.getState().receive(["a.pdf"]);
  expect(useFileStore.getState().file?.path).toBe("a.pdf");
  expect(useFileStore.getState().persistenceError).toContain("저장하지 못했습니다");
});
