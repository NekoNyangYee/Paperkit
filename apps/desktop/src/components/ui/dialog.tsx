import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-dialog";
import { cn } from "../../lib/utils";
export const Dialog = Primitive.Root;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export const DialogClose = Primitive.Close;
export const DialogTrigger = Primitive.Trigger;
export function DialogContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="modal-overlay fixed inset-x-0 bottom-0 top-10 z-50 bg-black/35 backdrop-blur-md" />
      <Primitive.Content
        className={cn(
          "modal-content fixed left-1/2 top-[calc(50%+20px)] z-50 max-h-[calc(100dvh-64px)] overflow-auto -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-2xl outline-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
