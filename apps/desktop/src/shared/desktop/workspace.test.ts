import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), get: vi.fn(), set: vi.fn(), save: vi.fn() }));
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
  mocks.load.mockResolvedValue({ get: mocks.get, set: mocks.set, save: mocks.save });
  mocks.get.mockResolvedValue(first);
  expect(await readWorkspace()).toEqual(first);
  expect(mocks.load).toHaveBeenCalledWith("workspace.json", { autoSave: 150 });
  let finish!: () => void;
  mocks.set.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const writingFirst = writeWorkspace(first);
  const writingSecond = writeWorkspace(second);
  await vi.waitFor(() => expect(mocks.set).toHaveBeenCalledTimes(1));
  finish();
  await Promise.all([writingFirst, writingSecond]);
  expect(mocks.set.mock.calls.map((call) => call[1])).toEqual([first, second]);
  mocks.set.mockRejectedValueOnce(new Error("disk full"));
  await expect(writeWorkspace(first)).rejects.toThrow("disk full");
  await writeWorkspace(second);
  await flushWorkspace();
  expect(mocks.save).toHaveBeenCalledTimes(1);
});
