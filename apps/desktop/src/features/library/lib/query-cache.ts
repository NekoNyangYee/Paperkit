import { QueryClient } from "@tanstack/react-query";
import {
  captureAccount,
  accountIsCurrent,
  onAccountChange,
} from "@/features/auth/lib/account-scope";
import { UserFacingError } from "@/shared/lib/errors";
import type { LibraryTool } from "./api";

export const libraryQueries = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});
export const libraryKey = (owner: string, resource: "documents" | "tools") =>
  ["library", owner, resource] as const;
const unsubscribe = onAccountChange(() => libraryQueries.clear());
import.meta.hot?.dispose(() => {
  unsubscribe();
  libraryQueries.clear();
});

export async function cachedLibraryRead<T>(
  owner: string,
  resource: "documents" | "tools",
  params: string,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const scope = captureAccount(owner);
  const value = await libraryQueries.fetchQuery({
    queryKey: [...libraryKey(owner, resource), params],
    queryFn: async ({ signal }) => {
      const value = await read(signal);
      if (!accountIsCurrent(scope))
        throw new UserFacingError("계정이 바뀌었습니다. 다시 선택해 주세요.");
      return value;
    },
  });
  if (!accountIsCurrent(scope))
    throw new UserFacingError("계정이 바뀌었습니다. 다시 선택해 주세요.");
  // Limit short-lived search/page variants as well as their time-to-live.
  const settled = libraryQueries
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.fetchStatus === "idle")
    .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
  while (settled.length > 64)
    libraryQueries.removeQueries({ queryKey: settled.shift()!.queryKey, exact: true });
  return value;
}
export function invalidateLibrary(owner: string, resource: "documents" | "tools") {
  void libraryQueries.cancelQueries({ queryKey: libraryKey(owner, resource) });
  void libraryQueries.invalidateQueries({
    queryKey: libraryKey(owner, resource),
    refetchType: "none",
  });
}
export function cacheTools(owner: string, tools: LibraryTool[]) {
  const key = [...libraryKey(owner, "tools"), ""];
  // A create may finish before the initial list. Never mark a partial list fresh.
  if (libraryQueries.getQueryData(key) !== undefined) libraryQueries.setQueryData(key, tools);
}
