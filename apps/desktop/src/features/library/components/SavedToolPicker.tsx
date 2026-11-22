import { ActionButton } from "@/shared/ui/action-button";
import { useRef, useState } from "react";
import { Archive, ChevronDown } from "lucide-react";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { userErrorMessage } from "@/shared/lib/errors";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { useTools } from "../model/tool-store";
import type { LibraryTool, ToolKind } from "../lib/api";

type PickerProps = {
  kind: ToolKind;
  label: string;
  disabled?: boolean;
  inline?: boolean;
  onPick: (tool: LibraryTool) => void | Promise<boolean>;
};

export function SavedToolPicker(props: PickerProps) {
  const owner = useAuthStore((state) => state.session?.user.id);
  return owner ? <AccountPicker key={owner} {...props} /> : null;
}

function AccountPicker({ kind, label, disabled, inline, onPick }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { owner, tools, loading, error, load } = useTools(open);
  const [pickError, setPickError] = useState<string | null>(null);
  const working = useRef(false);
  const items = tools.filter((tool) => tool.kind === kind);
  async function pick(tool: LibraryTool) {
    if (working.current || owner !== useAuthStore.getState().session?.user.id) return;
    working.current = true;
    setBusy(true);
    setPickError(null);
    try {
      if ((await onPick(tool)) !== false) setOpen(false);
    } catch (cause) {
      setPickError(
        userErrorMessage(
          cause,
          kind === "text" ? "clipboard" : kind === "signature" ? "signature" : "image",
        ),
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function changeOpen(next: boolean) {
    if (working.current) return;
    setPickError(null);
    setOpen(next);
  }

  const choices = (
    <>
      {items.map((tool) => (
        <button
          key={tool.id}
          type="button"
          disabled={busy}
          onClick={() => void pick(tool)}
          className="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-stone-100 focus-visible:outline-emerald-700"
          aria-label={tool.name}
        >
          {(kind === "image" || kind === "signature") && (
            <img
              src={tool.content}
              alt=""
              className="size-10 shrink-0 rounded border border-stone-200 object-contain"
            />
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{tool.name}</span>
            {(kind === "text" || kind === "watermark") && (
              <span className="block truncate text-xs text-stone-500">{tool.content}</span>
            )}
          </span>
        </button>
      ))}
      {!items.length && !error && (
        <p role="status" className="p-2 text-xs text-stone-500">
          {loading ? "도구를 불러오는 중…" : "이 종류로 보관한 도구가 없습니다."}
        </p>
      )}
      {(error || pickError) && (
        <p role="alert" className="p-2 text-xs text-red-700">
          {pickError ?? error}
        </p>
      )}
      {error && owner && (
        <ActionButton
          action="retry"
          variant="ghost"
          size="sm"
          disabled={busy || loading}
          onClick={() => void load(owner, true)}
        />
      )}
    </>
  );
  const trigger = (
    <Button
      type="button"
      variant={inline ? "outline" : "ghost"}
      size="sm"
      disabled={disabled || busy}
      aria-expanded={open}
      onClick={inline ? () => changeOpen(!open) : undefined}
      className={inline ? "w-full justify-start gap-2" : "shrink-0 gap-1.5 text-xs"}
    >
      <Archive size={15} aria-hidden="true" />
      {label}
      {inline && (
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={open ? "ml-auto rotate-180" : "ml-auto"}
        />
      )}
    </Button>
  );
  if (inline)
    return (
      <section className="relative min-h-0 shrink-0">
        {trigger}
        {open && (
          <div
            role="region"
            aria-label={label}
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-[min(26vh,12rem)] overflow-y-auto overscroll-contain rounded-lg border border-stone-200 bg-white p-1 shadow-md"
          >
            {choices}
          </div>
        )}
      </section>
    );
  return (
    <Popover modal open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        aria-label={label}
        align="start"
        className="max-h-72 w-64 overflow-y-auto p-2"
      >
        {choices}
      </PopoverContent>
    </Popover>
  );
}
