/**
 * Debug Logger Utility for Frontend
 * Conditionally logs messages based on localStorage or URL parameter
 *
 * Usage:
 *   import { debugLog } from './utils/debugLogger';
 *   debugLog('[Frontend][Theme]', 'Some debug message');
 *
 * Enable debug logging by:
 *   1. Setting localStorage: localStorage.setItem('debug', '1')
 *   2. Adding URL parameter: ?debug=1
 *   3. In development mode (import.meta.env.DEV)
 */

/**
 * Check if debug mode is enabled
 * Caches the result to avoid repeated localStorage/URL checks
 */
let debugEnabled: boolean | null = null;

export function isDebugEnabled(): boolean {
  if (debugEnabled !== null) {
    return debugEnabled;
  }

  // Check localStorage
  try {
    const localStorageDebug = localStorage.getItem('debug');
    if (localStorageDebug === '1' || localStorageDebug === 'true') {
      debugEnabled = true;
      return true;
    }
  } catch {
    // localStorage not available
  }

  // Check URL parameter
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === '1' || urlParams.get('debug') === 'true') {
      debugEnabled = true;
      return true;
    }
  } catch {
    // URL parsing failed
  }

  // Check development mode (Vite)
  if (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV) {
    debugEnabled = true;
    return true;
  }

  debugEnabled = false;
  return false;
}

/**
 * Reset debug enabled cache (useful for testing or dynamic enable/disable)
 */
export function resetDebugCache(): void {
  debugEnabled = null;
}

/**
 * Enable debug logging programmatically
 */
export function enableDebug(): void {
  try {
    localStorage.setItem('debug', '1');
  } catch {
    // localStorage not available
  }
  debugEnabled = true;
}

/**
 * Disable debug logging programmatically
 */
export function disableDebug(): void {
  try {
    localStorage.removeItem('debug');
  } catch {
    // localStorage not available
  }
  debugEnabled = false;
}

/**
 * Log debug messages (only in debug mode)
 * @param args - Arguments to log (first arg is typically a tag like '[Frontend][Theme]')
 */
export function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}

/**
 * Log warning messages (only in debug mode)
 * @param args - Arguments to log
 */
export function debugWarn(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.warn(...args);
  }
}

/**
 * Log error messages (always logged, but can be conditional)
 * @param args - Arguments to log
 */
export function debugError(...args: unknown[]): void {
  // Errors are always logged regardless of debug mode
  console.error(...args);
}
