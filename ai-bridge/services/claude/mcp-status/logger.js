/**
 * MCP 服务器状态检测日志模块
 * 提供统一的日志输出函数
 */

import { DEBUG } from './config.js';

/**
 * 统一的日志输出函数
 * @param {'info' | 'debug' | 'error' | 'warn'} level - 日志级别
 * @param {...any} args - 日志参数
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
