import type { ComponentProps, ReactElement, ReactNode } from "react";
import * as Menu from "@radix-ui/react-context-menu";
import { cn } from "@/shared/lib/utils";

const nativeEditing = "input, textarea, select, [contenteditable]:not([contenteditable=false])";

/** shadcn/ui context menu using the same Radix primitives and palette as our other menus. */
export function ActionContextMenu({
  children,
  label,
  items,
}: {
  children: ReactElement;
  label: string;
  items: ReactNode;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        asChild
        data-paperkit-context-trigger=""
        onContextMenuCapture={(event) => {
          const target = event.target;
          // Preserve native spellcheck, selection and clipboard actions while typing.
          if (target instanceof Element && target.closest(nativeEditing)) {
            event.stopPropagation();
          } else if (
            target instanceof Element &&
            !event.currentTarget.contains(target) &&
            !target.closest("[data-paperkit-context-trigger]")
          ) {
            // A dialog or an open menu is portalled outside the workspace.
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          const target = event.target;
          if (
            !(target instanceof Element) ||
            target.closest(nativeEditing) ||
            target.closest("[data-paperkit-context-trigger]") !== event.currentTarget
          )
            return;
          event.preventDefault();
          const bounds = target.getBoundingClientRect();
          target.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: bounds.left + Math.min(24, bounds.width / 2),
              clientY: bounds.top + Math.min(24, bounds.height / 2),
            }),
          );
        }}
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          aria-label={label}
          collisionPadding={6}
          onContextMenu={(event) => event.preventDefault()}
          className="z-[80] min-w-44 max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto rounded-lg border border-stone-200 bg-white p-1 text-stone-800 shadow-lg outline-none"
        >
          {items}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function ContextMenuItem({
  destructive,
  className,
  ...props
}: ComponentProps<typeof Menu.Item> & { destructive?: boolean }) {
  return (
    <Menu.Item
      {...props}
      className={cn(
        "flex cursor-default select-none items-center gap-2.5 rounded px-2.5 py-2 text-sm leading-none outline-none data-[highlighted]:bg-stone-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0",
        destructive && "text-red-700 data-[highlighted]:bg-red-50",
        className,
      )}
    />
  );
}
export function ContextMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-stone-200" />;
}
