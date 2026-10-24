import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Button } from "./button";
export function IconButton({
  label,
  icon: Icon,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon }) {
  return (
    <Button
      type="button"
      aria-label={label}
      title={label}
      className={cn("text-stone-600 disabled:cursor-not-allowed", className)}
      variant="ghost"
      size="icon"
      {...props}
    >
      <Icon size={19} aria-hidden="true" />
    </Button>
  );
}
