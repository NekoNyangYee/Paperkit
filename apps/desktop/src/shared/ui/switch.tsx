import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-switch";
import { cn } from "@/shared/lib/utils";

export function Switch({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-40 data-[state=checked]:bg-emerald-800 data-[state=unchecked]:bg-stone-300",
        className,
      )}
      {...props}
    >
      <Primitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </Primitive.Root>
  );
}
