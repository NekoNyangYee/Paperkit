import { flushWorkspace } from "./workspace";

const guards = new Set<() => Promise<boolean>>();
let closing = false;

export function registerExitGuard(next: () => Promise<boolean>) {
  guards.add(next);
  return () => {
    guards.delete(next);
  };
}

export async function approveAppExit() {
  for (const guard of guards) if (!(await guard())) return false;
  await flushWorkspace();
  return true;
}

// All mounted documents share one native close flow, including inactive tabs.
export async function requestAppExit(exit: () => Promise<void>) {
  if (closing) return;
  closing = true;
  try {
    if (await approveAppExit()) await exit();
  } finally {
    closing = false;
  }
}
