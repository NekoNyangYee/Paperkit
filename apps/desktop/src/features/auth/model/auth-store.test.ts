import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  approve: vi.fn(),
  auth: {
    onAuthStateChange: vi.fn(),
    refreshSession: vi.fn(),
    getSession: vi.fn(),
    signInWithOAuth: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    startAutoRefresh: vi.fn(),
    stopAutoRefresh: vi.fn(),
    signOut: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/shared/desktop/app-exit", () => ({ approveAppExit: mocks.approve }));
vi.mock("@/shared/desktop/files", () => ({ isDesktop: () => true }));
vi.mock("@/features/auth/lib/client", () => ({
  authConfig: { project: "https://project.supabase.co", key: "sb_publishable_test" },
  supabase: { auth: mocks.auth },
  setExchangeSignal: vi.fn(),
}));
const session = {
  access_token: "user-access-token",
  refresh_token: "user-refresh-token",
  user: { id: "11111111-1111-4111-8111-111111111111", email: "user@example.com" },
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.approve.mockReset().mockResolvedValue(true);
  mocks.invoke.mockResolvedValue(null);
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.auth.signInWithOAuth.mockResolvedValue({
    data: {
      url: "https://project.supabase.co/auth/v1/authorize?provider=google&code_challenge=test",
    },
    error: null,
  });
  mocks.auth.exchangeCodeForSession.mockResolvedValue({ data: { session }, error: null });
  mocks.auth.refreshSession.mockResolvedValue({ data: { session }, error: null });
  mocks.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mocks.auth.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  mocks.auth.signOut.mockResolvedValue({ error: null });
});

it("opens the system browser and exchanges the native callback code using PKCE", async () => {
  const store = await import("./auth-store");
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "begin_google_login")
      return { id: "attempt-a", redirectUrl: "http://127.0.0.1:49100/auth/callback/attempt-a" };
    if (command === "finish_google_login") return "authorization-code";
    return null;
  });
  await store.signInWithGoogle();
  expect(mocks.auth.signInWithOAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "google",
      options: expect.objectContaining({
        skipBrowserRedirect: true,
        redirectTo: "http://127.0.0.1:49100/auth/callback/attempt-a",
      }),
    }),
  );
  expect(mocks.openUrl).toHaveBeenCalledWith(
    expect.stringContaining("https://project.supabase.co/auth/v1/authorize"),
  );
  expect(mocks.auth.exchangeCodeForSession).toHaveBeenCalledWith("authorization-code");
  expect(store.useAuthStore.getState().session?.user.id).toBe(session.user.id);
  expect(store.useAuthStore.getState().busy).toBe(false);
});

it("restores from the OS credential and queues rotated refresh tokens without storing access tokens", async () => {
  let changed = (_event: string, _session: unknown) => {};
  mocks.auth.onAuthStateChange.mockImplementation((callback) => {
    changed = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "read_auth_refresh_token" ? "stored-refresh" : null,
  );
  const store = await import("./auth-store");
  await store.initializeAuth();
  expect(mocks.auth.refreshSession).toHaveBeenCalledWith({ refresh_token: "stored-refresh" });
  changed("TOKEN_REFRESHED", session);
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("write_auth_refresh_token", {
      project: "https://project.supabase.co",
      refreshToken: "user-refresh-token",
    }),
  );
  expect(
    mocks.invoke.mock.calls.some((call) => JSON.stringify(call).includes("user-access-token")),
  ).toBe(false);
});

it("a canceled attempt cannot cancel a newer login when its old callback finishes late", async () => {
  const callbacks: Record<string, (value: string) => void> = {};
  let count = 0;
  mocks.invoke.mockImplementation((command: string, args?: { id: string }) => {
    if (command === "begin_google_login") {
      const id = `attempt-${++count}`;
      return Promise.resolve({ id, redirectUrl: `http://127.0.0.1:49100/auth/callback/${id}` });
    }
    if (command === "finish_google_login")
      return new Promise<string>((resolve) => {
        callbacks[args!.id] = resolve;
      });
    return Promise.resolve(null);
  });
  const store = await import("./auth-store");
  const first = store.signInWithGoogle();
  await vi.waitFor(() => expect(callbacks["attempt-1"]).toBeTypeOf("function"));
  await store.cancelGoogleLogin();
  const second = store.signInWithGoogle();
  await vi.waitFor(() => expect(callbacks["attempt-2"]).toBeTypeOf("function"));
  callbacks["attempt-1"]("old-code");
  await first;
  expect(mocks.invoke).not.toHaveBeenCalledWith("cancel_google_login", { id: "attempt-2" });
  expect(store.useAuthStore.getState().busy).toBe(true);
  callbacks["attempt-2"]("new-code");
  await second;
  expect(mocks.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  expect(mocks.auth.exchangeCodeForSession).toHaveBeenCalledWith("new-code");
});

it("sign-out clears local credentials even when the auth network request fails", async () => {
  const store = await import("./auth-store");
  store.useAuthStore.setState({ session: session as never });
  mocks.auth.signOut.mockRejectedValue(new Error("network unavailable"));
  await store.signOut();
  expect(store.useAuthStore.getState().session).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("write_auth_refresh_token", {
    project: "https://project.supabase.co",
    refreshToken: null,
  });
});

it("reuses an existing SDK session during a development restore instead of rotating the OS token again", async () => {
  mocks.auth.getSession.mockResolvedValue({ data: { session }, error: null });
  const store = await import("./auth-store");
  await store.initializeAuth();
  expect(store.useAuthStore.getState().session?.user.id).toBe(session.user.id);
  expect(mocks.auth.refreshSession).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalledWith("read_auth_refresh_token", expect.anything());
  expect(mocks.auth.startAutoRefresh).toHaveBeenCalled();
});

it("keeps the account and credentials if the user cancels the unsaved-work guard on logout", async () => {
  const store = await import("./auth-store");
  store.useAuthStore.setState({ ready: true, session: session as never });
  mocks.approve.mockResolvedValueOnce(false);
  await store.signOut();
  expect(store.useAuthStore.getState().session).toEqual(session);
  expect(store.useAuthStore.getState().busy).toBe(false);
  expect(mocks.auth.signOut).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("does not begin login if the guest cancels the unsaved-work guard", async () => {
  const store = await import("./auth-store");
  mocks.approve.mockResolvedValueOnce(false);
  await store.signInWithGoogle();
  expect(mocks.auth.signInWithOAuth).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(store.useAuthStore.getState().busy).toBe(false);
});

it("freezes editing while logout is waiting for the unsaved-work guard", async () => {
  const store = await import("./auth-store");
  store.useAuthStore.setState({ ready: true, session: session as never });
  let finish!: (approved: boolean) => void;
  mocks.approve.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = store.signOut();
  expect(store.useAuthStore.getState().busy).toBe(true);
  finish(false);
  await pending;
  expect(store.useAuthStore.getState().busy).toBe(false);
  expect(store.useAuthStore.getState().session).toEqual(session);
});

it("rotates the current account's token without guarding and ignores another account's refresh event", async () => {
  const store = await import("./auth-store");
  mocks.auth.getSession.mockResolvedValue({ data: { session }, error: null });
  await store.initializeAuth();
  const changed = mocks.auth.onAuthStateChange.mock.calls.at(-1)![0];
  changed("TOKEN_REFRESHED", { ...session, access_token: "rotated" });
  await vi.waitFor(() =>
    expect(store.useAuthStore.getState().session?.access_token).toBe("rotated"),
  );
  changed("TOKEN_REFRESHED", { ...session, user: { id: "another-user" } });
  expect(store.useAuthStore.getState().session?.user.id).toBe(session.user.id);
  expect(mocks.approve).not.toHaveBeenCalled();
});
