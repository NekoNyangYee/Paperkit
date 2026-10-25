import { create } from "zustand";
import {
  clearSelection,
  closeFile,
  errorMessage,
  inspectFile,
  isDesktop,
  synchronizeSelection,
  type FileInfo,
  type SelectionSnapshot,
} from "@/shared/desktop/files";
import { readWorkspace, writeWorkspace, type TabView } from "@/shared/desktop/workspace";

type Phase = "idle" | "restoring" | "checking" | "clearing" | "selected" | "error";
export interface WorkspaceTab {
  id: string;
  file: FileInfo | null;
  view?: TabView;
  dirty?: boolean;
}
const closeGuards = new Map<string, () => Promise<boolean>>();
export function registerTabCloseGuard(id: string, guard: () => Promise<boolean>) {
  closeGuards.set(id, guard);
  return () => {
    if (closeGuards.get(id) === guard) closeGuards.delete(id);
  };
}
interface AppStore {
  file: FileInfo | null;
  phase: Phase;
  error: string | null;
  persistenceError: string | null;
  ready: boolean;
  revision: number;
  openedFileId: string | null;
  tabs: WorkspaceTab[];
  activeTabId: string;
  newTab: () => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => Promise<void>;
  moveTab: (id: string, targetId: string) => void;
  updateView: (fileId: string, view: TabView) => void;
  dismissPersistenceError: () => void;
  openFile: () => void;
  initialize: () => Promise<void>;
  receive: (paths: string[]) => Promise<void>;
  replaceFile: (paths: string[]) => Promise<void>;
  clear: () => Promise<void>;
  reportError: (cause: unknown) => void;
}
const emptyTab = (): WorkspaceTab => ({ id: crypto.randomUUID(), file: null });
const initialTab = emptyTab();

// Client owns navigation; Rust validates files and owns live PDF sessions.
export const useFileStore = create<AppStore>((set, get) => {
  const persist = () => {
    if (!get().ready) return;
    const { tabs, activeTabId } = get();
    void writeWorkspace({
      version: 1,
      activeTabId,
      tabs: tabs.map(({ id, file, view }) => ({ id, path: file?.path ?? null, view })),
    }).catch(() =>
      set({
        persistenceError:
          "탭 상태를 저장하지 못했습니다. 앱을 다시 열면 이전 탭이 복원될 수 있습니다.",
      }),
    );
  };
  const select = (tabs: WorkspaceTab[], activeTabId: string) => {
    const tab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
    set({
      tabs,
      activeTabId: tab.id,
      file: tab.file,
      openedFileId: tab.file?.id ?? null,
      phase: tab.file ? "selected" : "idle",
      error: null,
    });
    persist();
  };
  const apply = (result: SelectionSnapshot, openImmediately = false) => {
    const file = result.file;
    if (openImmediately && !result.error && file) {
      const existing = get().tabs.find((tab) => tab.file?.path === file.path);
      if (existing) select(get().tabs, existing.id);
      else {
        const current = get().tabs.find((tab) => tab.id === get().activeTabId);
        const tab = { ...(current?.file ? emptyTab() : (current ?? emptyTab())), file };
        const tabs =
          current && !current.file
            ? get().tabs.map((item) => (item.id === tab.id ? tab : item))
            : [...get().tabs, tab];
        select(tabs, tab.id);
      }
      set({ revision: result.revision });
    } else
      set({
        file,
        revision: result.revision,
        openedFileId: file?.id === get().openedFileId ? get().openedFileId : null,
        phase: result.error ? "error" : file ? "selected" : "idle",
        error: result.error,
      });
  };
  const run = async (operation: "check" | "clear", paths: string[] = []) => {
    if (!get().ready) return;
    const revision = get().revision + 1;
    set({ revision, phase: operation === "check" ? "checking" : "clearing", error: null });
    try {
      const result =
        operation === "check" ? await inspectFile(paths, revision) : await clearSelection(revision);
      if (get().revision === revision) {
        if (result.error) set({ phase: "error", error: result.error });
        else apply(result, operation === "check");
      }
    } catch (cause) {
      if (get().revision === revision) set({ phase: "error", error: errorMessage(cause) });
    }
  };
  const closing = new Set<string>();
  return {
    file: null,
    phase: "idle",
    error: null,
    persistenceError: null,
    ready: false,
    revision: 0,
    openedFileId: null,
    tabs: [initialTab],
    activeTabId: initialTab.id,
    newTab: () => {
      if (!get().ready || get().phase === "checking") return;
      const tab = emptyTab();
      select([...get().tabs, tab], tab.id);
    },
    activateTab: (id) => {
      if (get().phase === "checking" || !get().tabs.some((tab) => tab.id === id)) return;
      select(get().tabs, id);
    },
    closeTab: async (id) => {
      if (closing.has(id) || get().phase === "checking") return;
      const tab = get().tabs.find((tab) => tab.id === id);
      if (!tab) return;
      closing.add(id);
      try {
        const guard = tab.file ? closeGuards.get(tab.file.id) : undefined;
        if (guard && !(await guard())) return;
        if (tab.file) await closeFile(tab.file.id);
        const index = get().tabs.findIndex((item) => item.id === id);
        let tabs = get().tabs.filter((item) => item.id !== id);
        if (!tabs.length) tabs = [emptyTab()];
        select(
          tabs,
          get().activeTabId === id ? tabs[Math.min(index, tabs.length - 1)].id : get().activeTabId,
        );
      } finally {
        closing.delete(id);
      }
    },
    moveTab: (id, targetId) => {
      if (id === targetId) return;
      const tabs = [...get().tabs];
      const from = tabs.findIndex((tab) => tab.id === id),
        to = tabs.findIndex((tab) => tab.id === targetId);
      if (from < 0 || to < 0) return;
      tabs.splice(to, 0, tabs.splice(from, 1)[0]);
      set({ tabs });
      persist();
    },
    updateView: (fileId, view) => {
      const tab = get().tabs.find((tab) => tab.file?.id === fileId);
      if (
        !tab ||
        (tab.view?.pageIndex === view.pageIndex &&
          tab.view.zoom === view.zoom &&
          tab.view.sidebarOpen === view.sidebarOpen)
      )
        return;
      set({ tabs: get().tabs.map((item) => (item.id === tab.id ? { ...item, view } : item)) });
      persist();
    },
    dismissPersistenceError: () => set({ persistenceError: null }),
    openFile: () => {
      const { file, ready, phase } = get();
      if (ready && file && (phase === "selected" || phase === "error"))
        apply({ file, revision: get().revision, error: null }, true);
    },
    initialize: async () => {
      if (!isDesktop() || get().ready || get().phase === "restoring") return;
      set({ phase: "restoring", error: null });
      try {
        const selection = await synchronizeSelection();
        set({
          file: selection.file,
          revision: selection.revision,
          openedFileId: null,
          error: selection.error,
        });
        let saved = null;
        try {
          saved = await readWorkspace();
        } catch {
          set({ persistenceError: "저장된 탭을 불러오지 못했습니다. 파일을 다시 열어주세요." });
        }
        if (saved) {
          const tabs: WorkspaceTab[] = [],
            failures: string[] = [];
          const paths = new Set<string>();
          for (const tab of saved.tabs) {
            if (!tab.path) {
              tabs.push({ id: tab.id, file: null, view: tab.view });
              continue;
            }
            try {
              const revision = get().revision + 1;
              set({ revision });
              const result = await inspectFile([tab.path], revision);
              set({ revision: result.revision });
              if (result.error || !result.file) throw new Error(result.error ?? "파일 없음");
              if (paths.has(result.file.path)) continue;
              paths.add(result.file.path);
              tabs.push({ id: tab.id, file: result.file, view: tab.view });
            } catch {
              failures.push(tab.path);
            }
          }
          if (!tabs.length) tabs.push(emptyTab());
          select(tabs, saved.activeTabId);
          if (failures.length)
            set({
              persistenceError: `다음 파일의 탭을 복원하지 못했습니다. 이동·삭제 또는 접근 권한을 확인해 주세요.\n${failures.join("\n")}`,
            });
        }
        set({ ready: true, phase: get().error ? "error" : get().file ? "selected" : "idle" });
      } catch (cause) {
        set({ phase: "error", error: errorMessage(cause) });
      }
    },
    receive: (paths) => run("check", paths),
    replaceFile: (paths) => run("check", paths),
    clear: async () => {
      const tab = get().tabs.find((tab) => tab.file?.id === get().openedFileId);
      if (tab) await get().closeTab(tab.id);
      else await run("clear");
    },
    reportError: (cause) => set({ error: errorMessage(cause), phase: "error" }),
  };
});
