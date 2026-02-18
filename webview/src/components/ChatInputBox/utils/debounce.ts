/**
 * Debounced function interface with cancel and flush capabilities
 */
export interface DebouncedFunction<Args extends unknown[]> {
  (...args: Args): void;
  /** Cancel any pending execution */
  cancel: () => void;
  /** Immediately execute any pending callback with the last-provided arguments */
  flush: () => void;
}

/**
 * Debounce utility function
 * Delays function execution until after wait milliseconds have elapsed
 * since the last time the debounced function was invoked.
 *
 * @example
 * const debouncedFn = debounce(myFn, 300);
 * debouncedFn('arg1');
 * debouncedFn.cancel(); // Cancel pending execution (e.g., on unmount)
 * debouncedFn.flush();  // Immediately execute pending callback
 */
export function debounce<Args extends unknown[]>(
  func: (...args: Args) => void,
  wait: number
): DebouncedFunction<Args> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Args | null = null;
  let lastThis: unknown = null;

  const debouncedFn = function (this: unknown, ...args: Args) {
    lastArgs = args;
    lastThis = this;
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      const a = lastArgs;
      const ctx = lastThis;
      lastArgs = null;
      lastThis = null;
      if (a) func.apply(ctx, a);
    }, wait);
  } as DebouncedFunction<Args>;

  debouncedFn.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    lastArgs = null;
    lastThis = null;
  };

  debouncedFn.flush = () => {
    if (timeout && lastArgs) {
      clearTimeout(timeout);
      timeout = null;
      const args = lastArgs;
      const ctx = lastThis;
      lastArgs = null;
      lastThis = null;
      func.apply(ctx, args);
    }
  };

  return debouncedFn;
}
