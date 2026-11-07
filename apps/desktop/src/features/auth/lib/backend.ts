import { authConfig, supabase } from "./client";
import { useAuthStore } from "@/features/auth/model/auth-store";

export async function backendIdentity(signal?: AbortSignal): Promise<{ id: string }> {
  const owner = useAuthStore.getState().session?.user.id;
  if (!supabase || !authConfig || !owner) throw new Error("로그인이 필요합니다.");
  const { data, error } = await supabase.auth.getSession();
  if (
    error ||
    !data.session ||
    data.session.user.id !== owner ||
    useAuthStore.getState().session?.user.id !== owner
  )
    throw new Error("로그인이 변경되었습니다.");
  const response = await fetch(`${authConfig.api}/v1/me`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` },
    signal: AbortSignal.any(
      [signal, AbortSignal.timeout(15000)].filter((value): value is AbortSignal => !!value),
    ),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("계정 연결을 확인하지 못했습니다.");
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    value.id !== owner ||
    useAuthStore.getState().session?.user.id !== owner
  )
    throw new Error("계정 연결을 확인하지 못했습니다.");
  return { id: owner };
}
