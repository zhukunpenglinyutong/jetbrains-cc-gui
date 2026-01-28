/* eslint-disable no-console */

// Vite exposes `import.meta.env.DEV` (boolean). In tests it may be undefined.
const DEBUG: boolean = (() => {
  try {
    return Boolean((import.meta as any)?.env?.DEV);
  } catch {
    return false;
  }
})();

export function debugLog(...args: unknown[]): void {
  if (!DEBUG) return;
  console.log(...args);
}

export function debugWarn(...args: unknown[]): void {
  if (!DEBUG) return;
  console.warn(...args);
}

export function debugError(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(...args);
}

