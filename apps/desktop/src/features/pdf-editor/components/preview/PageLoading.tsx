import { FileText } from "lucide-react";

export function PageLoading({ page, percent }: { page: number; percent?: number }) {
  return (
    <div
      role="status"
      className="flex items-center gap-4 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700 shadow-sm"
    >
      <div
        aria-hidden="true"
        className="flex h-14 w-10 shrink-0 flex-col gap-1 rounded border border-emerald-100 bg-emerald-50 p-1.5 motion-safe:animate-pulse"
      >
        <FileText size={14} className="mb-1 text-emerald-700" />
        <span className="h-0.5 rounded bg-emerald-200" />
        <span className="h-0.5 w-2/3 rounded bg-emerald-200" />
      </div>
      <div className="flex-1">
        <div className="flex items-center justify-between gap-4">
          <span>{page}페이지 준비 중</span>
          {percent !== undefined && (
            <span className="text-xs tabular-nums text-emerald-800">{percent}%</span>
          )}
        </div>
        {percent === undefined ? (
          <div aria-hidden="true" className="mt-2 h-1 overflow-hidden rounded-full bg-emerald-100">
            <div className="h-full w-1/3 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
          </div>
        ) : (
          <progress
            aria-label="페이지 로딩 진행률"
            max={100}
            value={percent}
            className="mt-2 block h-1.5 w-full appearance-none overflow-hidden rounded-full bg-emerald-100 [&::-webkit-progress-bar]:bg-emerald-100 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-emerald-600"
          />
        )}
      </div>
    </div>
  );
}
