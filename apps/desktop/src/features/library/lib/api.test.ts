import { afterEach, beforeEach, expect, it, vi } from "vitest";
type TestSession = { access_token: string; refresh_token: string; user: { id: string } };
const mocks = vi.hoisted(() => ({
  owner: "owner-a" as string | undefined,
  uiSession: null as TestSession | null,
  sdkSession: null as TestSession | null,
  session: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/features/auth/lib/client", () => ({
  authConfig: { api: "http://127.0.0.1:18081" },
  supabase: { auth: { getSession: mocks.session, refreshSession: mocks.refresh } },
}));
vi.mock("@/features/auth/model/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      session: mocks.uiSession ? { ...mocks.uiSession, user: { id: mocks.owner } } : null,
    }),
    setState: (value: { session: TestSession | null }) => {
      mocks.uiSession = value.session;
      mocks.owner = value.session?.user.id;
    },
  },
  signOut: mocks.signOut,
}));
import { libraryRequest } from "./api";
import { errorFallbacks } from "@/shared/lib/errors";
beforeEach(() => {
  mocks.owner = "owner-a";
  mocks.uiSession = {
    user: { id: "owner-a" },
    access_token: "test-only",
    refresh_token: "test-refresh",
  };
  mocks.sdkSession = mocks.uiSession;
  mocks.session
    .mockReset()
    .mockImplementation(async () => ({ data: { session: mocks.sdkSession }, error: null }));
  mocks.refresh.mockReset().mockImplementation(async () => {
    mocks.sdkSession = {
      user: { id: "owner-a" },
      access_token: "renewed-test-token",
      refresh_token: "rotated-test-refresh",
    };
    return { data: { session: mocks.sdkSession }, error: null };
  });
  mocks.signOut.mockReset().mockImplementation(async () => {
    mocks.owner = undefined;
    mocks.uiSession = null;
    mocks.sdkSession = null;
  });
});
afterEach(() => vi.unstubAllGlobals());

it("retries a failed read once and returns the recovered list", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce({ ok: true, json: async () => [] });
  vi.stubGlobal("fetch", fetch);
  await expect(libraryRequest("/library/tools")).resolves.toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not replay a save after a connection failure", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("SQL network private-diagnostic"));
  vi.stubGlobal("fetch", fetch);
  await expect(libraryRequest("/library/tools", { method: "POST", body: "{}" })).rejects.toThrow(
    errorFallbacks.toolSave,
  );
  expect(fetch).toHaveBeenCalledOnce();
});
it("hides missing endpoints and malformed responses behind a usable fallback", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 404 })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < at /private/path");
      },
    });
  vi.stubGlobal("fetch", fetch);
  await expect(libraryRequest("/library/documents")).rejects.toThrow(errorFallbacks.library);
  await expect(libraryRequest("/library/tools")).rejects.toThrow(errorFallbacks.tools);
});
it("does not return a previous user's result after an account change", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => {
      mocks.owner = "owner-b";
      return { ok: true, json: async () => ["private-a"] };
    }),
  );
  await expect(libraryRequest("/library/tools")).rejects.toThrow("로그인을 다시 확인해 주세요.");
});

it("restores a missing SDK session through Auth while the account UI is still signed in", async () => {
  mocks.sdkSession = null;
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
  vi.stubGlobal("fetch", fetch);
  await expect(libraryRequest("/library/tools")).resolves.toEqual([]);
  expect(mocks.refresh).toHaveBeenCalledWith({ refresh_token: "test-refresh" });
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer renewed-test-token");
  expect(mocks.uiSession?.access_token).toBe("renewed-test-token");
});

it("refreshes once for simultaneous rejected requests and retries both with the new credential", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async (_url, options) =>
      options.headers.Authorization === "Bearer test-only"
        ? { ok: false, status: 401 }
        : { ok: true, status: 200, json: async () => [] },
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    Promise.all([libraryRequest("/library/tools"), libraryRequest("/library/documents")]),
  ).resolves.toEqual([[], []]);
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(
    fetch.mock.calls.filter(
      (call) => call[1].headers.Authorization === "Bearer renewed-test-token",
    ),
  ).toHaveLength(2);
});

it("keeps a signed-in account when refreshing is temporarily unavailable", async () => {
  mocks.refresh.mockResolvedValueOnce({ data: { session: null }, error: { status: 503 } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
  await expect(libraryRequest("/library/tools")).rejects.toThrow(
    "계정 연결을 잠시 확인할 수 없어요.",
  );
  expect(mocks.uiSession?.user.id).toBe("owner-a");
  expect(mocks.signOut).not.toHaveBeenCalled();
});

it("only clears the signed-in UI when Auth confirms that the refresh credential has expired", async () => {
  mocks.refresh.mockResolvedValueOnce({ data: { session: null }, error: { status: 400 } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
  await expect(libraryRequest("/library/tools")).rejects.toThrow("로그인 연결이 만료됐어요.");
  expect(mocks.signOut).toHaveBeenCalledOnce();
  expect(mocks.uiSession).toBeNull();
});

it("does not send old account requests after the account changes during refresh", async () => {
  mocks.sdkSession = null;
  mocks.refresh.mockImplementationOnce(async () => {
    mocks.owner = "owner-b";
    return {
      data: {
        session: { user: { id: "owner-a" }, access_token: "late-a", refresh_token: "late-refresh" },
      },
      error: null,
    };
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(libraryRequest("/library/tools")).rejects.toThrow(
    "계정 정보를 다시 확인하고 있어요.",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.owner).toBe("owner-b");
});

it("retries a write only after authorization rejected it before the handler ran", async () => {
  let writes = 0;
  const fetch = vi.fn().mockImplementation(async (_url, options) => {
    if (options.headers.Authorization === "Bearer test-only") return { ok: false, status: 401 };
    writes++;
    return { ok: true, status: 201, json: async () => ({ id: "saved-once" }) };
  });
  vi.stubGlobal("fetch", fetch);
  const input = {
    method: "POST",
    body: JSON.stringify({ name: "검토용", kind: "text", content: "test" }),
  };
  await expect(libraryRequest("/library/tools", input)).resolves.toEqual({ id: "saved-once" });
  expect(writes).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][1].body).toBe(input.body);
});
