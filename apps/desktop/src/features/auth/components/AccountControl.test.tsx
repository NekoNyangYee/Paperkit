import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  state: {
    session: null as null | {
      user: {
        id: string;
        email: string;
        user_metadata?: { full_name: string; avatar_url: string };
      };
      access_token: string;
    },
    ready: true,
    busy: false,
    signingIn: false,
    error: null,
    storageError: null,
    dismissError: vi.fn(),
  },
  initialize: vi.fn(),
  login: vi.fn(),
  cancel: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("@/features/auth/lib/client", () => ({
  authConfig: { project: "https://project.supabase.co" },
}));
vi.mock("@/features/about/components/VersionDialog", () => ({
  VersionDialog: ({ open }: { open?: boolean }) =>
    open ? <div role="dialog" aria-label="앱 정보 창" /> : null,
}));
vi.mock("@/features/auth/model/auth-store", () => ({
  useAuthStore: () => mocks.state,
  initializeAuth: mocks.initialize,
  signInWithGoogle: mocks.login,
  cancelGoogleLogin: mocks.cancel,
  signOut: mocks.logout,
}));
import { AccountControl } from "./AccountControl";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.session = null;
  mocks.state.busy = false;
  mocks.state.signingIn = false;
});
afterEach(cleanup);

it("opens app info from the left side of the account footer", () => {
  render(<AccountControl />);
  expect(screen.queryByRole("button", { name: "앱 정보" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  const info = screen.getByRole("button", { name: "앱 정보" });
  expect(info.parentElement?.classList.contains("flex")).toBe(true);
  expect(info.nextElementSibling?.getAttribute("aria-label")).toBe("Google로 로그인");
  fireEvent.click(info);
  expect(screen.getByRole("dialog", { name: "앱 정보 창" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Google로 로그인" })).toBeNull();
});

it("holds the login button as an enabled cancel action while waiting", () => {
  const view = render(<AccountControl />);
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  mocks.state.busy = true;
  mocks.state.signingIn = true;
  view.rerender(<AccountControl />);
  const cancel = screen.getByRole("button", { name: "로그인 취소" });
  expect(cancel.hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("button", { name: "Google로 로그인" })).toBeNull();
  fireEvent.click(cancel);
  expect(mocks.cancel).toHaveBeenCalledOnce();
  mocks.state.busy = false;
  mocks.state.signingIn = false;
  view.rerender(<AccountControl />);
  expect(screen.getByRole("button", { name: "Google로 로그인" }).hasAttribute("disabled")).toBe(
    false,
  );
});

it("offers Google login with a default profile and no explanatory footer", () => {
  render(<AccountControl />);
  const trigger = screen.getByRole("button", { name: "로그인" });
  expect(trigger.textContent).toBe("");
  fireEvent.click(trigger);
  expect(screen.getByRole("heading", { name: "로그인이 필요합니다" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "기본 프로필" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Google로 로그인" }));
  expect(mocks.login).toHaveBeenCalledOnce();
  expect(screen.queryByText(/로그인 없이도 내 컴퓨터의 PDF를 편집/)).toBeNull();
  expect(screen.queryByText(/로그인만으로 PDF 파일이 서버에 전송되지는/)).toBeNull();
});

it("replaces the titlebar icon with a profile and shows the signed-in account", () => {
  mocks.state.session = {
    user: {
      id: "user-id",
      email: "user@example.com",
      user_metadata: {
        full_name: "Paperkit User",
        avatar_url: "https://lh3.googleusercontent.com/test-profile-photo",
      },
    },
    access_token: "test-token",
  };
  render(<AccountControl />);
  const trigger = screen.getByRole("button", { name: "내 계정" });
  expect(trigger.querySelector("img")?.getAttribute("src")).toBe(
    "https://lh3.googleusercontent.com/test-profile-photo",
  );
  fireEvent.click(trigger);
  expect(screen.getByRole("heading", { name: "Paperkit User" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Paperkit User 프로필 사진" }).getAttribute("src")).toBe(
    "https://lh3.googleusercontent.com/test-profile-photo",
  );
  expect(screen.getByText("user@example.com")).toBeTruthy();
  expect(screen.queryByText("계정 연결이 확인되었습니다.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
  expect(mocks.logout).toHaveBeenCalledOnce();
});
