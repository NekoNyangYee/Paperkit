import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ActionContextMenu, ContextMenuItem } from "./context-menu";

afterEach(cleanup);

it("opens only the closest menu and leaves editable fields' native menu available", async () => {
  render(
    <ActionContextMenu label="탭 작업" items={<ContextMenuItem>탭 종료</ContextMenuItem>}>
      <main>
        <ActionContextMenu label="문서 작업" items={<ContextMenuItem>문서 열기</ContextMenuItem>}>
          <section>
            <button>문서</button>
            <input aria-label="검색" />
          </section>
        </ActionContextMenu>
      </main>
    </ActionContextMenu>,
  );
  expect(fireEvent.contextMenu(screen.getByRole("textbox"))).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(screen.getByRole("button", { name: "문서" }));
  const menu = await screen.findByRole("menu", { name: "문서 작업" });
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(within(menu).getByText("문서 열기")).toBeTruthy();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
});
