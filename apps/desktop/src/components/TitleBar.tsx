import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { VersionDialog } from "./VersionDialog";
import { MessageDialog } from "./MessageDialog";
import appIcon from "../../app-icon.svg";

export function TitleBar() {
  const [error, setError] = useState<string | null>(null);
  async function control(action: "minimize" | "toggleMaximize" | "close") {
    if (!isTauri()) return;
    try {
      await getCurrentWindow()[action]();
    } catch {
      setError("창 제어에 실패했습니다. 다시 시도해 주세요.");
    }
  }
  return (
    <>
      <header className="pointer-events-auto relative z-[60] flex h-10 shrink-0 select-none items-center border-b border-stone-200 bg-white">
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
          <img src={appIcon} alt="" className="pointer-events-none size-6" />
          <span className="pointer-events-none text-sm font-semibold">Paperkit</span>
          <span className="pointer-events-none text-xs text-stone-400">PDF 편집기</span>
        </div>
        <VersionDialog />
        {(
          [
            { action: "minimize", label: "창 최소화", Icon: Minus },
            { action: "toggleMaximize", label: "창 최대화 / 복원", Icon: Square },
            { action: "close", label: "앱 닫기", Icon: X },
          ] as const
        ).map(({ action, label, Icon }) => (
          <button
            key={action}
            aria-label={label}
            title={label}
            onClick={() => void control(action)}
            className={`flex h-full w-12 cursor-pointer items-center justify-center ${action === "close" ? "hover:bg-red-600 hover:text-white" : "hover:bg-stone-100"}`}
          >
            <Icon size={15} />
          </button>
        ))}
      </header>
      <MessageDialog message={error} onDismiss={() => setError(null)} />
    </>
  );
}
