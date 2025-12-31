#!/usr/bin/env node

/**
 * 权限处理器
 * 为 Claude SDK 提供权限请求的交互式处理
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';

// ========== 调试日志辅助函数 ==========
function debugLog(tag, message, data = null) {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | Data: ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}][PERM_DEBUG][${tag}] ${message}${dataStr}`);
}

// 通信目录
const PERMISSION_DIR = process.env.CLAUDE_PERMISSION_DIR
  ? process.env.CLAUDE_PERMISSION_DIR
  : join(tmpdir(), 'claude-permission');

debugLog('INIT', `Permission dir: ${PERMISSION_DIR}`);
debugLog('INIT', `tmpdir(): ${tmpdir()}`);
debugLog('INIT', `CLAUDE_PERMISSION_DIR env: ${process.env.CLAUDE_PERMISSION_DIR || 'NOT SET'}`);

// 确保目录存在
import { mkdirSync } from 'fs';
try {
  mkdirSync(PERMISSION_DIR, { recursive: true });
  debugLog('INIT', 'Permission directory created/verified successfully');
} catch (e) {
  debugLog('INIT_ERROR', `Failed to create permission dir: ${e.message}`);
}

const TEMP_PATH_PREFIXES = ['/tmp', '/var/tmp', '/private/tmp'];

function getProjectRoot() {
  return process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH || process.cwd();
}

function rewriteToolInputPaths(toolName, input) {
  const projectRoot = getProjectRoot();
  if (!projectRoot || !input || typeof input !== 'object') {
    return { changed: false };
  }

  const prefixes = [...TEMP_PATH_PREFIXES];
  if (process.env.TMPDIR) {
    prefixes.push(process.env.TMPDIR);
  }

  const rewrites = [];

  const rewritePath = (pathValue) => {
    if (typeof pathValue !== 'string') return pathValue;
    const matchedPrefix = prefixes.find(prefix => prefix && pathValue.startsWith(prefix));
    if (!matchedPrefix) return pathValue;

    let relative = pathValue.slice(matchedPrefix.length).replace(/^\/+/, '');
    if (!relative) {
      relative = basename(pathValue);
    }
    const sanitized = join(projectRoot, relative);
    rewrites.push({ from: pathValue, to: sanitized });
    return sanitized;
  };

  const traverse = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(traverse);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.file_path === 'string') {
        value.file_path = rewritePath(value.file_path);
      }
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (child && typeof child === 'object') {
          traverse(child);
        }
      }
    }
  };

  traverse(input);

  if (rewrites.length > 0) {
    console.log(`[PERMISSION] Rewrote paths for ${toolName}:`, JSON.stringify(rewrites));
  }

  return { changed: rewrites.length > 0 };
}

/**
 * 通过文件系统与 Java 进程通信请求权限
 * @param {string} toolName - 工具名称
 * @param {Object} input - 工具参数
 * @returns {Promise<boolean>} - 是否允许
 */
export async function requestPermissionFromJava(toolName, input) {
  const requestStartTime = Date.now();
  debugLog('REQUEST_START', `Tool: ${toolName}`, { input });

  try {
    // 列出当前目录中的文件（调试用）
    try {
      const existingFiles = readdirSync(PERMISSION_DIR);
      debugLog('DIR_CONTENTS', `Files in permission dir (before request)`, { files: existingFiles });
    } catch (e) {
      debugLog('DIR_ERROR', `Cannot read permission dir: ${e.message}`);
    }

    // 对于某些明显的危险操作，直接拒绝
    // 获取用户主目录用于路径检查
    const userHomeDir = process.env.HOME || process.env.USERPROFILE || require('os').homedir();
    const dangerousPatterns = [
      '/etc/',
      '/System/',
      '/usr/',
      '/bin/',
      `${userHomeDir}/.ssh/`,
      `${userHomeDir}/.aws/`
    ];

    // 检查文件路径是否包含危险模式
    if (input.file_path || input.path) {
      const path = input.file_path || input.path;
      for (const pattern of dangerousPatterns) {
        if (path.includes(pattern)) {
          debugLog('SECURITY', `Dangerous path detected, denying`, { path, pattern });
          return false;
        }
      }
    }

    // 生成请求ID
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    debugLog('REQUEST_ID', `Generated request ID: ${requestId}`);

    // 创建请求文件
    const requestFile = join(PERMISSION_DIR, `request-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `response-${requestId}.json`);

    const requestData = {
      requestId,
      toolName,
      inputs: input,
      timestamp: new Date().toISOString()
    };

    debugLog('FILE_WRITE', `Writing request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('FILE_WRITE_OK', `Request file written successfully`);

      // 验证文件是否确实创建
      if (existsSync(requestFile)) {
        debugLog('FILE_VERIFY', `Request file exists after write`);
      } else {
        debugLog('FILE_VERIFY_ERROR', `Request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('FILE_WRITE_ERROR', `Failed to write request file: ${writeError.message}`);
      return false;
    }

    // 等待响应文件（最多60秒）——需要略长于 IDE 前端的超时时间，避免 Node 先于前端超时
    const timeout = 60000;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('WAIT_START', `Starting to wait for response (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      // 每5秒输出一次等待状态
      if (pollCount % 50 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('WAITING', `Still waiting for response`, { elapsed: `${elapsed}ms`, pollCount });

        // 检查请求文件是否还存在（Java 应该会删除它）
        const reqFileExists = existsSync(requestFile);
        const respFileExists = existsSync(responseFile);
        debugLog('FILE_STATUS', `File status check`, {
          requestFileExists: reqFileExists,
          responseFileExists: respFileExists
        });
      }

      if (existsSync(responseFile)) {
        debugLog('RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('RESPONSE_CONTENT', `Raw response content: ${responseContent}`);

          const responseData = JSON.parse(responseContent);
          const result = responseData.allow;
          debugLog('RESPONSE_PARSED', `Parsed response`, { allow: result, elapsed: `${Date.now() - requestStartTime}ms` });

          // 清理响应文件
          try {
            unlinkSync(responseFile);
            debugLog('FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('FILE_CLEANUP_ERROR', `Failed to delete response file: ${cleanupError.message}`);
          }

          return result;
        } catch (e) {
          debugLog('RESPONSE_ERROR', `Error reading/parsing response: ${e.message}`);
          return false;
        }
      }
    }

    // 超时，默认拒绝
    const elapsed = Date.now() - requestStartTime;
    debugLog('TIMEOUT', `Timeout waiting for response`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });

    // 超时后检查文件状态
    const reqFileExists = existsSync(requestFile);
    const respFileExists = existsSync(responseFile);
    debugLog('TIMEOUT_FILE_STATUS', `File status at timeout`, {
      requestFileExists: reqFileExists,
      responseFileExists: respFileExists
    });

    return false;

  } catch (error) {
    debugLog('FATAL_ERROR', `Unexpected error in requestPermissionFromJava: ${error.message}`, { stack: error.stack });
    return false;
  }
}

/**
 * canUseTool 回调函数
 * 供 Claude SDK 使用
 * 签名：(toolName: string, input: ToolInput, options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }) => Promise<PermissionResult>
 * SDK 期望的返回格式：{ behavior: 'allow' | 'deny', updatedInput?: object, message?: string }
 */
export async function canUseTool(toolName, input, options = {}) {
  const callStartTime = Date.now();
  console.log('[PERM_DEBUG][CAN_USE_TOOL] ========== CALLED ==========');
  console.log('[PERM_DEBUG][CAN_USE_TOOL] toolName:', toolName);
  console.log('[PERM_DEBUG][CAN_USE_TOOL] input:', JSON.stringify(input));
  console.log('[PERM_DEBUG][CAN_USE_TOOL] options:', options ? 'present' : 'undefined');
  debugLog('CAN_USE_TOOL', `Called with tool: ${toolName}`, { input });

  // 将 /tmp 等路径重写到项目根目录
  const rewriteResult = rewriteToolInputPaths(toolName, input);
  if (rewriteResult.changed) {
    debugLog('PATH_REWRITE', `Paths were rewritten for tool: ${toolName}`, { input });
  }

  // 如果无法获取工具名称，拒绝
  if (!toolName) {
    debugLog('ERROR', 'No tool name provided, denying');
    return {
      behavior: 'deny',
      message: 'Tool name is required'
    };
  }

  // 某些工具可以自动允许（只读操作）
  const autoAllowedTools = ['Read', 'Glob', 'Grep'];
  if (autoAllowedTools.includes(toolName)) {
    debugLog('AUTO_ALLOW', `Auto-allowing read-only tool: ${toolName}`);
    return {
      behavior: 'allow',
      updatedInput: input
    };
  }

  // 其他工具需要请求权限
  debugLog('PERMISSION_NEEDED', `Tool ${toolName} requires permission, calling requestPermissionFromJava`);
  const allowed = await requestPermissionFromJava(toolName, input);
  const elapsed = Date.now() - callStartTime;

  if (allowed) {
    debugLog('PERMISSION_GRANTED', `User allowed ${toolName}`, { elapsed: `${elapsed}ms` });
    return {
      behavior: 'allow',
      updatedInput: input
    };
  } else {
    debugLog('PERMISSION_DENIED', `User denied ${toolName}`, { elapsed: `${elapsed}ms` });
    return {
      behavior: 'deny',
      message: `用户拒绝了 ${toolName} 工具的使用权限`
    };
  }
}