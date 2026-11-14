import { Button } from "@/shared/ui/button";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Trash2, X } from "lucide-react";
import type { EditAction, PreviewPage, GraphicObject } from "@/shared/pdf/types";
import {
  graphicBox,
  graphicTransform,
  type Box,
} from "@/features/pdf-editor/lib/graphics/graphic-transform";
import { IconButton } from "@/shared/ui/icon-button";
import { MessageDialog } from "@/shared/ui/MessageDialog";
import { SizeControls } from "@/features/pdf-editor/components/controls/SizeControls";
import {
  rememberGraphic,
  recalledGraphic,
  clipboardImage,
  graphicPreview,
  isTextInput,
} from "@/features/pdf-editor/lib/graphics/graphic-clipboard";
const labels = { image: "이미지", path: "도형", shading: "음영", form: "복합 객체" };
export function GraphicLayer({
  active = true,
  page,
  disabled,
  onEdit,
  onSelect,
  textSelected,
  graphicMode = false,
}: {
  active?: boolean;
  textSelected?: boolean;
  graphicMode?: boolean;
  page: PreviewPage;
  disabled: boolean;
  onEdit: (action: EditAction) => Promise<boolean>;
  onSelect: () => void;
}) {
  const objects = (page.text.graphics ?? []).filter(
    (object) => !page.text.watermarkObjects?.includes(object.id),
  );
  const [id, setId] = useState<number | null>(null);
  const selected = objects.find((o) => o.id === id);
  const [layers, setLayers] = useState<{ background: string; foreground: string } | null>(null);
  const [next, setNext] = useState<Box | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    box: Box;
    resize: false | "both" | "x" | "y";
    ratio: number;
    object: GraphicObject;
  } | null>(null);
  const pendingBox = useRef<Box | null>(null);
  const old = selected && graphicBox(selected.screenBounds);
  const box = next ?? old;
  const [copying, setCopying] = useState(false);
  const copyingRef = useRef(false);
  async function copySelected() {
    if (!selected || disabled || committing || copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    try {
      const source = await invoke<number[]>("copy_graphic", {
        fileId: page.fileId,
        revision: page.state.revision,
        pageIndex: page.pageIndex,
        objectId: selected.id,
      });
      if (!Array.isArray(source) || !source.length) throw new Error();
      const marker = rememberGraphic(source);
      if (
        typeof ClipboardItem !== "undefined" &&
        navigator.clipboard?.write &&
        layers?.foreground
      ) {
        try {
          const png = await graphicPreview(layers.foreground, graphicBox(selected.screenBounds));
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": new Blob([marker], { type: "text/plain" }),
              "image/png": png,
            }),
          ]);
        } catch {
          await navigator.clipboard.writeText(marker);
        }
      } else await navigator.clipboard.writeText(marker);
      return true;
    } catch {
      setError("복사를 마치지 못했어요. 항목을 다시 선택해 복사해 주세요.");
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  }
  async function paste(source: number[] | null, image?: Blob | null) {
    if (disabled || committing) return;
    try {
      if (source) {
        onSelect();
        await apply({ kind: "pasteGraphic", page: page.pageIndex, source });
      } else if (image) {
        const png = await clipboardImage(image);
        onSelect();
        await apply({ kind: "pasteImage", page: page.pageIndex, png });
      }
    } catch {
      setError("붙여넣기를 마치지 못했어요. 다시 복사하거나 이미지 삽입을 이용해 주세요.");
    }
  }
  useEffect(() => {
    if (!active) return;
    const copy = (event: ClipboardEvent) => {
      if (
        event.defaultPrevented ||
        !selected ||
        disabled ||
        committing ||
        isTextInput(event.target)
      )
        return;
      event.preventDefault();
      void copySelected().then((ok) => {
        if (ok && event.type === "cut")
          void apply({ kind: "deleteGraphic", page: page.pageIndex, object: selected.id });
      });
    };
    const pasteEvent = (event: ClipboardEvent) => {
      if (event.defaultPrevented || disabled || committing || isTextInput(event.target)) return;
      const source = recalledGraphic(event.clipboardData?.getData("text/plain") ?? "");
      const image = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.type.startsWith("image/"))
        ?.getAsFile();
      if (!source && !image) return;
      event.preventDefault();
      void paste(source, image);
    };
    document.addEventListener("copy", copy);
    document.addEventListener("cut", copy);
    document.addEventListener("paste", pasteEvent);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", copy);
      document.removeEventListener("paste", pasteEvent);
    };
  }, [active, selected, disabled, committing, page, layers]);
  useEffect(() => {
    if (!active || !selected) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        disabled ||
        committing ||
        isTextInput(event.target) ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest('button,select,[role="combobox"],[role="listbox"],[role="option"]')
      )
        return;
      if (event.key === "Escape") {
        setId(null);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (!event.repeat)
          void apply({ kind: "deleteGraphic", page: page.pageIndex, object: selected.id });
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const step = event.shiftKey ? 10 : 1;
      const delta = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }[event.key];
      if (!delta) return;
      event.preventDefault();
      if (event.repeat) return;
      const original = graphicBox(selected.screenBounds);
      const matrix = graphicTransform(selected, {
        ...original,
        left: original.left + delta[0],
        top: original.top + delta[1],
      });
      if (matrix)
        void apply({ kind: "transformGraphic", page: page.pageIndex, object: selected.id, matrix });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, selected, disabled, committing, page]);
  useEffect(() => {
    if (textSelected) setId(null);
  }, [textSelected]);
  useEffect(() => {
    setNext(null);
    setCommitting(false);
    setError(null);
    drag.current = null;
    pendingBox.current = null;
  }, [page]);
  useEffect(() => {
    let active = true;
    setLayers(null);
    if (!selected) return;
    const args = {
      fileId: page.fileId,
      revision: page.state.revision,
      pageIndex: page.pageIndex,
      width: page.width,
      objects: [selected.id],
    };
    async function load(foreground: boolean) {
      const url = await invoke<string>("editing_background", { ...args, foreground });
      if (typeof url !== "string" || !url.startsWith("data:image/png;base64,"))
        throw new Error("Invalid layer");
      if (typeof Image.prototype.decode === "function") {
        const image = new Image();
        image.src = url;
        await image.decode();
      }
      return url;
    }
    void (async () => {
      const [background, foreground] = await Promise.all([load(false), load(true)]);
      if (active) setLayers({ background, foreground });
    })().catch(() => {
      if (active) setError("이동할 항목을 준비하지 못했어요. 다시 선택해 주세요.");
    });
    return () => {
      active = false;
    };
  }, [id, page]);
  async function apply(action: EditAction) {
    setCommitting(true);
    try {
      const ok = await onEdit(action);
      if (!ok) {
        setNext(null);
        setCommitting(false);
      }
      return ok;
    } catch {
      setNext(null);
      setCommitting(false);
      setError("변경을 적용하지 못했어요. 항목을 다시 선택해 주세요.");
    }
  }
  function choose(object: GraphicObject) {
    if (disabled || committing || id === object.id) return;
    onSelect();
    setId(object.id);
    setNext(null);
    setError(null);
  }
  function start(event: React.PointerEvent, resize: false | "both" | "x" | "y", object = selected) {
    event.stopPropagation();
    event.preventDefault();
    if (!object || disabled || committing || event.button !== 0) return;
    choose(object);
    const ratio = (root.current?.getBoundingClientRect().width || page.width) / page.width;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      box: graphicBox(object.screenBounds),
      resize,
      ratio,
      object,
    };
    pendingBox.current = null;
    root.current?.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (event.clientX - d.x) / d.ratio,
      dy = (event.clientY - d.y) / d.ratio;
    const b = d.resize
      ? {
          ...d.box,
          width:
            d.resize === "y"
              ? d.box.width
              : Math.max(6, Math.min(page.width - d.box.left, d.box.width + dx)),
          height:
            d.resize === "x"
              ? d.box.height
              : Math.max(6, Math.min(page.height - d.box.top, d.box.height + dy)),
        }
      : {
          ...d.box,
          left: Math.max(0, Math.min(page.width - d.box.width, d.box.left + dx)),
          top: Math.max(0, Math.min(page.height - d.box.height, d.box.top + dy)),
        };
    pendingBox.current = b;
    setNext(b);
  }
  function end() {
    if (!drag.current) return;
    const object = drag.current.object;
    drag.current = null;
    const b = pendingBox.current;
    pendingBox.current = null;
    if (!b) return;
    const matrix = graphicTransform(object, b);
    if (matrix)
      void apply({ kind: "transformGraphic", page: page.pageIndex, object: object.id, matrix });
    else {
      setNext(null);
      setError("이 항목의 크기를 바꾸기 어려워요. 다른 항목을 선택해 주세요.");
    }
  }
  const sorted = [...objects].sort((a, b) => {
    const x = graphicBox(a.screenBounds),
      y = graphicBox(b.screenBounds);
    return y.width * y.height - x.width * x.height;
  });
  const transforming = !!(next && layers && old && box);
  const cancel = () => {
    drag.current = null;
    pendingBox.current = null;
    setNext(null);
  };
  return (
    <div
      ref={root}
      className="pointer-events-none absolute inset-0 z-[6]"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        if (drag.current) cancel();
      }}
    >
      {transforming && (
        <>
          <img
            aria-hidden
            draggable={false}
            src={layers!.background}
            className="absolute inset-0"
            width={page.width}
            height={page.height}
          />
          <img
            aria-hidden
            draggable={false}
            data-testid="moving-graphic"
            src={layers!.foreground}
            width={page.width}
            height={page.height}
            className="absolute inset-0"
            style={{
              transformOrigin: `${old!.left}px ${old!.top}px`,
              transform: `translate(${box!.left - old!.left}px,${box!.top - old!.top}px) scale(${box!.width / old!.width},${box!.height / old!.height})`,
            }}
          />
        </>
      )}
      <svg className="absolute inset-0" width={page.width} height={page.height}>
        {sorted.map((o) => {
          const r = graphicBox(o.screenBounds);
          const interior =
            o.kind === "image" && r.width * r.height < page.width * page.height * 0.8;
          return (
            <polygon
              key={o.id}
              role="button"
              tabIndex={disabled || id === o.id ? -1 : 0}
              aria-label={`${labels[o.kind]} ${o.id + 1} 선택`}
              aria-pressed={id === o.id}
              points={o.screenBounds.map((p) => p.join(",")).join(" ")}
              fill="transparent"
              stroke="transparent"
              strokeWidth={6}
              className="cursor-move outline-none hover:stroke-blue-400 focus-visible:stroke-blue-500"
              visibility={id === o.id ? "hidden" : undefined}
              style={{
                pointerEvents:
                  disabled || transforming ? "none" : interior || graphicMode ? "all" : "stroke",
              }}
              onPointerDown={(e) => start(e, false, o)}
              onClick={(e) => {
                e.stopPropagation();
                if (!disabled && !committing) {
                  choose(o);
                }
              }}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !disabled && !committing) {
                  e.preventDefault();
                  choose(o);
                }
              }}
            />
          );
        })}
      </svg>
      {selected && box && (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label="선택한 이미지·도형 이동"
            className="pointer-events-auto absolute border-2 border-blue-500"
            style={{ ...box, cursor: "move", touchAction: "none" }}
            onPointerDown={(e) => start(e, false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setId(null);
              if (e.key === "Delete" && !disabled && !committing) {
                e.preventDefault();
                void apply({ kind: "deleteGraphic", page: page.pageIndex, object: selected.id });
              }
            }}
          >
            <Button
              variant="plain"
              size="bare"
              aria-label="이미지·도형 크기 조절"
              className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-sm border-2 border-white bg-blue-600"
              style={{ touchAction: "none" }}
              onPointerDown={(e) => start(e, "both")}
            />
            <Button
              variant="plain"
              size="bare"
              aria-label="이미지·도형 가로 조절"
              className="absolute -right-2 top-1/2 h-4 w-3 cursor-ew-resize border border-white bg-blue-600"
              onPointerDown={(e) => start(e, "x")}
            />
            <Button
              variant="plain"
              size="bare"
              aria-label="이미지·도형 세로 조절"
              className="absolute -bottom-2 left-1/2 h-3 w-4 cursor-ns-resize border border-white bg-blue-600"
              onPointerDown={(e) => start(e, "y")}
            />
          </div>
          <div
            className="pointer-events-auto absolute z-30 flex flex-wrap items-center gap-1 rounded-md border bg-white p-1 shadow"
            style={{
              left: Math.max(0, Math.min(page.width - 380, box.left)),
              top:
                box.top + box.height + 38 < page.height
                  ? box.top + box.height + 5
                  : Math.max(0, box.top - 38),
            }}
          >
            <SizeControls
              key={`${selected.id}:${old?.width}:${old?.height}`}
              label="이미지·도형"
              width={old!.width}
              height={old!.height}
              disabled={disabled || committing}
              onApply={(width, height) => {
                const matrix = graphicTransform(selected, { ...old!, width, height });
                if (matrix)
                  void apply({
                    kind: "transformGraphic",
                    page: page.pageIndex,
                    object: selected.id,
                    matrix,
                  });
              }}
            />
            <IconButton
              icon={Copy}
              label="이미지·도형 복사"
              disabled={disabled || committing || copying}
              onClick={() => void copySelected()}
            />
            <IconButton
              icon={Trash2}
              label="이미지·도형 삭제"
              disabled={disabled || committing}
              onClick={() =>
                void apply({ kind: "deleteGraphic", page: page.pageIndex, object: selected.id })
              }
            />
            <IconButton
              icon={X}
              label="이미지·도형 선택 해제"
              disabled={committing}
              onClick={() => setId(null)}
            />
          </div>
        </>
      )}
      <MessageDialog message={active ? error : null} onDismiss={() => setError(null)} />
    </div>
  );
}
