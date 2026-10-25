import { useEffect, useRef, type RefObject } from "react";
import { FileText, Plus, X } from "lucide-react";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { KeyboardSensor, PointerSensor, PointerActivationConstraints } from "@dnd-kit/dom";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { useFileStore, type WorkspaceTab } from "@/features/file-input/model/file-store";

const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 180, tolerance: 8 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor,
];

function SortableTab({
  tab,
  index,
  disabled,
  container,
}: {
  tab: WorkspaceTab;
  index: number;
  disabled: boolean;
  container: RefObject<HTMLDivElement | null>;
}) {
  const active = useFileStore((state) => state.activeTabId === tab.id);
  const { activateTab, closeTab, moveTab, reportError } = useFileStore.getState();
  const { ref, handleRef, isDragging } = useSortable({
    id: tab.id,
    index,
    disabled,
    modifiers: [RestrictToElement.configure({ element: () => container.current })],
  });
  const label = tab.file?.name ?? "새 탭";
  const close = () => {
    void closeTab(tab.id).catch(reportError);
  };
  return (
    <div
      ref={ref}
      data-workspace-tab={tab.id}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          close();
        }
      }}
      className={`@container relative flex h-full min-w-0 flex-1 items-center overflow-hidden border-r border-stone-200 ${active ? "bg-white text-stone-900" : "bg-stone-100 text-stone-500 hover:bg-stone-200/60"} ${isDragging ? "z-10 shadow-md" : ""}`}
    >
      <button
        ref={handleRef}
        type="button"
        role="tab"
        id={`tab-${tab.id}`}
        aria-label={label}
        aria-controls={`panel-${tab.id}`}
        aria-selected={active}
        aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
        tabIndex={active ? 0 : -1}
        disabled={disabled}
        title={tab.file?.path ?? label}
        onClick={() => activateTab(tab.id)}
        onKeyDown={(event) => {
          if (isDragging) return;
          const tabs = useFileStore.getState().tabs;
          const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : offset
                  ? (index + offset + tabs.length) % tabs.length
                  : -1;
          if (offset && event.altKey && event.shiftKey) {
            event.preventDefault();
            moveTab(tab.id, tabs[next].id);
            return;
          }
          if (next >= 0) {
            event.preventDefault();
            activateTab(tabs[next].id);
            document.getElementById(`tab-${tabs[next].id}`)?.focus();
          }
          if (event.key === "Delete") {
            event.preventDefault();
            close();
          }
        }}
        className="flex h-full min-w-0 flex-1 touch-none items-center gap-2 overflow-hidden px-2 text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-50 @min-[120px]:px-3"
      >
        <FileText size={14} className="hidden shrink-0 @min-[120px]:block" aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
        {tab.dirty && (
          <span
            aria-label="저장하지 않은 변경"
            className="size-1.5 shrink-0 rounded-full bg-emerald-700"
          />
        )}
      </button>
      <button
        type="button"
        aria-label={`${label} 탭 닫기`}
        title="탭 닫기 (Ctrl+W)"
        disabled={disabled}
        onClick={close}
        className="grid size-8 shrink-0 touch-manipulation place-items-center hover:bg-stone-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-700"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

export function WorkspaceTabs() {
  const { tabs, activeTabId, ready, phase, newTab, activateTab, closeTab, moveTab, reportError } =
    useFileStore();
  const container = useRef<HTMLDivElement>(null);
  const sorting = useRef(false);
  const disabled = !ready || phase === "checking" || phase === "restoring";
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        disabled ||
        sorting.current ||
        event.isComposing ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      )
        return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        newTab();
      } else if (key === "w") {
        event.preventDefault();
        void closeTab(activeTabId).catch(reportError);
      } else if (event.key === "Tab") {
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.id === activeTabId);
        activateTab(tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  return (
    <div className="flex h-full min-w-0 flex-1">
      <DragDropProvider
        sensors={sensors}
        onDragStart={() => {
          sorting.current = true;
        }}
        onDragEnd={(event) => {
          sorting.current = false;
          if (event.canceled) return;
          const { source } = event.operation;
          if (!isSortable(source) || source.initialIndex === source.index) return;
          const current = useFileStore.getState().tabs;
          const target = current[source.index];
          if (target) moveTab(String(source.id), target.id);
        }}
      >
        <div
          ref={container}
          role="tablist"
          aria-label="문서 탭"
          style={{ flexBasis: `${tabs.length * 208}px` }}
          className="flex h-full min-w-0 shrink overflow-hidden"
        >
          {tabs.map((tab, index) => (
            <SortableTab
              key={tab.id}
              tab={tab}
              index={index}
              disabled={disabled}
              container={container}
            />
          ))}
        </div>
      </DragDropProvider>
      <button
        type="button"
        aria-label="새 탭"
        title="새 탭 (Ctrl+T)"
        disabled={disabled}
        onClick={newTab}
        className="grid h-full w-10 shrink-0 touch-manipulation place-items-center hover:bg-stone-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-40"
      >
        <Plus size={18} />
      </button>
      <div data-tauri-drag-region className="h-full min-w-8 flex-1" />
    </div>
  );
}
