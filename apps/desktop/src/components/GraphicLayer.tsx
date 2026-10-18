import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Trash2, X } from "lucide-react";
import type { EditAction, PreviewPage, GraphicObject } from "../lib/preview";
import { graphicBox, graphicTransform, type Box } from "../lib/graphic-transform";
import { IconButton } from "./ui/icon-button";
import { MessageDialog } from "./MessageDialog";
import { SizeControls } from "./SizeControls";
import {
  rememberGraphic,
  recalledGraphic,
  clipboardImage,
  graphicPreview,
  isTextInput,
} from "../lib/graphic-clipboard";
const labels = { image: "이미지", path: "도형", shading: "음영", form: "복합 객체" };
export function GraphicLayer({
  page,
  disabled,
  onEdit,
  onSelect,
  textSelected,
  graphicMode = false,
}: {
  textSelected?: boolean;
  graphicMode?: boolean;
  page: PreviewPage;
  disabled: boolean;
  onEdit: (action: EditAction) => Promise<boolean>;
  onSelect: () => void;
}) {
  const objects = page.text.graphics ?? [];
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
    } catch {
      setError("객체를 클립보드에 복사하지 못했습니다. 다시 시도해 주세요.");
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
      setError("클립보드의 이미지를 붙여넣지 못했습니다.");
    }
  }
  useEffect(() => {
    const copy = (event: ClipboardEvent) => {
      if (!selected || disabled || committing || isTextInput(event.target)) return;
      event.preventDefault();
      void copySelected();
    };
    const pasteEvent = (event: ClipboardEvent) => {
      if (disabled || committing || isTextInput(event.target)) return;
      const source = recalledGraphic(event.clipboardData?.getData("text/plain") ?? "");
      const image = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.type.startsWith("image/"))
        ?.getAsFile();
      if (!source && !image) return;
      event.preventDefault();
      void paste(source, image);
    };
    document.addEventListener("copy", copy);
    document.addEventListener("paste", pasteEvent);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("paste", pasteEvent);
    };
  }, [selected, disabled, committing, page, layers]);
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
      if (active) setError("객체 이동 미리보기를 준비하지 못했습니다. 다시 선택해 주세요.");
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
      setError("변경 사항을 반영하지 못했습니다. 다시 시도해 주세요.");
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
      setError("이 객체의 크기나 좌표를 변환할 수 없습니다.");
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
              className="cursor-pointer outline-none hover:stroke-blue-400 focus-visible:stroke-blue-500"
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
            <button
              aria-label="이미지·도형 크기 조절"
              className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-sm border-2 border-white bg-blue-600"
              style={{ touchAction: "none" }}
              onPointerDown={(e) => start(e, "both")}
            />
            <button
              aria-label="이미지·도형 가로 조절"
              className="absolute -right-2 top-1/2 h-4 w-3 cursor-ew-resize border border-white bg-blue-600"
              onPointerDown={(e) => start(e, "x")}
            />
            <button
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
      <MessageDialog message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
