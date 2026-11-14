import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isDesktop } from "@/shared/desktop/files";
import { authConfig, setExchangeSignal, supabase } from "@/features/auth/lib/client";
import { approveAppExit } from "@/shared/desktop/app-exit";

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
let authSubscription: { unsubscribe: () => void } | undefined;
let approvedOwner: string | null | undefined;
let identityRequest = 0;

async function approveIdentityChange() {
  try {
    if (!(await approveAppExit())) return false;
    approvedOwner = useAuthStore.getState().session?.user.id ?? null;
    return true;
  } catch {
    useAuthStore.setState({ error: "문서 작업을 마친 뒤 계정을 변경해 주세요." });
    return false;
  }
}

async function acceptSession(session: Session | null) {
  const state = useAuthStore.getState();
  const previous = state.session?.user.id ?? null;
  const next = session?.user.id ?? null;
  const managesBusy = previous !== next && state.ready && !state.busy;
  if (managesBusy) useAuthStore.setState({ busy: true });
  try {
    if (previous !== next) {
      const request = ++identityRequest;
      if (state.ready && approvedOwner !== previous && !(await approveIdentityChange())) {
        useAuthStore.setState({ error: "작업을 저장한 뒤 계정을 다시 변경해 주세요." });
        return false;
      }
      if (
        request !== identityRequest ||
        (useAuthStore.getState().session?.user.id ?? null) !== previous
      )
        return false;
    }
    useAuthStore.setState({ session });
    return true;
  } finally {
    if (managesBusy) {
      approvedOwner = undefined;
      useAuthStore.setState({ busy: false });
    }
  }
}

import.meta.hot?.dispose?.(() => authSubscription?.unsubscribe());

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
    const listener = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" && useAuthStore.getState().ready) return;
      if (
        event === "TOKEN_REFRESHED" &&
        useAuthStore.getState().ready &&
        session?.user.id !== useAuthStore.getState().session?.user.id
      )
        return;
      void acceptSession(session).then((accepted) => {
        if (accepted && event !== "INITIAL_SESSION")
          void persistRefreshToken(session?.refresh_token ?? null);
      });
    });
    authSubscription = listener.data.subscription;
    try {
      if (isDesktop()) {
        const current = await supabase.auth.getSession();
        if (current.error) throw current.error;
        if (current.data.session) {
          await acceptSession(current.data.session);
          return;
        }
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
          } else await acceptSession(data.session);
        }
      } else {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        await acceptSession(data.session);
      }
    } catch {
      useAuthStore.setState({
        error: "저장된 로그인을 확인하지 못했습니다. 다시 로그인해 주세요.",
      });
    } finally {
      if (useAuthStore.getState().session) void supabase.auth.startAutoRefresh();
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
    if (!(await approveIdentityChange())) return;
    if (current !== attempt) {
      if (!useAuthStore.getState().signingIn) approvedOwner = undefined;
      return;
    }
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
    if (current === attempt) await acceptSession(exchanged.data.session);
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
      approvedOwner = undefined;
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
  ++identityRequest;
  approvedOwner = undefined;
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
  useAuthStore.setState({ busy: true, error: null });
  let approved = false;
  try {
    approved = await approveIdentityChange();
    if (!approved) return;
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* Local state and OS credentials are still removed below. */
    }
  } finally {
    if (approved) {
      void supabase.auth.stopAutoRefresh();
      await acceptSession(null);
      await persistRefreshToken(null);
    }
    useAuthStore.setState({ busy: false });
    approvedOwner = undefined;
  }
}
