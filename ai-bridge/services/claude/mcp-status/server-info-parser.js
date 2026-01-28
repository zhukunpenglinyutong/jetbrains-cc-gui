/**
 * 服务器信息解析模块
 * 提供从输出中解析服务器信息的功能
 */

import { MAX_LINE_LENGTH } from './config.js';
import { log } from './logger.js';

/**
 * 从 stdout 解析服务器信息
 * @param {string} stdout - 标准输出内容
 * @returns {Object|null} 服务器信息或 null
 */
export function parseServerInfo(stdout) {
  try {
    const lines = stdout.split('\n');
    for (const line of lines) {
      // 跳过过长的行以防止 ReDoS 攻击
      if (line.length > MAX_LINE_LENGTH) {
        log('debug', 'Skipping oversized line in parseServerInfo');
        continue;
      }

      if (line.includes('"serverInfo"')) {
        // 使用更安全的 JSON 解析方式：找到 JSON 对象边界
        const startIdx = line.indexOf('{');
        if (startIdx === -1) continue;

        // 简单的括号匹配来找到完整的 JSON 对象
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < line.length; i++) {
          if (line[i] === '{') depth++;
          else if (line[i] === '}') {
            depth--;
            if (depth === 0) {
              endIdx = i + 1;
              break;
            }
          }
        }

        if (endIdx > startIdx) {
          const jsonStr = line.substring(startIdx, endIdx);
          const parsed = JSON.parse(jsonStr);
          if (parsed.result && parsed.result.serverInfo) {
            return parsed.result.serverInfo;
          }
        }
      }
    }
  } catch (e) {
    log('debug', 'Failed to parse server info:', e.message);
  }
  return null;
}
