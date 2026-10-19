import { useEffect, useRef } from 'react';

/** Own a screen's current task and invalidate callbacks when it ends. */
export function useCancellableTask(ownerKey?: string) {
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, [ownerKey]);

  return {
    start() {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      return controller;
    },
    cancel() {
      active.current?.abort();
    },
    finish(controller: AbortController) {
      if (active.current !== controller) return false;
      active.current = null;
      controller.abort();
      return mounted.current;
    },
  };
}
