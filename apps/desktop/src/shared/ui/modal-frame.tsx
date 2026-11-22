import type { ComponentProps } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as AlertPrimitive from "@radix-ui/react-alert-dialog";
import { X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { IconButton } from "./icon-button";

type FrameProps = Omit<
  ComponentProps<typeof DialogPrimitive.Content>,
  "onPointerDownOutside" | "onInteractOutside"
> & { cancelDisabled?: boolean; alert?: boolean };

function preventDismiss(event: Event) {
  event.preventDefault();
}

export function ModalFrame({
  alert,
  cancelDisabled,
  children,
  className,
  onEscapeKeyDown,
  ...props
}: FrameProps) {
  const { Portal, Overlay, Content } = alert ? AlertPrimitive : DialogPrimitive;
  const Cancel = alert ? AlertPrimitive.Cancel : DialogPrimitive.Close;
  return (
    <Portal>
      <Overlay className="modal-overlay fixed inset-x-0 bottom-0 top-10 z-50 bg-black/35 backdrop-blur-md" />
      <Content
        {...props}
        onPointerDownOutside={preventDismiss}
        onInteractOutside={preventDismiss}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          event.preventDefault();
        }}
        className={cn(
          "modal-content fixed left-1/2 top-[calc(50%+20px)] z-50 max-h-[calc(100dvh-64px)] overflow-auto -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-2xl outline-none",
          alert && "w-[calc(100%_-_2rem)] max-w-md border border-stone-200 p-6",
          className,
        )}
      >
        <Cancel asChild>
          <IconButton
            icon={X}
            label="취소"
            disabled={cancelDisabled}
            className="absolute right-3 top-3 z-10 rounded-lg bg-white/90"
          />
        </Cancel>
        {children}
      </Content>
    </Portal>
  );
}
