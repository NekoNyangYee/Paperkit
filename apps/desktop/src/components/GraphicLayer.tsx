import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Trash2, X } from "lucide-react";
import type { EditAction, PreviewPage, GraphicObject } from "../lib/preview";
import { graphicBox, graphicTransform, type Box } from "../lib/graphic-transform";
import { IconButton } from "./ui/icon-button";
import { MessageDialog } from "./MessageDialog";
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
    resize: boolean;
    ratio: number;
    object: GraphicObject;
  } | null>(null);
  const pendingBox = useRef<Box | null>(null);
  const old = selected && graphicBox(selected.screenBounds);
  const box = next ?? old;
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
  function start(event: React.PointerEvent, resize: boolean, object = selected) {
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
          width: Math.max(6, Math.min(page.width - d.box.left, d.box.width + dx)),
          height: Math.max(6, Math.min(page.height - d.box.top, d.box.height + dy)),
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
              onPointerDown={(e) => start(e, true)}
            />
          </div>
          <div
            className="pointer-events-auto absolute flex rounded-md border bg-white shadow"
            style={{
              left: Math.max(0, Math.min(page.width - 88, box.left + box.width / 2 - 40)),
              top:
                box.top + box.height + 38 < page.height
                  ? box.top + box.height + 5
                  : Math.max(0, box.top - 38),
            }}
          >
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
