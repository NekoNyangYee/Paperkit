import { create } from "zustand";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { getTools, libraryRequest, type LibraryTool, type NewTool } from "../lib/api";
import { userErrorMessage } from "@/shared/lib/errors";
import { captureAccount, accountIsCurrent } from "@/features/auth/lib/account-scope";
import { cacheTools, invalidateLibrary } from "../lib/query-cache";

interface ToolState {
  owner: string | null;
  tools: LibraryTool[];
  loading: boolean;
  error: string | null;
  load: (owner: string, force?: boolean) => Promise<void>;
  add: (input: NewTool, owner: string) => Promise<void>;
  update: (id: string, input: NewTool, owner: string) => Promise<void>;
  remove: (id: string, owner: string) => Promise<void>;
}
let generation = 0;
const loads = new Map<string, Promise<LibraryTool[]>>();
export const useToolStore = create<ToolState>((set, get) => ({
  owner: null,
  tools: [],
  loading: false,
  error: null,
  load: async (owner, force = false) => {
    if (useAuthStore.getState().session?.user.id !== owner) return;
    const scope = captureAccount(owner);
    if (force) invalidateLibrary(owner, "tools");
    const request = ++generation;
    set({ owner, tools: get().owner === owner ? get().tools : [], loading: true, error: null });
    const pending = loads.get(owner) ?? getTools(owner);
    loads.set(owner, pending);
    try {
      const tools = await pending;
      if (request === generation && accountIsCurrent(scope)) set({ tools, loading: false });
    } catch (cause) {
      if (request === generation && accountIsCurrent(scope))
        set({
          loading: false,
          error: userErrorMessage(cause, "tools"),
        });
    } finally {
      if (loads.get(owner) === pending) loads.delete(owner);
    }
  },
  add: async (input, owner) => {
    const scope = captureAccount(owner);
    const tool = await libraryRequest<LibraryTool>(
      "/library/tools",
      { method: "POST", body: JSON.stringify(input) },
      owner,
    );
    if (!accountIsCurrent(scope)) return;
    ++generation;
    set({
      owner,
      tools: [tool, ...(get().owner === owner ? get().tools : [])],
      error: null,
      loading: false,
    });
    cacheTools(owner, get().tools);
  },
  update: async (id, input, owner) => {
    const scope = captureAccount(owner);
    const tool = await libraryRequest<LibraryTool>(
      `/library/tools/${id}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
      owner,
    );
    if (!accountIsCurrent(scope) || get().owner !== owner) return;
    ++generation;
    set({
      tools: get().tools.map((previous) => (previous.id === id ? tool : previous)),
      error: null,
      loading: false,
    });
    cacheTools(owner, get().tools);
  },
  remove: async (id, owner) => {
    const scope = captureAccount(owner);
    await libraryRequest(`/library/tools/${id}`, { method: "DELETE" }, owner);
    if (!accountIsCurrent(scope)) return;
    ++generation;
    if (get().owner === owner) {
      set({ tools: get().tools.filter((tool) => tool.id !== id), loading: false });
      cacheTools(owner, get().tools);
    }
  },
}));
const stopAccountSubscription = useAuthStore.subscribe((state, previous) => {
  if (state.session?.user.id !== previous.session?.user.id) {
    ++generation;
    loads.clear();
    useToolStore.setState({ owner: null, tools: [], loading: false, error: null });
  }
});
import.meta.hot?.dispose(() => stopAccountSubscription());
