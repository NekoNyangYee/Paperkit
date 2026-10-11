import { create } from "zustand";
import {
  clearSelection,
  errorMessage,
  inspectFile,
  isDesktop,
  synchronizeSelection,
} from "../lib/desktop";
import type { FileInfo, SelectionSnapshot } from "../lib/desktop";

type Phase = "idle" | "restoring" | "checking" | "clearing" | "selected" | "error";
interface AppStore {
  file: FileInfo | null;
  phase: Phase;
  error: string | null;
  ready: boolean;
  revision: number;
  openedFileId: string | null;
  openFile: () => void;
  initialize: () => Promise<void>;
  receive: (paths: string[]) => Promise<void>;
  clear: () => Promise<void>;
  reportError: (cause: unknown) => void;
}

// Rust owns the selection. Zustand only mirrors serialized snapshots.
export const useAppStore = create<AppStore>((set, get) => {
  const apply = (result: SelectionSnapshot) =>
    set({
      file: result.file,
      revision: result.revision,
      openedFileId: result.file?.id === get().openedFileId ? get().openedFileId : null,
      phase: result.error ? "error" : result.file ? "selected" : "idle",
      error: result.error,
    });
  const run = async (operation: "check" | "clear", paths: string[] = []) => {
    if (!get().ready) return;
    const revision = get().revision + 1;
    set({ revision, phase: operation === "check" ? "checking" : "clearing", error: null });
    try {
      const result =
        operation === "check" ? await inspectFile(paths, revision) : await clearSelection(revision);
      if (get().revision === revision) apply(result);
    } catch (cause) {
      if (get().revision === revision) set({ phase: "error", error: errorMessage(cause) });
    }
  };
  return {
    file: null,
    phase: "idle",
    error: null,
    ready: false,
    revision: 0,
    openedFileId: null,
    openFile: () => {
      const { file, ready, phase } = get();
      if (ready && file && (phase === "selected" || phase === "error")) {
        set({ openedFileId: file.id });
      }
    },
    initialize: async () => {
      if (!isDesktop() || get().ready || get().phase === "restoring") return;
      set({ phase: "restoring", error: null });
      try {
        apply(await synchronizeSelection());
        set({ ready: true });
      } catch (cause) {
        set({ phase: "error", error: errorMessage(cause) });
      }
    },
    receive: (paths) => run("check", paths),
    clear: () => run("clear"),
    reportError: (cause) => set({ error: errorMessage(cause), phase: "error" }),
  };
});
