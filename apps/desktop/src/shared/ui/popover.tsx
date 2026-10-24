import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-popover";
import { cn } from "@/shared/lib/utils";
export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export function PopoverContent({
  className,
  align = "end",
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-[80] w-80 rounded-xl border border-stone-200 bg-white p-4 text-sm shadow-xl outline-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
