import { useEffect, useRef, useState } from "react";
import SignaturePad from "signature_pad";
import { X, RotateCcw } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/shared/ui/dialog";
import { IconButton } from "@/shared/ui/icon-button";
import { Button } from "@/shared/ui/button";
import { useConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useDialogClose } from "@/shared/ui/use-dialog-close";
import { canvasContext, signaturePng } from "@/features/pdf-editor/lib/stamps/canvas";

export function SignatureDialog({
  onClose,
  onApply,
  applyError,
}: {
  onClose: () => void;
  onApply: (png: number[]) => Promise<boolean>;
  applyError?: string | null;
}) {
  const { open, close } = useDialogClose(onClose);
  const resetDialog = useConfirmDialog({
    title: "서명 초기화",
    description: "그린 서명을 지우고 다시 그릴까요?",
    confirmLabel: "서명 지우기",
  });
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const pad = useRef<SignaturePad | null>(null);
  const applying = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = canvas;
    if (!element) return;
    const instance = new SignaturePad(element, { minWidth: 1, maxWidth: 3, penColor: "#172033" });
    pad.current = instance;
    instance.addEventListener("endStroke", () => setEmpty(instance.isEmpty()));
    let previousWidth = 0;
    let previousHeight = 0;
    const resize = () => {
      if (applying.current) return;
      const bounds = element.getBoundingClientRect();
      const width = bounds.width || 600;
      const height = bounds.height || width * 0.4;
      if (width === previousWidth && height === previousHeight) return;
      const data = instance.toData();
      const scale = previousWidth ? width / previousWidth : 1;
      const scaleY = previousHeight ? height / previousHeight : 1;
      previousWidth = width;
      previousHeight = height;
      const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      canvasContext(element).setTransform(ratio, 0, 0, ratio, 0, 0);
      instance.clear();
      instance.fromData(
        data.map((group) => ({
          ...group,
          points: group.points.map((point) => ({
            ...point,
            x: point.x * scale,
            y: point.y * scaleY,
          })),
        })),
      );
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => {
      observer.disconnect();
      instance.off();
      pad.current = null;
    };
  }, [canvas]);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !applying.current && !resetDialog.isOpen) close();
      }}
    >
      <DialogContent className="flex h-[min(520px,calc(100dvh-64px))] w-[min(94vw,680px)] flex-col gap-3 overflow-hidden p-5">
        <div className="flex shrink-0 items-center justify-between">
          <DialogTitle className="text-lg font-semibold">전자서명</DialogTitle>
          <IconButton icon={X} label="전자서명 창 닫기" disabled={pending} onClick={close} />
        </div>
        <DialogDescription className="shrink-0 text-sm text-stone-500">
          아래에 서명해 주세요. 생성하면 현재 페이지에 들어가며, 이동하거나 크기를 조절할 수
          있습니다.
        </DialogDescription>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-stone-300 bg-white">
          <div className="pointer-events-none absolute inset-x-6 bottom-12 border-b border-dashed border-stone-200" />
          <canvas
            ref={setCanvas}
            width={1200}
            height={480}
            aria-label="서명 그리기 영역"
            className="relative block size-full touch-none"
            style={{ pointerEvents: pending ? "none" : undefined }}
          />
        </div>
        <div className="flex shrink-0 items-center justify-between text-xs text-stone-500">
          <span>마우스·터치·펜으로 그릴 수 있습니다.</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || empty}
            onClick={async () => {
              if (!(await resetDialog.confirm())) return;
              pad.current?.clear();
              setEmpty(true);
              setError(null);
            }}
          >
            <RotateCcw size={14} />
            다시 그리기
          </Button>
        </div>
        {(applyError || error) && (
          <p role="alert" className="shrink-0 text-sm text-red-700">
            {applyError ?? error}
          </p>
        )}
        <div className="flex shrink-0 justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={close}>
            취소
          </Button>
          <Button
            disabled={pending || empty}
            onClick={async () => {
              if (!canvas || pad.current?.isEmpty() || applying.current) return;
              applying.current = true;
              setPending(true);
              setError(null);
              try {
                if (await onApply(signaturePng(canvas).png)) close();
                else setError("서명을 넣지 못했습니다. 다시 시도해 주세요.");
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "서명을 생성하지 못했습니다.");
              } finally {
                applying.current = false;
                setPending(false);
              }
            }}
          >
            {pending ? "서명 넣는 중…" : "서명 생성"}
          </Button>
        </div>
      </DialogContent>
      {resetDialog.dialog}
    </Dialog>
  );
}
