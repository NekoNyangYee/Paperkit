import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { editorFont } from "./editor-font";
afterEach(() => vi.unstubAllGlobals());
it("shares a representative font request but keeps different embedded subsets separate", async () => {
  const add = vi.fn();
  Object.defineProperty(document, "fonts", { configurable: true, value: { add, delete: vi.fn() } });
  vi.stubGlobal(
    "FontFace",
    class {
      async load() {
        return this;
      }
    },
  );
  mocks.invoke.mockReset().mockResolvedValue("AAECAw==");
  const context = { fileId: "shared-font", revision: 0, pageIndex: 0, objectId: 4 };
  const families = await Promise.all(
    Array.from({ length: 50 }, () => editorFont("GulimChe", context)),
  );
  expect(new Set(families).size).toBe(1);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledTimes(1);
  expect(await editorFont("GulimChe", { ...context, objectId: 9 })).not.toBe(families[0]);
});
it("does not silently replace an unavailable bold face with bundled regular", async () => {
  vi.stubGlobal("FontFace", class {});
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn() },
  });
  mocks.invoke.mockReset().mockRejectedValue("원본 글꼴 없음");
  await expect(
    editorFont("Pretendard-Bold", {
      fileId: "missing-bold",
      revision: 0,
      pageIndex: 0,
      objectId: 2,
    }),
  ).rejects.toBe("원본 글꼴 없음");
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).not.toHaveBeenCalledWith("editor_font", expect.anything());
});
it("prefers embedded bytes even when the name matches a bundled font", async () => {
  mocks.invoke.mockReset().mockResolvedValue("AAECAw==");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn() },
  });
  vi.stubGlobal(
    "FontFace",
    class {
      async load() {
        return this;
      }
    },
  );
  const context = { fileId: "embedded-bold", revision: 0, pageIndex: 0, objectId: 1 };
  await editorFont("Pretendard-Bold", context);
  expect(mocks.invoke).toHaveBeenCalledWith("document_font", context);
  expect(mocks.invoke).not.toHaveBeenCalledWith("editor_font", expect.anything());
  mocks.invoke.mockReset();
});
it("loads the document's font bytes and separates identical object IDs across files", async () => {
  const add = vi.fn(),
    remove = vi.fn();
  Object.defineProperty(document, "fonts", { configurable: true, value: { add, delete: remove } });
  vi.stubGlobal(
    "FontFace",
    class {
      constructor(
        public family: string,
        public data: Uint8Array,
      ) {}
      async load() {
        return this;
      }
    },
  );
  mocks.invoke.mockResolvedValue("AAECAw==");
  const context = { fileId: "first", revision: 0, pageIndex: 0, objectId: 3 };
  const first = await editorFont("OriginalCustomFont", context);
  remove.mockClear(); // Ignore cleanup of font faces from an earlier document/test.
  expect(mocks.invoke).toHaveBeenCalledWith("document_font", context);
  expect(await editorFont("OriginalCustomFont", context)).toBe(first);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(await editorFont("OriginalCustomFont", { ...context, fileId: "second" })).not.toBe(first);
  expect(remove).not.toHaveBeenCalled();
  expect(await editorFont("OriginalCustomFont", context)).toBe(first);
  expect(add).toHaveBeenCalledTimes(2);
});
