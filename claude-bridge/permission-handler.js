#!/usr/bin/env node

/**
 * 权限处理器
 * 为 Claude SDK 提供权限请求的交互式处理
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';

// 通信目录
const PERMISSION_DIR = process.env.CLAUDE_PERMISSION_DIR
  ? process.env.CLAUDE_PERMISSION_DIR
  : join(tmpdir(), 'claude-permission');

// 确保目录存在
import { mkdirSync } from 'fs';
try {
  mkdirSync(PERMISSION_DIR, { recursive: true });
} catch (e) {
  // 忽略已存在的错误
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
  try {
    console.log(`[PERMISSION_REQUEST] Tool: ${toolName}`);

    // 对于某些明显的危险操作，直接拒绝
    const dangerousPatterns = [
      '/etc/',
      '/System/',
      '/usr/',
      '/bin/',
      '~/.ssh/',
      '~/.aws/'
    ];

    // 检查文件路径是否包含危险模式
    if (input.file_path || input.path) {
      const path = input.file_path || input.path;
      for (const pattern of dangerousPatterns) {
        if (path.includes(pattern)) {
          console.log(`[PERMISSION_DENIED] Dangerous path detected: ${path}`);
          return false;
        }
      }
    }

    // 生成请求ID
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // 创建请求文件
    const requestFile = join(PERMISSION_DIR, `request-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `response-${requestId}.json`);

    const requestData = {
      requestId,
      toolName,
      inputs: input,
      timestamp: new Date().toISOString()
    };

    console.log(`[PERMISSION] Writing request to: ${requestFile}`);
    writeFileSync(requestFile, JSON.stringify(requestData, null, 2));

    // 等待响应文件（最多30秒）
    const startTime = Date.now();
    const timeout = 30000;

    while (Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100)); // 等待100ms

      if (existsSync(responseFile)) {
        try {
          const responseData = JSON.parse(readFileSync(responseFile, 'utf-8'));
          console.log(`[PERMISSION] Got response: ${responseData.allow ? 'ALLOWED' : 'DENIED'}`);

          // 清理响应文件
          unlinkSync(responseFile);

          return responseData.allow;
        } catch (e) {
          console.error('[PERMISSION] Error reading response:', e);
          return false;
        }
      }
    }

    // 超时，默认拒绝
    console.log('[PERMISSION] Timeout waiting for response, denying by default');
    return false;

  } catch (error) {
    console.error('[PERMISSION_ERROR]', error.message);
    return false;
  }
}

/**
 * canUseTool 回调函数
 * 供 Claude SDK 使用
 * 签名：(toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>
 * SDK 期望的返回格式：{ behavior: 'allow' | 'deny', updatedInput?: object, message?: string }
 */
export async function canUseTool(toolName, input) {
  // 调试：打印接收到的参数
  console.log('[PERMISSION_DEBUG] Tool:', toolName, 'Input:', JSON.stringify(input));

  // 将 /tmp 等路径重写到项目根目录
  rewriteToolInputPaths(toolName, input);

  // 如果无法获取工具名称，拒绝
  if (!toolName) {
    console.error('[PERMISSION_ERROR] No tool name provided');
    return {
      behavior: 'deny',
      message: 'Tool name is required'
    };
  }

  // 某些工具可以自动允许（只读操作）
  const autoAllowedTools = ['Read', 'Glob', 'Grep'];
  if (autoAllowedTools.includes(toolName)) {
    console.log(`[PERMISSION] Auto-allowing ${toolName}`);
    return {
      behavior: 'allow',
      updatedInput: input
    };
  }

  // 其他工具需要请求权限
  const allowed = await requestPermissionFromJava(toolName, input);

  if (allowed) {
    console.log(`[PERMISSION] User allowed ${toolName}`);
    return {
      behavior: 'allow',
      updatedInput: input
    };
  } else {
    console.log(`[PERMISSION] User denied ${toolName}`);
    return {
      behavior: 'deny',
      message: `用户拒绝了 ${toolName} 工具的使用权限`
    };
  }
}