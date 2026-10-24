import type { ComponentProps, ReactNode } from "react";
import * as Primitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export const Select = Primitive.Root;
export const SelectGroup = Primitive.Group;
export const SelectValue = Primitive.Value;
export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        "flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-stone-200 bg-white px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-40 [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <Primitive.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 text-stone-400" />
      </Primitive.Icon>
    </Primitive.Trigger>
  );
}
export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        position={position}
        sideOffset={4}
        className={cn(
          "relative z-[80] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-stone-200 bg-white text-stone-800 shadow-xl",
          className,
        )}
        {...props}
      >
        <Primitive.ScrollUpButton className="flex h-6 items-center justify-center">
          <ChevronUp size={14} />
        </Primitive.ScrollUpButton>
        <Primitive.Viewport className="p-1">{children}</Primitive.Viewport>
        <Primitive.ScrollDownButton className="flex h-6 items-center justify-center">
          <ChevronDown size={14} />
        </Primitive.ScrollDownButton>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "relative flex min-h-8 cursor-default select-none items-center rounded-sm py-1.5 pl-7 pr-3 text-xs outline-none focus:bg-emerald-50 focus:text-emerald-950 data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <Primitive.ItemIndicator>
          <Check size={14} />
        </Primitive.ItemIndicator>
      </span>
      <Primitive.ItemText>{children}</Primitive.ItemText>
    </Primitive.Item>
  );
}
export function SelectLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn("px-2 py-1.5 text-[11px] font-medium text-stone-400", className)}
      {...props}
    />
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean; group?: string };
export function SelectField({
  value,
  onValueChange,
  options,
  label,
  className,
  title,
  disabled,
  placeholder,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  className?: string;
  title?: string;
  disabled?: boolean;
  placeholder?: string;
  children?: ReactNode;
}) {
  const groups = [...new Set(options.map((option) => option.group ?? ""))];
  return (
    <Select value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger aria-label={label} title={title} className={className}>
        <SelectValue placeholder={placeholder}>{children}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {groups.map((group) => (
          <SelectGroup key={group}>
            {group && <SelectLabel>{group}</SelectLabel>}
            {options
              .filter((option) => (option.group ?? "") === group)
              .map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
