// shadcn/ui Radix composition, styled for Paperkit (manual installation).
import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-alert-dialog";
import { cn } from "../../lib/utils";

export const AlertDialog = Primitive.Root;
export const AlertDialogTitle = Primitive.Title;
export const AlertDialogDescription = Primitive.Description;
export const AlertDialogAction = Primitive.Action;
export const AlertDialogCancel = Primitive.Cancel;
export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="modal-overlay fixed inset-x-0 bottom-0 top-10 z-50 bg-black/35 backdrop-blur-md" />
      <Primitive.Content
        className={cn(
          "modal-content fixed left-1/2 top-[calc(50%+20px)] z-50 max-h-[calc(100dvh-64px)] overflow-auto w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl outline-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
