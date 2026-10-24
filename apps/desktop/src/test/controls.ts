import { fireEvent, screen } from "@testing-library/react";

export async function selectOption(trigger: HTMLElement, name: string) {
  if (trigger.getAttribute("aria-expanded") !== "true")
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

export function slide(label: string, value: number) {
  const thumb = screen.getByRole("slider", { name: label });
  const current = Number(thumb.getAttribute("aria-valuenow"));
  const key = value > current ? "ArrowRight" : "ArrowLeft";
  let remaining = Math.abs(value - current);
  while (remaining > 0) {
    const shiftKey = remaining >= 10;
    fireEvent.keyDown(thumb, { key, shiftKey });
    remaining -= shiftKey ? 10 : 1;
  }
}
