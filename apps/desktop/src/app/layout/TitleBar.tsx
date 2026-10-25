import { Button } from "@/shared/ui/button";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { VersionDialog } from "@/features/about/components/VersionDialog";
import { MessageDialog } from "@/shared/ui/MessageDialog";
import appIcon from "../../../app-icon.svg";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { useFileStore } from "@/features/file-input/model/file-store";

export function TitleBar() {
  const persistenceError = useFileStore((state) => state.persistenceError);
  const dismissPersistenceError = useFileStore((state) => state.dismissPersistenceError);
  const [error, setError] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | undefined;
    const sync = async () => {
      const value = await window.isMaximized();
      if (active) setMaximized(value);
    };
    void sync().catch(() => {});
    void window
      .onResized(() => {
        void sync().catch(() => {});
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  async function control(action: "minimize" | "toggleMaximize" | "close") {
    if (!isTauri()) return;
    try {
      await getCurrentWindow()[action]();
      if (action === "toggleMaximize") setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      setError("창 제어에 실패했습니다. 다시 시도해 주세요.");
    }
  }
  return (
    <>
      <header className="pointer-events-auto relative z-[60] flex h-10 shrink-0 select-none items-center border-b border-stone-200 bg-stone-100">
        <div data-tauri-drag-region className="flex h-full shrink-0 items-center gap-2 px-3">
          <img src={appIcon} alt="" className="pointer-events-none size-6" />
          <span className="pointer-events-none text-sm font-semibold">Paperkit</span>
        </div>
        <WorkspaceTabs />
        <VersionDialog />
        {(
          [
            { action: "minimize", label: "창 최소화", Icon: Minus },
            {
              action: "toggleMaximize",
              label: maximized ? "이전 크기로 복원" : "창 최대화",
              Icon: maximized ? Copy : Square,
            },
            { action: "close", label: "앱 닫기", Icon: X },
          ] as const
        ).map(({ action, label, Icon }) => (
          <Button
            variant="ghost"
            key={action}
            aria-label={label}
            title={label}
            onClick={() => void control(action)}
            className={`flex h-full w-12 cursor-pointer items-center justify-center ${action === "close" ? "hover:bg-red-600 hover:text-white" : "hover:bg-stone-100"}`}
          >
            <Icon size={action === "close" ? 22 : 15} />
          </Button>
        ))}
      </header>
      <MessageDialog message={error} onDismiss={() => setError(null)} />
      <MessageDialog
        title="탭 복원 및 저장"
        message={persistenceError}
        onDismiss={dismissPersistenceError}
      />
    </>
  );
}
