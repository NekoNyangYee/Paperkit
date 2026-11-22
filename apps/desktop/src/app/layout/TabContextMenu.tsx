import type { ReactElement } from "react";
import { Plus, X } from "lucide-react";
import { ActionContextMenu, ContextMenuItem } from "@/shared/ui/context-menu";
import { useFileStore } from "@/features/file-input/model/file-store";
import { useAuthStore } from "@/features/auth/model/auth-store";

export function TabContextMenu({ tabId, children }: { tabId: string; children: ReactElement }) {
  const { ready, phase, tabs, scopeOwner, newTab, closeTab, reportError } = useFileStore();
  const switching = useAuthStore((s) => s.busy);
  const disabled =
    switching || !ready || phase === "checking" || phase === "restoring" || phase === "clearing";
  const tab = tabs.find((t) => t.id === tabId);
  return (
    <ActionContextMenu
      label="탭 작업"
      items={
        <>
          <ContextMenuItem disabled={disabled} onSelect={newTab}>
            <Plus />
            {scopeOwner ? "새 탭" : "새 탭 · 로그인 필요"}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={disabled || !tab || (tabs.length === 1 && !tab.file)}
            onSelect={() => void closeTab(tabId).catch(reportError)}
          >
            <X />탭 종료
          </ContextMenuItem>
        </>
      }
    >
      {children}
    </ActionContextMenu>
  );
}
