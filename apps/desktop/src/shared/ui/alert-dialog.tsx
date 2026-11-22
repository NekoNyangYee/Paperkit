// shadcn/ui Radix composition, styled for Paperkit (manual installation).
import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-alert-dialog";
import { cn } from "@/shared/lib/utils";

import { ModalFrame } from "./modal-frame";
export const AlertDialog = Primitive.Root;
export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn("pr-9", className)} {...props} />;
}
export const AlertDialogDescription = Primitive.Description;
export const AlertDialogAction = Primitive.Action;
export function AlertDialogContent(props: ComponentProps<typeof Primitive.Content>) {
  return <ModalFrame {...props} alert />;
}
