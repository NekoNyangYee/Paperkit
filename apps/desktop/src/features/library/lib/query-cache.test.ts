import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/features/auth/lib/client", () => ({ supabase: null, authConfig: null }));
import { useAuthStore } from "@/features/auth/model/auth-store";
import { captureAccount, accountIsCurrent } from "@/features/auth/lib/account-scope";
import { cachedLibraryRead, cacheTools, invalidateLibrary, libraryQueries } from "./query-cache";

const login = (owner: string | null, token = "test-token") =>
  useAuthStore.setState({
    ready: true,
    session: owner ? ({ user: { id: owner }, access_token: token } as never) : null,
  });
beforeEach(() => {
  login(null);
  login("a");
  libraryQueries.clear();
});
afterEach(() => {
  libraryQueries.clear();
  vi.restoreAllMocks();
});

it("shares concurrent reads and fresh cached reads, including after a token rotation", async () => {
  let finish!: (value: string[]) => void;
  const read = vi.fn(
    () =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  const first = cachedLibraryRead("a", "tools", "", read);
  const second = cachedLibraryRead("a", "tools", "", read);
  expect(read).toHaveBeenCalledOnce();
  finish(["tool-a"]);
  expect(await Promise.all([first, second])).toEqual([["tool-a"], ["tool-a"]]);
  login("a", "rotated-token");
  expect(await cachedLibraryRead("a", "tools", "", read)).toEqual(["tool-a"]);
  expect(read).toHaveBeenCalledOnce();
});

it("refreshes after sixty seconds, explicit invalidation, and uses separate filter keys", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const read = vi.fn().mockResolvedValue(["document"]);
  await cachedLibraryRead("a", "documents", "favorites=false", read);
  clock.mockReturnValue(69_999);
  await cachedLibraryRead("a", "documents", "favorites=false", read);
  expect(read).toHaveBeenCalledOnce();
  clock.mockReturnValue(70_001);
  await cachedLibraryRead("a", "documents", "favorites=false", read);
  await cachedLibraryRead("a", "documents", "favorites=true", read);
  expect(read).toHaveBeenCalledTimes(3);
  invalidateLibrary("a", "documents");
  await cachedLibraryRead("a", "documents", "favorites=false", read);
  expect(read).toHaveBeenCalledTimes(4);
});

it("does not retain errors or add automatic retries", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
  await expect(cachedLibraryRead("a", "tools", "", read)).rejects.toThrow("offline");
  expect(read).toHaveBeenCalledOnce();
  await expect(cachedLibraryRead("a", "tools", "", read)).resolves.toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
});

it("aborts and discards a late response even after returning to the same account", async () => {
  let finish!: (value: string[]) => void;
  let signal!: AbortSignal;
  const read = vi.fn((value: AbortSignal) => {
    signal = value;
    return new Promise<string[]>((resolve) => {
      finish = resolve;
    });
  });
  const scope = captureAccount("a");
  const pending = cachedLibraryRead("a", "tools", "", read);
  const rejected = expect(pending).rejects.toThrow();
  login("b");
  login("a");
  expect(signal.aborted).toBe(true);
  expect(accountIsCurrent(scope)).toBe(false);
  finish(["late-private-data"]);
  await rejected;
  expect(libraryQueries.getQueryCache().getAll()).toHaveLength(0);
  const fresh = vi.fn().mockResolvedValue(["new-data"]);
  expect(await cachedLibraryRead("a", "tools", "", fresh)).toEqual(["new-data"]);
});

it("clears cached account data on logout and refuses guest reads", async () => {
  await cachedLibraryRead("a", "tools", "", async () => ["private"]);
  login(null);
  expect(libraryQueries.getQueryCache().getAll()).toHaveLength(0);
  const read = vi.fn();
  await expect(cachedLibraryRead("a", "tools", "", read)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it("cannot cache an in-flight list from before a successful mutation", async () => {
  let finish!: (value: string[]) => void;
  const pending = cachedLibraryRead(
    "a",
    "tools",
    "",
    () =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = expect(pending).rejects.toThrow();
  invalidateLibrary("a", "tools");
  const fresh = cachedLibraryRead("a", "tools", "", async () => ["updated"]);
  finish(["outdated"]);
  await rejected;
  expect(await fresh).toEqual(["updated"]);
  expect(await cachedLibraryRead("a", "tools", "", vi.fn())).toEqual(["updated"]);
});

it("bounds cached search variants", async () => {
  for (let i = 0; i < 70; i++) await cachedLibraryRead("a", "documents", `q=${i}`, async () => []);
  expect(libraryQueries.getQueryCache().getAll()).toHaveLength(64);
});

it("does not cache a partial tool list before the initial list has been read", async () => {
  cacheTools("a", []);
  const read = vi.fn().mockResolvedValue(["existing-server-tool"]);
  expect(await cachedLibraryRead("a", "tools", "", read)).toEqual(["existing-server-tool"]);
  expect(read).toHaveBeenCalledOnce();
  cacheTools("a", []);
  expect(await cachedLibraryRead("a", "tools", "", read)).toEqual([]);
  expect(read).toHaveBeenCalledOnce();
});
