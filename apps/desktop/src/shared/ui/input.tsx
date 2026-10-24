import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/utils";
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-stone-200 bg-white px-3 py-1 text-sm outline-none transition-shadow file:mr-3 file:border-0 file:bg-transparent file:text-xs file:font-medium focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-16 w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}
