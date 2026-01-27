/**
 * Debounced function interface with cancel capability
 */
export interface DebouncedFunction<Args extends unknown[]> {
  (...args: Args): void;
  /** Cancel any pending execution */
  cancel: () => void;
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
 */
export function debounce<Args extends unknown[]>(
  func: (...args: Args) => void,
  wait: number
): DebouncedFunction<Args> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const debouncedFn = function (this: unknown, ...args: Args) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      func.apply(this, args);
    }, wait);
  } as DebouncedFunction<Args>;

  debouncedFn.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return debouncedFn;
}
