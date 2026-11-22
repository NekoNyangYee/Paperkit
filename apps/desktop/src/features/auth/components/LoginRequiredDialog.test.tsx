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

it("keeps a pending sign-in open on Escape and outside clicks, and cancels only from X", async () => {
  const onClose = vi.fn();
  const view = render(<LoginRequiredDialog open feature="전자서명" onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Google로 로그인" }));
  expect(mocks.login).toHaveBeenCalledOnce();
  mocks.state.busy = true;
  mocks.state.signingIn = true;
  view.rerender(<LoginRequiredDialog open feature="전자서명" onClose={onClose} />);
  expect(screen.getByRole("button", { name: "Google로 로그인" }).hasAttribute("disabled")).toBe(
    true,
  );
  // Radix installs the outside pointer listener after the opening event.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overlay = document.querySelector(".modal-overlay")!;
  fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
  fireEvent.click(overlay);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  const cancel = screen.getByRole("button", { name: "취소" });
  expect(cancel.textContent).toBe("");
  fireEvent.click(cancel);
  expect(mocks.cancel).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
