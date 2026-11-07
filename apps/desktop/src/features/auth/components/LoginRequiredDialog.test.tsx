import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  state: { ready: true, busy: false, signingIn: false, error: null, dismissError: vi.fn() },
  login: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/features/auth/model/auth-store", () => ({
  useAuthStore: () => mocks.state,
  signInWithGoogle: mocks.login,
  cancelGoogleLogin: mocks.cancel,
}));
import { LoginRequiredDialog } from "./LoginRequiredDialog";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.busy = false;
  mocks.state.signingIn = false;
});
afterEach(cleanup);

it("keeps cancellation enabled and returns to login when the attempt ends", () => {
  const view = render(<LoginRequiredDialog open feature="전자서명" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Google로 로그인" }));
  expect(mocks.login).toHaveBeenCalledOnce();
  mocks.state.busy = true;
  mocks.state.signingIn = true;
  view.rerender(<LoginRequiredDialog open feature="전자서명" onClose={vi.fn()} />);
  const cancel = screen.getByRole("button", { name: "로그인 취소" });
  expect(cancel.hasAttribute("disabled")).toBe(false);
  fireEvent.click(cancel);
  expect(mocks.cancel).toHaveBeenCalledOnce();
  mocks.state.busy = false;
  mocks.state.signingIn = false;
  view.rerender(<LoginRequiredDialog open feature="전자서명" onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Google로 로그인" }).hasAttribute("disabled")).toBe(
    false,
  );
});

it.each(["close", "escape"])(
  "cancels a pending login when the modal is dismissed by %s",
  (method) => {
    mocks.state.busy = true;
    mocks.state.signingIn = true;
    const onClose = vi.fn();
    render(<LoginRequiredDialog open feature="워터마크" onClose={onClose} />);
    if (method === "close") fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    else fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  },
);
