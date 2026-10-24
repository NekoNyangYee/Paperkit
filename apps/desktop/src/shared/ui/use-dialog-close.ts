import { useCallback, useEffect, useRef, useState } from "react";

// Keep the owner mounted while Radix Presence plays the shared modal exit animation.
export function useDialogClose(onClosed: () => void) {
  const [open, setOpen] = useState(true);
  const callback = useRef(onClosed);
  callback.current = onClosed;
  useEffect(() => {
    if (open) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => callback.current(), reduced ? 0 : 160);
    return () => window.clearTimeout(timer);
  }, [open]);
  const close = useCallback(() => setOpen(false), []);
  return { open, close };
}
