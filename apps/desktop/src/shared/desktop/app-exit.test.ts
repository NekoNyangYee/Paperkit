import { expect, it, vi } from "vitest";
const flush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./workspace", () => ({ flushWorkspace: flush }));
import { approveAppExit, registerExitGuard, requestAppExit } from "./app-exit";

it("checks every document, including inactive tabs, and retains all guards after cancellation", async () => {
  const first = vi.fn().mockResolvedValue(true);
  const second = vi.fn().mockResolvedValue(false);
  const removeFirst = registerExitGuard(first),
    removeSecond = registerExitGuard(second);
  try {
    expect(await approveAppExit()).toBe(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
    second.mockResolvedValue(true);
    expect(await approveAppExit()).toBe(true);
    expect(first).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(1);
  } finally {
    removeFirst();
    removeSecond();
  }
});
it("coalesces native close events from multiple mounted editors", async () => {
  let approve!: (value: boolean) => void;
  const guard = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
  );
  const remove = registerExitGuard(guard);
  const exit = vi.fn().mockResolvedValue(undefined);
  try {
    const pending = requestAppExit(exit);
    await requestAppExit(exit);
    expect(guard).toHaveBeenCalledTimes(1);
    approve(true);
    await pending;
    expect(exit).toHaveBeenCalledTimes(1);
  } finally {
    remove();
  }
});
