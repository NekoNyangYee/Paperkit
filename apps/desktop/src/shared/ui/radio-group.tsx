import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-radio-group";
import { Circle } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export function RadioGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root className={cn("grid gap-2", className)} {...props} />;
}
export function RadioGroupItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "aspect-square size-4 rounded-full border border-stone-400 text-emerald-800 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-40 data-[state=checked]:border-emerald-700",
        className,
      )}
      {...props}
    >
      <Primitive.Indicator className="flex items-center justify-center">
        <Circle className="size-2 fill-current" />
      </Primitive.Indicator>
    </Primitive.Item>
  );
}
