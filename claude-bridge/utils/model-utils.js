/**
 * 模型工具模块
 * 负责模型 ID 映射和 Claude CLI 路径检测
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';

/**
 * 将完整的模型 ID 映射为 Claude SDK 期望的简短名称
 * @param {string} modelId - 完整的模型 ID（如 'claude-sonnet-4-5'）
 * @returns {string} SDK 期望的模型名称（如 'sonnet'）
 */
export function mapModelIdToSdkName(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return 'sonnet'; // 默认使用 sonnet
  }

  const lowerModel = modelId.toLowerCase();

  // 映射规则：
  // - 包含 'opus' -> 'opus'
  // - 包含 'haiku' -> 'haiku'
  // - 其他情况（包含 'sonnet' 或未知）-> 'sonnet'
  if (lowerModel.includes('opus')) {
    return 'opus';
  } else if (lowerModel.includes('haiku')) {
    return 'haiku';
  } else {
    return 'sonnet';
  }
}

/**
 * 获取系统安装的 Claude CLI 路径
 * @returns {string|undefined} Claude CLI 路径或 undefined
 */
export function getClaudeCliPath() {
  try {
    // 先尝试 which 命令（macOS/Linux）
    const whichResult = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (whichResult && existsSync(whichResult)) {
      console.log('[DEBUG] Found Claude CLI via which:', whichResult);
      return whichResult;
    }
  } catch (e) {
    console.log('[DEBUG] which claude failed:', e.message);
  }

  try {
    // Windows: 尝试 where 命令
    const whereResult = execSync('where claude', { encoding: 'utf-8' }).trim().split('\n')[0];
    if (whereResult && existsSync(whereResult)) {
      console.log('[DEBUG] Found Claude CLI via where:', whereResult);
      return whereResult;
    }
  } catch (e) {
    console.log('[DEBUG] where claude failed:', e.message);
  }

  // 常见安装路径
  const commonPaths = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    `${process.env.HOME}/.nvm/versions/node/v24.11.1/bin/claude`,
    `${process.env.HOME}/.local/bin/claude`,
    'C:\\Program Files\\Claude\\claude.exe',
    'C:\\Users\\' + (process.env.USERNAME || '') + '\\AppData\\Local\\Programs\\Claude\\claude.exe'
  ];

  for (const p of commonPaths) {
    if (existsSync(p)) {
      console.log('[DEBUG] Found Claude CLI at common path:', p);
      return p;
    }
  }

  console.log('[DEBUG] Claude CLI not found, using SDK default');
  return undefined;
}
