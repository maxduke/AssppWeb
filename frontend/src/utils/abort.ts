/** Stop callers even when an underlying browser operation cannot be cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw (
      signal.reason ?? new DOMException('Operation cancelled', 'AbortError')
    );
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

export function abortable<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return run();
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason ?? new DOMException('Operation cancelled', 'AbortError'),
      );
    try {
      throwIfAborted(signal);
      signal.addEventListener('abort', onAbort, { once: true });
      // Always observe late completion/rejection, but never publish its result
      // to a caller that has already cancelled.
      run().then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) onAbort();
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) onAbort();
          else reject(error);
        },
      );
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}

export function createDeadline(
  timeoutMs: number,
  parent?: AbortSignal,
  message = 'Operation timed out',
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(message, 'TimeoutError')),
    timeoutMs,
  );
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      () =>
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
