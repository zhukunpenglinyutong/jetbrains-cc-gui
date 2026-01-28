/**
 * 命令验证模块
 * 提供命令白名单验证功能，防止任意命令执行
 */

import { ALLOWED_COMMANDS, VALID_EXTENSIONS } from './config.js';

/**
 * 验证命令是否在白名单中
 * @param {string} command - 要验证的命令
 * @returns {{ valid: boolean, reason?: string }} 验证结果
 */
export function validateCommand(command) {
  if (!command || typeof command !== 'string') {
    return { valid: false, reason: 'Command is empty or invalid' };
  }

  // 提取基础命令名（去除路径）
  const baseCommand = command.split('/').pop().split('\\').pop();

  // 检查是否在白名单中（完全匹配）
  if (ALLOWED_COMMANDS.has(baseCommand)) {
    return { valid: true };
  }

  // 检查是否是带扩展名的白名单命令（如 node.exe）
  // 提取扩展名并验证
  const lastDotIndex = baseCommand.lastIndexOf('.');
  if (lastDotIndex > 0) {
    const nameWithoutExt = baseCommand.substring(0, lastDotIndex);
    const ext = baseCommand.substring(lastDotIndex).toLowerCase();

    // 验证扩展名是否在允许列表中
    if (!VALID_EXTENSIONS.has(ext)) {
      return {
        valid: false,
        reason: `Invalid command extension "${ext}". Allowed extensions: ${[...VALID_EXTENSIONS].filter(e => e).join(', ')}`
      };
    }

    // 验证基础命令名是否在白名单中
    if (ALLOWED_COMMANDS.has(nameWithoutExt)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: `Command "${baseCommand}" is not in the allowed list. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`
  };
}
