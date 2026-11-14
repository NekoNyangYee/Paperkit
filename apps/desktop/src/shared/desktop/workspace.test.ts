import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("./files", () => ({ isDesktop: () => true }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: mocks.load }));
import { flushWorkspace, parseWorkspace, readWorkspace, writeWorkspace } from "./workspace";

it("validates persisted schema, duplicate IDs and view bounds", () => {
  expect(parseWorkspace({ version: 2, tabs: [], activeTabId: "x" })).toBeNull();
  expect(
    parseWorkspace({
      version: 1,
      activeTabId: "a",
      tabs: [
        { id: "a", path: "a.pdf", view: { pageIndex: 2, zoom: 125, sidebarOpen: false } },
        { id: "a", path: "duplicate.pdf" },
        { id: "bad", path: 123 },
        { id: "b", path: null, view: { pageIndex: -1, zoom: 0, sidebarOpen: true } },
      ],
    }),
  ).toEqual({
    version: 1,
    activeTabId: "a",
    tabs: [
      { id: "a", path: "a.pdf", view: { pageIndex: 2, zoom: 125, sidebarOpen: false } },
      { id: "b", path: null },
    ],
  });
});
it("uses Tauri Store, serializes writes, recovers after errors, and flushes on exit", async () => {
  const first = { version: 1 as const, activeTabId: "a", tabs: [{ id: "a", path: "a.pdf" }] };
  const second = { ...first, activeTabId: "b" };
  mocks.load.mockResolvedValue({
    get: mocks.get,
    set: mocks.set,
    save: mocks.save,
    delete: mocks.delete,
  });
  mocks.delete.mockResolvedValueOnce(true);
  mocks.get.mockResolvedValue({ owner: "owner-a", workspace: first });
  expect(await readWorkspace("owner-a")).toEqual(first);
  expect(mocks.get).toHaveBeenLastCalledWith("workspace:owner-a");
  expect(mocks.load).toHaveBeenCalledWith("workspace.json", { autoSave: 150 });
  expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("workspace");
  let finish!: () => void;
  mocks.set.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const writingFirst = writeWorkspace(first, "owner-a");
  const writingSecond = writeWorkspace(second, "owner-b");
  await vi.waitFor(() => expect(mocks.set).toHaveBeenCalledTimes(1));
  finish();
  await Promise.all([writingFirst, writingSecond]);
  expect(mocks.set.mock.calls).toEqual([
    ["workspace:owner-a", { owner: "owner-a", workspace: first }],
    ["workspace:owner-b", { owner: "owner-b", workspace: second }],
  ]);
  mocks.set.mockRejectedValueOnce(new Error("disk full"));
  await expect(writeWorkspace(first, "owner-a")).rejects.toThrow("disk full");
  await writeWorkspace(second, "owner-b");
  await flushWorkspace();
  expect(mocks.save).toHaveBeenCalledTimes(2);
});

it("does not restore or write a guest workspace and rejects mismatched ownership", async () => {
  mocks.get.mockClear();
  mocks.set.mockClear();
  expect(await readWorkspace(null)).toBeNull();
  await writeWorkspace(
    { version: 1, activeTabId: "guest", tabs: [{ id: "guest", path: "private.pdf" }] },
    null,
  );
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.set).not.toHaveBeenCalled();
  mocks.get.mockResolvedValue({
    owner: "owner-a",
    workspace: { version: 1, activeTabId: "a", tabs: [{ id: "a", path: "private.pdf" }] },
  });
  expect(await readWorkspace("owner-b")).toBeNull();
  expect(mocks.get).toHaveBeenLastCalledWith("workspace:owner-b");
});
