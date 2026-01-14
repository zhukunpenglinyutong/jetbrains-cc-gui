/**
 * Debounced function interface with cancel capability
 */
export interface DebouncedFunction<T extends (...args: any[]) => void> {
  (...args: Parameters<T>): void;
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
export function debounce<T extends (...args: any[]) => void>(
  func: T,
  wait: number
): DebouncedFunction<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const debouncedFn = function (this: unknown, ...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      func.apply(this, args);
    }, wait);
  } as DebouncedFunction<T>;

  debouncedFn.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return debouncedFn;
}
