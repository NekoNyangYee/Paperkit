import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton, type ButtonAction } from "./action-button";
import { DialogFeedbackIcon, type ConfirmKind } from "./dialog-feedback";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
} from "./alert-dialog";
export function useConfirmDialog({
  kind,
  title,
  description,
  action = kind,
}: {
  kind: ConfirmKind;
  title: string;
  description: string;
  action?: ButtonAction;
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
        <DialogFeedbackIcon kind={kind} />
        <AlertDialogTitle className="text-lg font-semibold">{title}</AlertDialogTitle>
        <AlertDialogDescription className="mt-3 text-sm leading-6 text-stone-600">
          {description}
        </AlertDialogDescription>
        <div className="mt-6 flex justify-end gap-2">
          <AlertDialogAction asChild>
            <ActionButton
              action={action}
              onClick={() => finish(true)}
              className={`text-white ${{ delete: "bg-red-700", reset: "bg-indigo-700", discard: "bg-amber-800" }[kind]}`}
            />
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { confirm, dialog, isOpen: open };
}
