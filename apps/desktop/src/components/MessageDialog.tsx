import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Info, Trash2, Undo2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./ui/alert-dialog";

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
              <Undo2 size={18} aria-hidden="true" />
            </AlertDialogAction>
          )}
          <AlertDialogCancel
            aria-label="확인"
            title="확인"
            className="dialog-button bg-emerald-900 text-white"
          >
            <Check size={18} aria-hidden="true" />
          </AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function useDiscardDialog() {
  const [open, setOpen] = useState(false);
  const pending = useRef<{ resolve: (value: boolean) => void; promise: Promise<boolean> } | null>(
    null,
  );
  const focus = useRef<HTMLElement | null>(null);
  const finish = useCallback((value: boolean) => {
    pending.current?.resolve(value);
    pending.current = null;
    setOpen(false);
  }, []);
  useEffect(
    () => () => {
      pending.current?.resolve(false);
      pending.current = null;
    },
    [],
  );
  const confirm = useCallback(() => {
    if (pending.current) return pending.current.promise;
    focus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    pending.current = { resolve, promise };
    setOpen(true);
    return promise;
  }, []);
  const dialog = (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) finish(false);
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focus.current?.focus();
        }}
      >
        <CircleAlert className="mb-4 text-amber-600" aria-hidden="true" />
        <AlertDialogTitle className="text-lg font-semibold">변경 사항 확인</AlertDialogTitle>
        <AlertDialogDescription className="mt-3 text-sm leading-6 text-stone-600">
          저장하지 않은 변경을 버리고 계속할까요?
        </AlertDialogDescription>
        <div className="mt-6 flex justify-end gap-2">
          <AlertDialogCancel
            aria-label="돌아가기"
            title="돌아가기"
            className="dialog-button"
            onClick={() => finish(false)}
          >
            <Undo2 size={18} aria-hidden="true" />
          </AlertDialogCancel>
          <AlertDialogAction
            aria-label="변경 버리기"
            title="변경 버리기"
            className="dialog-button bg-red-700 text-white"
            onClick={() => finish(true)}
          >
            <Trash2 size={18} aria-hidden="true" />
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { confirm, dialog, isOpen: open };
}
