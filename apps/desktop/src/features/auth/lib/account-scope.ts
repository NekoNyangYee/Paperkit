import { useAuthStore } from "../model/auth-store";
import { UserFacingError } from "@/shared/lib/errors";

let owner = useAuthStore.getState().session?.user.id ?? null;
let generation = 0;
let controller = new AbortController();
const listeners = new Set<() => void>();
const unsubscribe = useAuthStore.subscribe?.((state) => {
  const next = state.session?.user.id ?? null;
  if (next === owner) return;
  owner = next;
  generation++;
  controller.abort();
  controller = new AbortController();
  listeners.forEach((listener) => listener());
});
import.meta.hot?.dispose(() => {
  unsubscribe?.();
  controller.abort();
  listeners.clear();
});

export function captureAccount(expected: string) {
  if (useAuthStore.getState().session?.user.id !== expected)
    throw new UserFacingError("계정이 바뀌었습니다. 다시 선택해 주세요.");
  return { owner: expected, generation, signal: controller.signal };
}
export function accountIsCurrent(scope: ReturnType<typeof captureAccount>) {
  return (
    scope.generation === generation &&
    !scope.signal.aborted &&
    useAuthStore.getState().session?.user.id === scope.owner
  );
}
export function onAccountChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
