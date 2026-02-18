/**
 * MCP server status detection logging module
 * Provides a unified logging function
 */

import { DEBUG } from './config.js';

/**
 * Unified logging function
 * @param {'info' | 'debug' | 'error' | 'warn'} level - Log level
 * @param {...any} args - Log arguments
 */
export function log(level, ...args) {
  const prefix = '[McpStatus]';
  switch (level) {
    case 'debug':
      if (DEBUG) {
        console.log(prefix, '[DEBUG]', ...args);
      }
      break;
    case 'error':
      console.error(prefix, '[ERROR]', ...args);
      break;
    case 'warn':
      console.warn(prefix, '[WARN]', ...args);
      break;
    case 'info':
    default:
      console.log(prefix, ...args);
      break;
  }
}
