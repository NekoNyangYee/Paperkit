let guard: (() => Promise<boolean>) | null = null;

export function registerExitGuard(next: () => Promise<boolean>) {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

export async function approveAppExit() {
  return guard ? guard() : true;
}
