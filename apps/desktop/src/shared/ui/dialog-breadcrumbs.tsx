import { ChevronRight } from "lucide-react";
import { DialogTitle } from "./dialog";

export type DialogCrumb = { label: string; onClick: () => void };

export function DialogBreadcrumbs({
  parents,
  title,
  disabled,
}: {
  parents: DialogCrumb[];
  title: string;
  disabled?: boolean;
}) {
  return (
    <nav aria-label="현재 위치" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1.5">
        {parents.map((parent, index) => (
          <li key={index} className="flex min-w-0 items-center gap-1.5 text-stone-500">
            <button
              type="button"
              className="truncate text-sm hover:underline"
              disabled={disabled}
              onClick={parent.onClick}
            >
              {parent.label}
            </button>
            <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
          </li>
        ))}
        <li aria-current="page" className="min-w-0">
          <DialogTitle className="break-all text-lg font-semibold">{title}</DialogTitle>
        </li>
      </ol>
    </nav>
  );
}
