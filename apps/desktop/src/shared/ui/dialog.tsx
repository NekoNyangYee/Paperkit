import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-dialog";
import { cn } from "@/shared/lib/utils";
import { ModalFrame } from "./modal-frame";
export const Dialog = Primitive.Root;
export function DialogTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn("pr-9", className)} {...props} />;
}
export const DialogDescription = Primitive.Description;
export const DialogTrigger = Primitive.Trigger;
export function DialogContent(props: Omit<ComponentProps<typeof ModalFrame>, "alert">) {
  return <ModalFrame {...props} />;
}
