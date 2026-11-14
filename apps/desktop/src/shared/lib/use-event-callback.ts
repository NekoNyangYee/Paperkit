import { useCallback, useLayoutEffect, useRef } from "react";

// Keep heavy memoized views independent of toolbar/zoom renders, while their
// event handlers always observe the latest document state.
export function useEventCallback<A extends unknown[], R>(callback: (...args: A) => R) {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
