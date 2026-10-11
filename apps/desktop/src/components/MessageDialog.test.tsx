import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageDialog, useDiscardDialog } from "./MessageDialog";
afterEach(cleanup);
it("keeps cancellation as the default and resolves discard only on explicit confirmation", async () => {
  const result = vi.fn();
  function Harness() {
    const { confirm, dialog } = useDiscardDialog();
    return (
      <>
        <button onClick={() => void confirm().then(result)}>닫기</button>
        {dialog}
      </>
    );
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "닫기" });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole("alertdialog", { name: "변경 사항 확인" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "돌아가기" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(result).toHaveBeenLastCalledWith(false));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: "변경 버리기" }));
  await waitFor(() => expect(result).toHaveBeenLastCalledWith(true));
});
it("dismisses a notification without reopening it on unrelated rerenders", async () => {
  const view = render(<MessageDialog message="저장했습니다." />);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  view.rerender(<MessageDialog message="저장했습니다." />);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  view.rerender(<MessageDialog message="다른 알림" />);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});
