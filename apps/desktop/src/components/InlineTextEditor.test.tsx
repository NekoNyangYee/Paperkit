import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
const font = vi.hoisted(() => vi.fn(async (_name, context) => `Font${context.objectId}`));
vi.mock("../lib/editor-font", () => ({ editorFont: font }));
import { InlineTextEditor } from "./InlineTextEditor";
import type { TextObject, TextSelection } from "../lib/preview";
afterEach(cleanup);
it("preserves input entered immediately on mount before passive effects run", async () => {
  const selected: TextObject = {
    id: 0,
    text: "Hello World",
    font: "Helvetica",
    fontSize: 12,
    color: [0, 0, 0, 255],
    matrix: [1, 0, 0, 1, 0, 0],
    bounds: [
      [0, 0],
      [100, 0],
      [100, 12],
      [0, 12],
    ],
    screenBounds: [
      [0, 0],
      [100, 0],
      [100, 12],
      [0, 12],
    ],
    editBlocked: null,
    fontChangeBlocked: null,
  };
  const onDraft = vi.fn();
  function ImmediateInput() {
    useLayoutEffect(() => {
      const editor = screen.getByRole("textbox");
      editor.textContent = "Keep this draft";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }, []);
    return (
      <InlineTextEditor
        selected={selected}
        objects={[selected]}
        draft={selected.text}
        scale={1}
        disabled={false}
        point={null}
        onDraft={onDraft}
        onApply={vi.fn()}
        onComposition={vi.fn()}
        fontContext={{ fileId: "immediate", revision: 0, pageIndex: 0 }}
        visible
        onFontsReady={vi.fn()}
        onFontError={vi.fn()}
      />
    );
  }
  render(<ImmediateInput />);
  await waitFor(() => expect(screen.getByRole("textbox").style.fontFamily).toContain("Font0"));
  expect(onDraft).toHaveBeenLastCalledWith("Keep this draft");
  expect(screen.getByRole("textbox").textContent).toBe("Keep this draft");
});
it("applies the current DOM with Enter, leaves Shift+Enter for line breaks, and protects IME", async () => {
  const selected: TextObject = {
    id: 0,
    text: "Old",
    font: "Courier",
    fontSize: 12,
    color: [0, 0, 0, 255],
    matrix: [1, 0, 0, 1, 20, 100],
    bounds: [
      [20, 100],
      [50, 100],
      [50, 112],
      [20, 112],
    ],
    screenBounds: [
      [0, 0],
      [30, 0],
      [30, 12],
      [0, 12],
    ],
    editBlocked: null,
    fontChangeBlocked: null,
  };
  const apply = vi.fn();
  render(
    <InlineTextEditor
      selected={selected}
      objects={[selected]}
      draft="Old"
      scale={1}
      disabled={false}
      point={null}
      onDraft={vi.fn()}
      onApply={apply}
      onComposition={vi.fn()}
      fontContext={{ fileId: "enter", revision: 0, pageIndex: 0 }}
      visible
      onFontsReady={vi.fn()}
      onFontError={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input.style.fontFamily).toContain("Font0"));
  input.textContent = "Latest text";
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(apply).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
  expect(apply).toHaveBeenCalledExactlyOnceWith("Latest text");
  fireEvent.keyDown(input, { key: "Enter", repeat: true });
  expect(apply).toHaveBeenCalledTimes(1);
});
it("remembers PDF line boundaries and hanging indent without changing draft spaces", async () => {
  const first: TextObject = {
    id: 10,
    text: "First",
    font: "Original",
    fontSize: 12,
    color: [0, 0, 0, 255],
    matrix: [1, 0, 0, 1, 20, 100],
    bounds: [
      [20, 100],
      [50, 100],
      [50, 112],
      [20, 112],
    ],
    screenBounds: [
      [0, 0],
      [30, 0],
      [30, 12],
      [0, 12],
    ],
    editBlocked: null,
    fontChangeBlocked: null,
  };
  const next: TextObject = {
    ...first,
    id: 11,
    text: "Second",
    matrix: [1, 0, 0, 1, 10, 82],
    bounds: [
      [10, 82],
      [50, 82],
      [50, 94],
      [10, 94],
    ],
  };
  const selected: TextSelection = {
    ...first,
    text: "First Second",
    group: {
      id: 0,
      kind: "paragraph",
      text: "First Second",
      uncertain: false,
      editBlocked: null,
      runs: [
        { object: 10, start: 0, end: 5, objectStart: 0 },
        { object: 11, start: 6, end: 12, objectStart: 0 },
      ],
      bounds: [first.bounds, next.bounds],
      screenBounds: [first.screenBounds, next.screenBounds],
    },
  };
  const onDraft = vi.fn();
  render(
    <InlineTextEditor
      selected={selected}
      objects={[first, next]}
      draft={selected.text}
      scale={1}
      disabled={false}
      point={null}
      onDraft={onDraft}
      onApply={vi.fn()}
      onComposition={vi.fn()}
      fontContext={{ fileId: "lines", revision: 0, pageIndex: 0 }}
      visible
      onFontsReady={vi.fn()}
      onFontError={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input.querySelectorAll("span")[1].style.fontFamily).toBe("Font11"));
  expect(input.querySelector("br")?.dataset.pdfSeparator).toBe(" ");
  expect(input.querySelectorAll("span")[1].style.marginLeft).toBe("-10px");
  expect(input.style.lineHeight).toBe("18px");
  input.querySelectorAll("span")[1].textContent = "Edited";
  fireEvent.input(input);
  expect(onDraft).toHaveBeenLastCalledWith("First Edited");
});
it("keeps distinct same-name fonts and prevents collapsed heading line height", async () => {
  const object: TextObject = {
    id: 1,
    text: "A",
    font: "SameName",
    fontSize: 20,
    color: [0, 0, 0, 255],
    matrix: [1, 0, 0, 1, 0, 0],
    bounds: [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ],
    screenBounds: [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ],
    editBlocked: null,
    fontChangeBlocked: null,
  };
  const other = { ...object, id: 2, text: "B", fontSize: 30 };
  const selected: TextSelection = {
    ...object,
    text: "AB",
    group: {
      id: 0,
      kind: "paragraph",
      text: "AB",
      uncertain: false,
      editBlocked: null,
      runs: [
        { object: 1, start: 0, end: 1, objectStart: 0 },
        { object: 2, start: 1, end: 2, objectStart: 0 },
      ],
      bounds: [object.bounds, object.bounds],
      screenBounds: [object.screenBounds, object.screenBounds],
    },
  };
  render(
    <InlineTextEditor
      selected={selected}
      objects={[object, other]}
      draft="AB"
      scale={1}
      disabled={false}
      point={null}
      onDraft={vi.fn()}
      onApply={vi.fn()}
      onComposition={vi.fn()}
      fontContext={{ fileId: "test", revision: 0, pageIndex: 0 }}
      visible
      onFontsReady={vi.fn()}
      onFontError={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input.querySelectorAll("span")[1].style.fontFamily).toBe("Font2"));
  expect(input.querySelectorAll("span")[0].style.fontFamily).toBe("Font1");
  expect(parseFloat(input.style.lineHeight)).toBeGreaterThanOrEqual(34.5);
  expect(input.textContent).toBe("AB");
});
