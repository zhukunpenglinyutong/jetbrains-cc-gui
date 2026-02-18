/**
 * Server info parser module
 * Provides functionality to parse server information from process output
 */

import { MAX_LINE_LENGTH } from './config.js';
import { log } from './logger.js';

/**
 * Parse server information from stdout
 * @param {string} stdout - Standard output content
 * @returns {Object|null} Server info object, or null if not found
 */
export function parseServerInfo(stdout) {
  try {
    const lines = stdout.split('\n');
    for (const line of lines) {
      // Skip oversized lines to prevent ReDoS attacks
      if (line.length > MAX_LINE_LENGTH) {
        log('debug', 'Skipping oversized line in parseServerInfo');
        continue;
      }

      if (line.includes('"serverInfo"')) {
        // Use a safer JSON parsing approach: locate the JSON object boundaries
        const startIdx = line.indexOf('{');
        if (startIdx === -1) continue;

        // Simple brace matching to find the complete JSON object
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
