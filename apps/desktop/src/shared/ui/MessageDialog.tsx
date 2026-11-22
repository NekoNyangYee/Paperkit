import { ActionButton } from "./action-button";
import { useConfirmDialog } from "./confirm-dialog";
import { useEffect, useRef, useState } from "react";
import { DialogFeedbackIcon, type MessageKind } from "./dialog-feedback";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
} from "./alert-dialog";

export function MessageDialog({
  message,
  title,
  kind = "info",
  onDismiss,
  onRetry,
}: {
  message: string | null;
  title?: string;
  kind?: MessageKind;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lastMessage = useRef(message);
  if (message) lastMessage.current = message;
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
        <DialogFeedbackIcon kind={kind} />
        <AlertDialogTitle className="text-lg font-semibold">
          {title ??
            { info: "안내", success: "작업 완료", warning: "확인해 주세요", error: "작업 오류" }[
              kind
            ]}
        </AlertDialogTitle>
        <AlertDialogDescription className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-stone-600">
          {message ?? lastMessage.current}
        </AlertDialogDescription>
        {onRetry && (
          <div className="mt-6 flex justify-end">
            <AlertDialogAction asChild>
              <ActionButton action="retry" onClick={onRetry} />
            </AlertDialogAction>
          </div>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function useDiscardDialog() {
  return useConfirmDialog({
    kind: "discard",
    title: "변경 사항 확인",
    description: "저장하지 않은 변경을 버리고 계속할까요?",
  });
}
