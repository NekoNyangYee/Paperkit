import { authConfig, supabase } from "@/features/auth/lib/client";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { UserFacingError, errorFallbacks } from "@/shared/lib/errors";
import { requestSession, refreshRequestSession } from "@/features/auth/lib/request-session";

export interface LibraryDocument {
  id: string;
  sourcePath: string;
  displayName: string;
  sizeBytes: number;
  lastOpenedAt: number;
  favorite: boolean;
}
export type ToolKind = "image" | "text" | "watermark" | "signature";
export interface LibraryTool {
  id: string;
  name: string;
  kind: ToolKind;
  content: string;
  createdAt: number;
}
export type NewTool = Pick<LibraryTool, "name" | "kind" | "content">;

export async function libraryRequest<T>(
  path: string,
  init: RequestInit = {},
  owner = useAuthStore.getState().session?.user.id,
): Promise<T> {
  if (!supabase || !authConfig || !owner)
    throw new UserFacingError("로그인한 뒤 다시 이용해 주세요.");
  const sameOwner = () => useAuthStore.getState().session?.user.id === owner;
  const session = await requestSession(owner);
  const options: RequestInit = {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
      Authorization: `Bearer ${session.access_token}`,
    },
    signal: AbortSignal.any(
      [init.signal, AbortSignal.timeout(20000)].filter((s): s is AbortSignal => !!s),
    ),
    redirect: "error",
    cache: "no-store",
  };
  const read = !init.method || init.method === "GET";
  const fallback = path.includes("/tools")
    ? errorFallbacks[read ? "tools" : init.method === "DELETE" ? "toolRemove" : "toolSave"]
    : path.endsWith("/favorite")
      ? errorFallbacks.favorite
      : init.method === "DELETE"
        ? errorFallbacks.remove
        : errorFallbacks.library;
  let response: Response | undefined;
  // Retry one transient read. Never replay a mutation after a transport failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(`${authConfig.api}/v1${path}`, options);
      if (
        attempt === 0 &&
        (!init.method || init.method === "GET") &&
        [502, 503, 504].includes(response.status)
      ) {
        await response.body?.cancel();
        await retryDelay(options.signal);
        continue;
      }
      break;
    } catch (cause) {
      if (options.signal?.aborted) throw new UserFacingError(fallback, { cause });
      if (attempt === 0 && (!init.method || init.method === "GET")) {
        await retryDelay(options.signal);
        continue;
      }
      throw new UserFacingError(fallback, { cause });
    }
  }
  if (!response) throw new UserFacingError(fallback);
  if (!sameOwner()) throw new UserFacingError("로그인을 다시 확인해 주세요.");
  if (response.status === 401) {
    await response.body?.cancel();
    const renewed = await refreshRequestSession(owner, session.access_token);
    if (!sameOwner() || options.signal?.aborted) throw new UserFacingError(fallback);
    try {
      // An authorization rejection happens before the API handler runs, so this
      // single retry cannot repeat a write that the backend already accepted.
      response = await fetch(`${authConfig.api}/v1${path}`, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${renewed.access_token}` },
      });
    } catch (cause) {
      throw new UserFacingError(fallback, { cause });
    }
    if (!sameOwner()) throw new UserFacingError("계정 정보를 다시 확인해 주세요.");
  }
  if (!response.ok) {
    if (response.status === 401)
      throw new UserFacingError("계정 연결을 잠시 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
    if (response.status === 404 && !path.startsWith("/library/"))
      throw new UserFacingError("목록이 바뀐 것 같아요. 새로고침한 뒤 다시 선택해 주세요.");
    if (response.status === 429)
      throw new UserFacingError(
        "잠시 쉬었다가 다시 시도해 주세요. 요청을 차례로 처리하고 있습니다.",
      );
    if (response.status === 413)
      throw new UserFacingError("이미지 크기를 조금 줄여 다시 선택해 주세요.");
    throw new UserFacingError(fallback);
  }
  let value: unknown;
  try {
    value = response.status === 204 ? undefined : await response.json();
  } catch (cause) {
    throw new UserFacingError(fallback, { cause });
  }
  if (!sameOwner()) throw new UserFacingError("로그인을 다시 확인해 주세요.");
  return value as T;
}

function retryDelay(signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new UserFacingError("잠시 후 다시 시도해 주세요."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 350);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function getTools(owner: string) {
  const values = await libraryRequest<LibraryTool[]>("/library/tools", {}, owner);
  if (
    !Array.isArray(values) ||
    !values.every(
      (v) =>
        v &&
        typeof v.id === "string" &&
        typeof v.name === "string" &&
        ["image", "text", "watermark", "signature"].includes(v.kind) &&
        typeof v.content === "string" &&
        Number.isFinite(v.createdAt) &&
        (!["image", "signature"].includes(v.kind) ||
          v.content.startsWith("data:image/png;base64,")),
    )
  )
    throw new Error("도구함 응답을 읽지 못했습니다.");
  return values;
}

export async function getDocuments(query: URLSearchParams, signal: AbortSignal, owner: string) {
  const values = await libraryRequest<LibraryDocument[]>(
    `/library/documents?${query}`,
    { signal },
    owner,
  );
  if (
    !Array.isArray(values) ||
    !values.every(
      (v) =>
        v &&
        typeof v.id === "string" &&
        typeof v.sourcePath === "string" &&
        typeof v.displayName === "string" &&
        Number.isFinite(v.sizeBytes) &&
        Number.isFinite(v.lastOpenedAt) &&
        typeof v.favorite === "boolean",
    )
  )
    throw new Error("문서함 응답을 읽지 못했습니다.");
  return values;
}
