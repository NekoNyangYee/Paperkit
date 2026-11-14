import type { Session } from "@supabase/supabase-js";
import { authConfig, supabase } from "./client";
import { signOut, useAuthStore } from "../model/auth-store";
import { UserFacingError } from "@/shared/lib/errors";
import { captureAccount, accountIsCurrent } from "./account-scope";

const unavailable = "계정 연결을 잠시 확인할 수 없어요. 잠시 후 다시 시도해 주세요.";
const changed = "계정 정보를 다시 확인하고 있어요. 잠시 후 다시 시도해 주세요.";
let refreshing: { owner: string; generation: number; promise: Promise<Session> } | undefined;

function checkOwner(owner: string) {
  if (useAuthStore.getState().session?.user.id !== owner) throw new UserFacingError(changed);
}
function accept(
  session: Session | null,
  owner: string,
  scope: ReturnType<typeof captureAccount>,
): Session {
  checkOwner(owner);
  if (!accountIsCurrent(scope)) throw new UserFacingError(changed);
  if (!session?.access_token || session.user.id !== owner) throw new UserFacingError(changed);
  // Keep the account UI and the SDK on the same credential after restoration/rotation.
  if (useAuthStore.getState().session?.access_token !== session.access_token)
    useAuthStore.setState({ session });
  return session;
}

export async function requestSession(owner: string): Promise<Session> {
  checkOwner(owner);
  const scope = captureAccount(owner);
  if (!supabase || !authConfig) throw new UserFacingError(unavailable);
  let result;
  try {
    result = await supabase.auth.getSession();
  } catch (cause) {
    throw new UserFacingError(unavailable, { cause });
  }
  checkOwner(owner);
  if (!accountIsCurrent(scope)) throw new UserFacingError(changed);
  if (result.error) throw new UserFacingError(unavailable, { cause: result.error });
  if (result.data.session) return accept(result.data.session, owner, scope);
  // A development reload can leave the account store populated while a new SDK
  // instance has no in-memory session. Restore through Auth, never reuse a token blindly.
  return refreshRequestSession(owner);
}

export function refreshRequestSession(owner: string, rejectedToken?: string): Promise<Session> {
  checkOwner(owner);
  const scope = captureAccount(owner);
  if (refreshing?.owner === owner && refreshing.generation === scope.generation)
    return refreshing.promise;
  const promise = (async () => {
    if (!supabase || !authConfig) throw new UserFacingError(unavailable);
    let current;
    try {
      current = await supabase.auth.getSession();
    } catch (cause) {
      throw new UserFacingError(unavailable, { cause });
    }
    checkOwner(owner);
    if (!accountIsCurrent(scope)) throw new UserFacingError(changed);
    const session = current.data.session;
    if (current.error) throw new UserFacingError(unavailable, { cause: current.error });
    // Another concurrent request may already have rotated the rejected token.
    if (rejectedToken && session?.access_token && session.access_token !== rejectedToken)
      return accept(session, owner, scope);
    const token =
      session?.user.id === owner
        ? session.refresh_token
        : useAuthStore.getState().session?.refresh_token;
    if (!token)
      throw new UserFacingError("로그인을 한 번 더 연결해 주세요. 열어 둔 파일은 유지됩니다.");
    let result;
    try {
      result = await supabase.auth.refreshSession({ refresh_token: token });
    } catch (cause) {
      throw new UserFacingError(unavailable, { cause });
    }
    checkOwner(owner);
    if (!accountIsCurrent(scope)) throw new UserFacingError(changed);
    if (result.error) {
      if ([400, 401, 403].includes(result.error.status ?? 0)) {
        await signOut();
        throw new UserFacingError("로그인 연결이 만료됐어요. 다시 로그인해 주세요.");
      }
      throw new UserFacingError(unavailable, { cause: result.error });
    }
    return accept(result.data.session, owner, scope);
  })();
  const pending = { owner, generation: scope.generation, promise };
  refreshing = pending;
  void promise
    .finally(() => {
      if (refreshing === pending) refreshing = undefined;
    })
    .catch(() => {});
  return promise;
}
