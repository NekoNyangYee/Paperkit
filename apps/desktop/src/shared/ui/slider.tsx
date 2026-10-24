import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-slider";
import { cn } from "@/shared/lib/utils";

export function Slider({
  className,
  value,
  defaultValue,
  "aria-label": label,
  ...props
}: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      value={value}
      defaultValue={defaultValue}
      className={cn(
        "relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      <Primitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-stone-200">
        <Primitive.Range className="absolute h-full bg-emerald-700" />
      </Primitive.Track>
      {(value ?? defaultValue ?? [0]).map((_, index) => (
        <Primitive.Thumb
          key={index}
          aria-label={label}
          className="block size-3.5 rounded-full border-2 border-emerald-700 bg-white shadow-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:pointer-events-none"
        />
      ))}
    </Primitive.Root>
  );
}
