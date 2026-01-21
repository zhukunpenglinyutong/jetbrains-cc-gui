/**
 * Debug Logger Utility
 * Conditionally logs messages based on DEBUG environment variable
 *
 * Usage:
 *   import { debugLog, diagLog, infoLog, errorLog } from './utils/debug-logger.js';
 *   debugLog('Some debug message');
 *   diagLog('CONFIG', 'Diagnostic message');
 *
 * Enable debug logging by setting environment variable:
 *   DEBUG=1 node your-script.js
 *   DEBUG=true node your-script.js
 */

/**
 * Check if debug mode is enabled
 * @returns {boolean}
 */
export function isDebugEnabled() {
  const debugEnv = process.env.DEBUG;
  return debugEnv === '1' || debugEnv === 'true' || debugEnv === 'yes';
}

/**
 * Log debug messages (only in debug mode)
 * @param {...any} args - Arguments to log
 */
export function debugLog(...args) {
  if (isDebugEnabled()) {
    console.log('[DEBUG]', ...args);
  }
}

/**
 * Log diagnostic messages with category (only in debug mode)
 * @param {string} category - Diagnostic category (e.g., 'CONFIG', 'AUTH')
 * @param {...any} args - Arguments to log
 */
export function diagLog(category, ...args) {
  if (isDebugEnabled()) {
    console.log(`[DIAG-${category}]`, ...args);
  }
}

/**
 * Log info messages (always logged, but prefixed)
 * @param {...any} args - Arguments to log
 */
export function infoLog(...args) {
  console.log('[INFO]', ...args);
}

/**
 * Log error messages (always logged)
 * @param {...any} args - Arguments to log
 */
export function errorLog(...args) {
  console.error('[ERROR]', ...args);
}
