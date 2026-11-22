import type { ComponentProps } from "react";
import {
  Check,
  LoaderCircle,
  FileInput,
  FolderOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  Play,
} from "lucide-react";
import { Button } from "./button";

const actions = {
  save: [Save, "저장"],
  delete: [Trash2, "삭제"],
  apply: [Check, "적용"],
  select: [Check, "선택"],
  edit: [Pencil, "수정"],
  retry: [RefreshCw, "다시 시도"],
  reset: [RotateCcw, "초기화"],
  discard: [Undo2, "버리기"],
  proceed: [Play, "계속"],
  open: [FolderOpen, "열기"],
  import: [FileInput, "불러오기"],
} as const;

export type ButtonAction = keyof typeof actions;
export function ActionButton({
  action,
  busy = false,
  ...props
}: Omit<ComponentProps<typeof Button>, "asChild" | "children"> & {
  action: ButtonAction;
  busy?: boolean;
}) {
  const [Icon, label] = actions[action];
  return (
    <Button {...props} aria-busy={busy || undefined} disabled={busy || props.disabled}>
      {busy ? (
        <LoaderCircle
          size={16}
          className="animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <Icon size={16} aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}
