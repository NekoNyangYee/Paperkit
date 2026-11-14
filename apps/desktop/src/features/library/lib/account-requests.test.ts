import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), refresh: vi.fn() }));
vi.mock("@/features/auth/lib/client", () => ({
  authConfig: { api: "http://127.0.0.1:18081" },
  supabase: { auth: { getSession: mocks.session, refreshSession: mocks.refresh } },
}));
import { useAuthStore } from "@/features/auth/model/auth-store";
import { libraryRequest } from "./api";

const session = (owner: string, token = owner) => ({
  user: { id: owner },
  access_token: token,
  refresh_token: `refresh-${token}`,
});
const login = (owner: string | null, token?: string) =>
  useAuthStore.setState({
    ready: true,
    session: owner ? (session(owner, token) as never) : null,
  });
beforeEach(() => {
  login(null);
  login("a");
  mocks.session.mockReset().mockResolvedValue({ data: { session: session("a") }, error: null });
  mocks.refresh.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it("refuses an SDK session that completed after switching away and back to its account", async () => {
  let finish!: (value: unknown) => void;
  mocks.session.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const pending = libraryRequest("/library/tools", {}, "a");
  const rejected = expect(pending).rejects.toThrow();
  login("b");
  login("a", "new-a");
  finish({ data: { session: session("a", "old-a") }, error: null });
  await rejected;
  expect(fetch).not.toHaveBeenCalled();
  expect(useAuthStore.getState().session?.access_token).toBe("new-a");
});

it("aborts a dispatched request and refuses its late response across an account change", async () => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const pending = libraryRequest("/library/tools", {}, "a");
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const options = fetch.mock.calls[0] as unknown as [string, RequestInit];
  login("b");
  login("a", "new-a");
  expect(options[1].signal?.aborted).toBe(true);
  finish(new Response(JSON.stringify(["private-old-a"])));
  await rejected;
});

it("does not replay an authorized write after account scope changes during token refresh", async () => {
  let finish!: (value: unknown) => void;
  mocks.refresh.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  const pending = libraryRequest("/library/tools", { method: "POST", body: "{}" }, "a");
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  login("b");
  login("a", "new-a");
  finish({ data: { session: session("a", "old-refreshed") }, error: null });
  await rejected;
  expect(fetch).toHaveBeenCalledOnce();
  expect(useAuthStore.getState().session?.access_token).toBe("new-a");
});
