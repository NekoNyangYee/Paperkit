import { useConfirmDialog } from "./confirm-dialog";
import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./alert-dialog";

export function MessageDialog({
  message,
  title = "알림",
  onDismiss,
  onRetry,
}: {
  message: string | null;
  title?: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!message) setDismissed(null);
  }, [message]);
  return (
    <AlertDialog
      open={!!message && dismissed !== message}
      onOpenChange={(open) => {
        if (!open) {
          setDismissed(message);
          onDismiss?.();
        }
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={() => {
          focus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (focus.current?.isConnected) focus.current.focus();
        }}
      >
        <Info className="mb-4 text-emerald-700" aria-hidden="true" />
        <AlertDialogTitle className="text-lg font-semibold">{title}</AlertDialogTitle>
        <AlertDialogDescription className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-stone-600">
          {message}
        </AlertDialogDescription>
        <div className="mt-6 flex justify-end gap-2">
          {onRetry && (
            <AlertDialogAction
              aria-label="다시 시도"
              title="다시 시도"
              onClick={onRetry}
              className="dialog-button"
            >
              다시 시도
            </AlertDialogAction>
          )}
          <AlertDialogCancel
            aria-label="확인"
            title="확인"
            className="dialog-button bg-emerald-900 text-white"
          >
            확인
          </AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function useDiscardDialog() {
  return useConfirmDialog({
    title: "변경 사항 확인",
    description: "저장하지 않은 변경을 버리고 계속할까요?",
    confirmLabel: "변경 버리기",
    cancelLabel: "돌아가기",
  });
}
