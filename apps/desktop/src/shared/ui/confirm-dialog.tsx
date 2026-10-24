import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./alert-dialog";
export function useConfirmDialog({
  title,
  description,
  confirmLabel = "초기화",
  cancelLabel = "취소",
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
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
        <AlertDialogTitle className="text-lg font-semibold">{title}</AlertDialogTitle>
        <AlertDialogDescription className="mt-3 text-sm leading-6 text-stone-600">
          {description}
        </AlertDialogDescription>
        <div className="mt-6 flex justify-end gap-2">
          <AlertDialogCancel
            aria-label={cancelLabel}
            title={cancelLabel}
            className="dialog-button"
            onClick={() => finish(false)}
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            aria-label={confirmLabel}
            title={confirmLabel}
            className="dialog-button bg-red-700 text-white"
            onClick={() => finish(true)}
          >
            {confirmLabel}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { confirm, dialog, isOpen: open };
}
