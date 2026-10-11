import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { editorFont, replacementEditorFont } from "../lib/editor-font";
import type { TextSelection, TextObject } from "../lib/preview";
import { readInlineText } from "../lib/inline-layout";

function placeCaret(element: HTMLElement, point: { x: number; y: number } | null) {
  let range: Range | null = null;
  if (point) {
    const doc = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caret = doc.caretPositionFromPoint?.(point.x, point.y);
    if (caret && element.contains(caret.offsetNode)) {
      range = document.createRange();
      range.setStart(caret.offsetNode, caret.offset);
    } else {
      const found = doc.caretRangeFromPoint?.(point.x, point.y);
      if (found && element.contains(found.startContainer)) range = found;
    }
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function InlineTextEditor({
  selected,
  objects,
  draft,
  scale,
  disabled,
  point,
  onDraft,
  onApply,
  onComposition,
  fontContext,
  visible,
  onFontsReady,
  onFontError,
}: {
  selected: TextSelection;
  draft: string;
  scale: number;
  disabled: boolean;
  objects: TextObject[];
  fontContext: { fileId: string; revision: number; pageIndex: number };
  visible: boolean;
  onFontsReady: () => void;
  onFontError: (message: string) => void;
  point: { x: number; y: number } | null;
  onDraft: (text: string) => void;
  onApply: (text?: string) => void;
  onComposition: (value: boolean) => void;
}) {
  const alignment = selected.alignment ?? selected.originalAlignment ?? "left";
  const input = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const touched = useRef(false);
  const [family, setFamily] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baselineOffset, setBaselineOffset] = useState(0);
  const blocked = selected.editBlocked !== null || disabled || error !== null;
  useEffect(() => {
    let disposed = false;
    const sources = selected.group
      ? selected.group.runs
          .map((r) => objects.find((o) => o.id === r.object))
          .filter((o): o is TextObject => !!o)
      : [selected];
    void (async () => {
      const fonts: Array<readonly [string, string]> = [];
      for (const source of [...new Map(sources.map((o) => [o.id, o])).values()]) {
        if (disposed) break;
        const replacement = selected.editFonts?.[source.id];
        fonts.push([
          String(source.id),
          await (replacement
            ? replacementEditorFont(replacement)
            : editorFont(source.font, {
                ...fontContext,
                objectId: source.fontObjectId ?? source.id,
              })),
        ]);
      }
      return fonts;
    })()
      .then((fonts) => {
        if (disposed) return;
        setFamily(fonts[0]?.[1] ?? "sans-serif");
        const fontMap = new Map(fonts);
        const context =
          typeof CanvasRenderingContext2D !== "undefined"
            ? document.createElement("canvas").getContext("2d")
            : null;
        input.current?.querySelectorAll<HTMLElement>("[data-source-font]").forEach((span) => {
          span.style.fontFamily = fontMap.get(span.dataset.sourceFont!) ?? "sans-serif";
          // PDF tracking is independent of the font's default browser advances.
          const width = Number(span.dataset.pdfWidth);
          const count = Array.from(span.textContent ?? "").length;
          if (width > 0 && count > 1 && typeof CanvasRenderingContext2D !== "undefined") {
            if (context) {
              context.font = `${span.style.fontStyle} ${span.style.fontWeight} ${span.style.fontSize} ${span.style.fontFamily}`;
              const measured = context.measureText(span.textContent ?? "").width;
              const tracking = (width - measured) / count;
              // Avoid distorting text when tight ink bounds or fallback metrics differ greatly.
              if (Math.abs(tracking) < parseFloat(span.style.fontSize) * 0.2)
                span.style.letterSpacing = `${tracking}px`;
            }
          }
        });
        const element = input.current;
        if (element && element.getBoundingClientRect().width > 0) {
          const origin = element.getBoundingClientRect().left;
          const stretch = Math.abs(selected.matrix[0] / selected.matrix[3]) || 1;
          // Read layout once before writing margins, rather than forcing layout for every object.
          const positions = Array.from(
            element.querySelectorAll<HTMLElement>("[data-pdf-x]"),
            (span) => {
              const rect = span.getBoundingClientRect();
              return {
                span,
                left: (rect.left - origin) / stretch,
                top: rect.top,
                margin: parseFloat(span.style.marginLeft) || 0,
              };
            },
          );
          let top = NaN,
            shift = 0;
          for (const position of positions) {
            if (Math.abs(position.top - top) > 1 || !Number.isFinite(top)) {
              top = position.top;
              shift = 0;
            }
            const delta = Number(position.span.dataset.pdfX) - position.left - shift;
            position.span.style.marginLeft = `${position.margin + delta}px`;
            shift += delta;
          }
        }
        onFontsReady();
      })
      .catch(() => {
        if (!disposed) {
          const message =
            "원본 글꼴을 불러오지 못했습니다. 동일 글꼴을 설치하거나 글꼴 메뉴에서 대체 글꼴을 선택해 주세요.";
          setError(message);
          onFontError(message);
        }
      });
    return () => {
      disposed = true;
    };
  }, [selected.font]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    // Populate the editable DOM before it becomes available for input. A passive
    // effect can run after the first input and overwrite that unsaved draft.
    element.textContent = "";
    if (selected.group && draft === selected.text) {
      const chars = Array.from(draft);
      let cursor = 0;
      let previous: TextObject | undefined;
      for (const run of selected.group.runs) {
        // A repeated source range must never paint the same characters twice.
        if (run.end <= cursor) continue;
        const source = objects.find((o) => o.id === run.object);
        const separator = chars.slice(cursor, run.start).join("");
        const newLine =
          source &&
          previous &&
          previous.matrix[5] - source.matrix[5] >
            Math.min(
              previous.fontSize * Math.abs(previous.matrix[3]),
              source.fontSize * Math.abs(source.matrix[3]),
            ) *
              0.5;
        if (newLine) {
          const br = document.createElement("br");
          br.dataset.pdfSeparator = separator;
          element.append(br);
        } else if (separator) element.append(document.createTextNode(separator));
        const span = document.createElement("span");
        span.textContent = chars.slice(Math.max(cursor, run.start), run.end).join("");
        if (source) {
          span.dataset.sourceFont = String(source.id);
          span.style.color = `rgba(${source.color.slice(0, 3).join(",")},${source.color[3] / 255})`;
          span.style.fontWeight =
            /^(Helvetica|Courier|Times)/.test(source.font) && source.font.includes("Bold")
              ? "700"
              : "400";
          span.style.fontStyle =
            /^(Helvetica|Courier|Times)/.test(source.font) && /Italic|Oblique/.test(source.font)
              ? "italic"
              : "normal";
          span.style.fontSize = `${source.fontSize * scale * Math.abs(source.matrix[3])}px`;
          if (run.objectStart === 0 && alignment === "left")
            span.dataset.pdfX = String(
              ((source.matrix[4] - selected.matrix[4]) * scale) /
                (Math.abs(selected.matrix[0] / selected.matrix[3]) || 1),
            );
          if (newLine && alignment === "left")
            span.style.marginLeft = `${((source.matrix[4] - selected.matrix[4]) * scale) / (Math.abs(selected.matrix[0] / selected.matrix[3]) || 1)}px`;
          if (
            run.objectStart === 0 &&
            run.end - run.start >= Array.from(source.text.trimEnd()).length
          ) {
            span.dataset.pdfWidth = String(
              ((Math.max(...source.bounds.map((p) => p[0])) -
                Math.min(...source.bounds.map((p) => p[0]))) *
                scale) /
                (Math.abs(selected.matrix[0] / selected.matrix[3]) || 1),
            );
          }
          if (source.font.includes("Thin")) span.style.fontVariationSettings = '"wght" 100';
          if (source.font.includes("ExtraLight")) span.style.fontVariationSettings = '"wght" 200';
        }
        element.append(span);
        cursor = run.end;
        previous = source;
      }
      element.append(document.createTextNode(chars.slice(cursor).join("")));
    } else element.textContent = draft;
    element.focus();
    placeCaret(element, point);
    // This component is keyed by document revision and selection. Replacing its
    // DOM on each input would break caret position, IME and browser undo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (selected.alignment)
      input.current?.querySelectorAll<HTMLElement>("span").forEach((span) => {
        span.style.marginLeft = "0px";
        delete span.dataset.pdfX;
      });
  }, [selected.alignment]);
  const read = () => {
    touched.current = true;
    const element = input.current;
    if (element) onDraft(readInlineText(element));
  };
  const fontSize = selected.fontSize * scale * Math.abs(selected.matrix[3]);
  const lineBoxes = selected.group?.bounds;
  const measuredLeading =
    lineBoxes && lineBoxes.length > 1
      ? Math.abs(
          Math.max(...lineBoxes[0].map((p) => p[1])) - Math.max(...lineBoxes[1].map((p) => p[1])),
        ) * scale
      : fontSize * 1.25;
  const sourceSizes = selected.group?.runs.map((run) => {
    const source = objects.find((object) => object.id === run.object);
    return source ? source.fontSize * scale * Math.abs(source.matrix[3]) : fontSize;
  }) ?? [fontSize];
  const leading = Math.max(...sourceSizes.map((size) => size * 1.15), measuredLeading);
  const horizontalScale = Math.abs(selected.matrix[0] / selected.matrix[3]) || 1;
  const leftOffset = (selected.matrix[4] - Math.min(...selected.bounds.map((p) => p[0]))) * scale;
  useEffect(() => {
    if (!family || typeof CanvasRenderingContext2D === "undefined") return;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    context.font = `${/^(Helvetica|Courier|Times)/.test(selected.font) && selected.font.includes("Bold") ? 700 : 400} ${fontSize}px ${family}`;
    const metrics = context.measureText("Hg");
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    if (Number.isFinite(ascent) && Number.isFinite(descent)) {
      const desired = (Math.max(...selected.bounds.map((p) => p[1])) - selected.matrix[5]) * scale;
      setBaselineOffset(desired - ascent - (leading - ascent - descent) / 2);
    }
  }, [family, fontSize, leading, scale, selected]);
  useEffect(() => {
    if (visible && family && input.current && !touched.current) {
      input.current.focus();
      placeCaret(input.current, point);
    }
  }, [family, baselineOffset, point, visible]);
  return (
    <>
      <div
        ref={input}
        role="textbox"
        aria-label="내용"
        aria-multiline="true"
        aria-readonly={blocked}
        aria-disabled={disabled}
        contentEditable={blocked ? false : "plaintext-only"}
        suppressContentEditableWarning
        tabIndex={0}
        spellCheck={false}
        onInput={read}
        onCompositionStart={() => {
          composing.current = true;
          onComposition(true);
        }}
        onCompositionEnd={() => {
          composing.current = false;
          onComposition(false);
          read();
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            if (!blocked && !event.repeat && input.current) {
              const value = readInlineText(input.current);
              onDraft(value);
              onApply(value);
            }
          }
        }}
        style={{
          fontFamily: family ?? "sans-serif",
          fontSize,
          lineHeight: `${leading}px`,
          position: "relative",
          top: baselineOffset,
          left: alignment === "left" ? leftOffset : 0,
          textAlign: alignment,
          transform: `scaleX(${horizontalScale})`,
          transformOrigin: "left top",
          width: `${100 / horizontalScale}%`,
          fontVariationSettings: selected.font.includes("Thin")
            ? '"wght" 100'
            : selected.font.includes("ExtraLight")
              ? '"wght" 200'
              : "normal",
          fontWeight:
            /^(Helvetica|Courier|Times)/.test(selected.font) && selected.font.includes("Bold")
              ? 700
              : 400,
          fontStyle:
            /^(Helvetica|Courier|Times)/.test(selected.font) && /Italic|Oblique/.test(selected.font)
              ? "italic"
              : "normal",
          fontSynthesis: "none",
          fontKerning: "none",
          fontVariantLigatures: "none",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: `rgba(${selected.color.slice(0, 3).join(",")},${selected.color[3] / 255})`,
          caretColor: "#047857",
          minHeight: "100%",
        }}
        className="w-full select-text border-0 bg-transparent p-0 outline-none selection:bg-emerald-200"
      />
    </>
  );
}
