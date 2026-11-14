import { expect, it, vi } from "vitest";
import { PreviewCache } from "./preview-cache";
import type { PreviewPage } from "./types";

const page = (fileId = "a", pageIndex = 0): PreviewPage => ({
  fileId,
  pageIndex,
  pageCount: 3,
  width: 10,
  height: 10,
  imageUrl: "data:image/png;base64,AA==",
  text: { objects: [], warning: null },
  state: { revision: 0, dirty: false, canUndo: false, canRedo: false },
});
const state = { revision: 1, dirty: true, canUndo: true, canRedo: false };
const put = (cache: PreviewCache, fileId = "a", index = 0, width = 1600) =>
  cache.load(fileId, index, width, async () => ({ page: page(fileId, index) }));

it("shares in-flight page loads and synchronously returns complete cached pages", async () => {
  const cache = new PreviewCache();
  const read = vi.fn(async () => ({ page: page() }));
  const first = cache.load("a", 0, 1600, read);
  const second = cache.load("a", 0, 1600, read);
  expect(first).toBe(second);
  expect(cache.get("a", 0, 1600)).toBeUndefined();
  await first;
  expect(cache.get("a", 0, 1600)?.page).toEqual(page());
  await cache.load("a", 0, 1600, read);
  expect(read).toHaveBeenCalledOnce();
  expect(cache.get("b", 0, 1600)).toBeUndefined();
  expect(cache.get("a", 0, 300)).toBeUndefined();
});

it("invalidates an edited page while preserving other bitmaps with current revision and history", async () => {
  const cache = new PreviewCache();
  await put(cache);
  await put(cache, "a", 1);
  await put(cache, "b");
  const previous = cache.get("a", 1, 1600)!;
  cache.applyEdit("a", { kind: "replace", page: 0, object: 0, text: "changed" }, state);
  expect(cache.get("a", 0, 1600)).toBeUndefined();
  expect(cache.get("a", 1, 1600)?.page.text).toBe(previous.page.text);
  expect(cache.get("a", 1, 1600)?.page.state).toEqual(state);
  expect(cache.get("b", 0, 1600)?.page.state.revision).toBe(0);
  expect((await put(cache, "a", 1)).page.state).toEqual(state);
});

it.each(["undo", "redo", "page", "addWatermark", "removeWatermark"] as const)(
  "clears document pages for %s which can affect page order or global content",
  async (kind) => {
    const cache = new PreviewCache();
    await put(cache);
    await put(cache, "a", 1);
    const action =
      kind === "page"
        ? { kind, operation: "delete" as const, page: 0 }
        : kind === "addWatermark"
          ? { kind, page: null, png: [1], widthRatio: 0.5 }
          : kind === "removeWatermark"
            ? { kind, page: null }
            : { kind };
    cache.applyEdit("a", action, state);
    expect(cache.get("a", 0, 1600)).toBeUndefined();
    expect(cache.get("a", 1, 1600)).toBeUndefined();
  },
);

it("keeps decoded images after save but updates the dirty and history state", async () => {
  const cache = new PreviewCache();
  const value = await put(cache);
  const saved = { ...state, dirty: false };
  cache.applyEdit("a", { kind: "save", path: "saved.pdf" }, saved);
  expect(cache.get("a", 0, 1600)?.page.text).toBe(value.page.text);
  expect(cache.get("a", 0, 1600)?.page.state).toEqual(saved);
});

it("does not resurrect a page when a render completes after close or invalidation", async () => {
  const cache = new PreviewCache();
  let finish!: (value: { page: PreviewPage }) => void;
  const pending = cache.load(
    "a",
    0,
    1600,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  cache.clearFile("a");
  const fresh = await put(cache);
  finish({ page: { ...page(), imageUrl: "data:image/png;base64,OLD" } });
  await pending;
  expect(cache.get("a", 0, 1600)).toBe(fresh);
});

it("does not cache rejected native loads or image decode failures", async () => {
  const cache = new PreviewCache();
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("decode failed"))
    .mockResolvedValueOnce({ page: page() });
  await expect(cache.load("a", 0, 1600, read)).rejects.toThrow("decode failed");
  expect(cache.get("a", 0, 1600)).toBeUndefined();
  await cache.load("a", 0, 1600, read);
  expect(read).toHaveBeenCalledTimes(2);
});

it("evicts least recently used pages and enforces both count and decoded-memory limits", async () => {
  const cache = new PreviewCache(10_000, 2);
  await put(cache, "a", 0);
  await put(cache, "a", 1);
  cache.get("a", 0, 1600);
  await put(cache, "a", 2);
  expect(cache.get("a", 1, 1600)).toBeUndefined();
  expect(cache.get("a", 0, 1600)).toBeTruthy();
  const bounded = new PreviewCache(100, 32);
  await put(bounded);
  expect(bounded.get("a", 0, 1600)).toBeUndefined();
});
