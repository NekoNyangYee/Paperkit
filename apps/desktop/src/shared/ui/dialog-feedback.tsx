import {
  CircleCheck,
  FileWarning,
  Info,
  OctagonX,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

export type MessageKind = "info" | "success" | "warning" | "error";
export type ConfirmKind = "delete" | "reset" | "discard";

const appearance = {
  info: { Icon: Info, color: "bg-sky-50 text-sky-700" },
  success: { Icon: CircleCheck, color: "bg-emerald-50 text-emerald-700" },
  warning: { Icon: TriangleAlert, color: "bg-amber-50 text-amber-800" },
  error: { Icon: OctagonX, color: "bg-red-50 text-red-700" },
  delete: { Icon: Trash2, color: "bg-red-50 text-red-700" },
  reset: { Icon: RotateCcw, color: "bg-indigo-50 text-indigo-700" },
  discard: { Icon: FileWarning, color: "bg-amber-50 text-amber-800" },
};

export function DialogFeedbackIcon({ kind }: { kind: MessageKind | ConfirmKind }) {
  const { Icon, color } = appearance[kind];
  return (
    <span
      aria-hidden="true"
      className={`mb-4 inline-flex size-11 items-center justify-center rounded-xl ${color}`}
    >
      <Icon size={23} />
    </span>
  );
}
