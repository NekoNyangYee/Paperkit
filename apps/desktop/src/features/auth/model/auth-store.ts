import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isDesktop } from "@/shared/desktop/files";
import { authConfig, setExchangeSignal, supabase } from "@/features/auth/lib/client";

interface AuthState {
  session: Session | null;
  ready: boolean;
  busy: boolean;
  signingIn: boolean;
  error: string | null;
  storageError: string | null;
  dismissError: () => void;
}
export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  ready: !supabase,
  busy: false,
  signingIn: false,
  error: null,
  storageError: null,
  dismissError: () => set({ error: null, storageError: null }),
}));

let initialization: Promise<void> | undefined;
let nativeLogin: { id: string; redirectUrl: string } | null = null;
let attempt = 0;
let storageWrites = Promise.resolve();
let exchangeController: AbortController | null = null;

function persistRefreshToken(token: string | null) {
  if (!isDesktop() || !authConfig) return Promise.resolve();
  storageWrites = storageWrites
    .catch(() => {})
    .then(async () => {
      await invoke("write_auth_refresh_token", {
        project: authConfig!.project,
        refreshToken: token,
      });
      useAuthStore.setState({ storageError: null });
    })
    .catch(() => {
      useAuthStore.setState({
        storageError: token
          ? "로그인 정보를 안전하게 저장하지 못했습니다. 앱을 다시 열면 재로그인이 필요할 수 있습니다."
          : "저장된 로그인 정보를 지우지 못했습니다. Windows 자격 증명 관리자를 확인해 주세요.",
      });
    });
  return storageWrites;
}

export function initializeAuth() {
  return (initialization ??= (async () => {
    if (!supabase || !authConfig) return;
    supabase.auth.onAuthStateChange((event, session) => {
      useAuthStore.setState({ session });
      // Do not clear the OS credential when the in-memory SDK initially starts empty.
      if (event !== "INITIAL_SESSION") void persistRefreshToken(session?.refresh_token ?? null);
    });
    try {
      if (isDesktop()) {
        const refreshToken = await invoke<string | null>("read_auth_refresh_token", {
          project: authConfig.project,
        });
        if (refreshToken) {
          const { data, error } = await supabase.auth.refreshSession({
            refresh_token: refreshToken,
          });
          if (error) {
            if ([400, 401, 403].includes(error.status ?? 0)) await persistRefreshToken(null);
            useAuthStore.setState({
              error: "로그인을 복원하지 못했습니다. 연결을 확인하거나 다시 로그인해 주세요.",
            });
          } else useAuthStore.setState({ session: data.session });
        }
      } else {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        useAuthStore.setState({ session: data.session });
      }
    } catch {
      useAuthStore.setState({
        error: "저장된 로그인을 확인하지 못했습니다. 다시 로그인해 주세요.",
      });
    } finally {
      useAuthStore.setState({ ready: true });
    }
  })());
}

export async function signInWithGoogle() {
  if (useAuthStore.getState().busy) return;
  if (!supabase || !authConfig) {
    useAuthStore.setState({ error: "로그인을 준비하지 못했습니다. 앱을 다시 실행해 주세요." });
    return;
  }
  const current = ++attempt;
  let challengeId: string | null = null;
  useAuthStore.setState({ busy: true, signingIn: true, error: null });
  void supabase.auth.startAutoRefresh();
  try {
    if (!isDesktop()) {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/`,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
      return;
    }
    const challenge = await invoke<{ id: string; redirectUrl: string }>("begin_google_login");
    challengeId = challenge.id;
    if (current !== attempt) return;
    nativeLogin = challenge;
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: challenge.redirectUrl,
        skipBrowserRedirect: true,
        queryParams: { prompt: "select_account" },
      },
    });
    if (current !== attempt) return;
    if (error || !data.url) throw error ?? new Error("Missing login URL");
    const authorize = new URL(data.url);
    if (authorize.origin !== authConfig.project || authorize.pathname !== "/auth/v1/authorize")
      throw new Error("Unexpected login URL");
    const callback = invoke<string>("finish_google_login", { id: challenge.id }).then(
      (code) => ({ code, error: null }),
      (error: unknown) => ({ code: null, error }),
    );
    await openUrl(data.url);
    const result = await callback;
    if (current !== attempt) return;
    if (result.error || !result.code) throw result.error ?? new Error("Missing code");
    const controller = new AbortController();
    exchangeController = controller;
    setExchangeSignal(controller.signal);
    const exchanged = await supabase.auth.exchangeCodeForSession(result.code);
    if (exchanged.error || !exchanged.data.session)
      throw exchanged.error ?? new Error("Missing session");
    if (current === attempt) useAuthStore.setState({ session: exchanged.data.session });
  } catch {
    if (current === attempt)
      useAuthStore.setState({
        error:
          "Google 로그인을 완료하지 못했습니다. 브라우저에서 로그인을 마친 뒤 다시 시도해 주세요.",
      });
  } finally {
    if (challengeId) await invoke("cancel_google_login", { id: challengeId }).catch(() => {});
    if (nativeLogin?.id === challengeId) nativeLogin = null;
    if (current === attempt) {
      nativeLogin = null;
      exchangeController = null;
      setExchangeSignal();
      useAuthStore.setState({ busy: false, signingIn: false });
    }
  }
}

export async function cancelGoogleLogin() {
  if (!useAuthStore.getState().signingIn) return;
  ++attempt;
  exchangeController?.abort();
  exchangeController = null;
  setExchangeSignal();
  const pending = nativeLogin;
  nativeLogin = null;
  useAuthStore.setState({ busy: false, signingIn: false, error: null });
  if (pending) await invoke("cancel_google_login", { id: pending.id }).catch(() => {});
}

export async function signOut() {
  if (!supabase || useAuthStore.getState().busy) return;
  await cancelGoogleLogin();
  useAuthStore.setState({ busy: true, error: null });
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    /* Local state and OS credentials are still removed below. */
  } finally {
    void supabase.auth.stopAutoRefresh();
    useAuthStore.setState({ session: null });
    await persistRefreshToken(null);
    useAuthStore.setState({ busy: false });
  }
}
