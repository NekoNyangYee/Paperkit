import { create } from "zustand";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { getTools, libraryRequest, type LibraryTool, type NewTool } from "../lib/api";
import { userErrorMessage } from "@/shared/lib/errors";

interface ToolState {
  owner: string | null;
  tools: LibraryTool[];
  loading: boolean;
  error: string | null;
  load: (owner: string) => Promise<void>;
  add: (input: NewTool, owner: string) => Promise<void>;
  update: (id: string, input: NewTool, owner: string) => Promise<void>;
  remove: (id: string, owner: string) => Promise<void>;
}
let generation = 0;
export const useToolStore = create<ToolState>((set, get) => ({
  owner: null,
  tools: [],
  loading: false,
  error: null,
  load: async (owner) => {
    const request = ++generation;
    set({ owner, tools: get().owner === owner ? get().tools : [], loading: true, error: null });
    try {
      const tools = await getTools(owner);
      if (request === generation && useAuthStore.getState().session?.user.id === owner)
        set({ tools, loading: false });
    } catch (cause) {
      if (request === generation && useAuthStore.getState().session?.user.id === owner)
        set({
          loading: false,
          error: userErrorMessage(cause, "tools"),
        });
    }
  },
  add: async (input, owner) => {
    const tool = await libraryRequest<LibraryTool>(
      "/library/tools",
      { method: "POST", body: JSON.stringify(input) },
      owner,
    );
    if (useAuthStore.getState().session?.user.id !== owner) return;
    ++generation;
    set({
      owner,
      tools: [tool, ...(get().owner === owner ? get().tools : [])],
      error: null,
      loading: false,
    });
  },
  update: async (id, input, owner) => {
    const tool = await libraryRequest<LibraryTool>(
      `/library/tools/${id}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
      owner,
    );
    if (useAuthStore.getState().session?.user.id !== owner || get().owner !== owner) return;
    ++generation;
    set({
      tools: get().tools.map((previous) => (previous.id === id ? tool : previous)),
      error: null,
      loading: false,
    });
  },
  remove: async (id, owner) => {
    await libraryRequest(`/library/tools/${id}`, { method: "DELETE" }, owner);
    if (useAuthStore.getState().session?.user.id !== owner) return;
    ++generation;
    if (get().owner === owner)
      set({ tools: get().tools.filter((tool) => tool.id !== id), loading: false });
  },
}));
useAuthStore.subscribe((state, previous) => {
  if (state.session?.user.id !== previous.session?.user.id) {
    ++generation;
    useToolStore.setState({ owner: null, tools: [], loading: false, error: null });
  }
});
