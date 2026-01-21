#!/usr/bin/env node

/**
 * Permission Handler.
 * Provides interactive permission request handling for Claude SDK.
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

// Session ID for isolating permission requests across multiple IDEA instances
const SESSION_ID = process.env.CLAUDE_SESSION_ID || 'default';

debugLog('INIT', `Permission dir: ${PERMISSION_DIR}`);
debugLog('INIT', `Session ID: ${SESSION_ID}`);
debugLog('INIT', `tmpdir(): ${tmpdir()}`);
debugLog('INIT', `CLAUDE_PERMISSION_DIR env: ${process.env.CLAUDE_PERMISSION_DIR || 'NOT SET'}`);
debugLog('INIT', `CLAUDE_SESSION_ID env: ${process.env.CLAUDE_SESSION_ID || 'NOT SET'}`);

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
 * Request AskUserQuestion answers via file system communication with Java process.
 * @param {Object} input - AskUserQuestion tool parameters (contains questions array)
 * @returns {Promise<Object|null>} - User answers object (format: { "question text": "answer" }), returns null on failure
 */
async function requestAskUserQuestionAnswers(input) {
  const requestStartTime = Date.now();
  debugLog('ASK_USER_QUESTION_START', 'Requesting answers for questions', { input });

  try {
    const requestId = `ask-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    debugLog('ASK_USER_QUESTION_ID', `Generated request ID: ${requestId}`);

    const requestFile = join(PERMISSION_DIR, `ask-user-question-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `ask-user-question-response-${SESSION_ID}-${requestId}.json`);

    const requestData = {
      requestId,
      toolName: 'AskUserQuestion',
      questions: input.questions || [],
      timestamp: new Date().toISOString(),
      cwd: process.cwd()  // Add working directory for project matching in multi-IDEA scenarios
    };

    debugLog('ASK_USER_QUESTION_FILE_WRITE', `Writing question request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('ASK_USER_QUESTION_FILE_WRITE_OK', `Question request file written successfully`);

      if (existsSync(requestFile)) {
        debugLog('ASK_USER_QUESTION_FILE_VERIFY', `Question request file exists after write`);
      } else {
        debugLog('ASK_USER_QUESTION_FILE_VERIFY_ERROR', `Question request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('ASK_USER_QUESTION_FILE_WRITE_ERROR', `Failed to write question request file: ${writeError.message}`);
      return null;
    }

    // 等待响应文件（最多60秒）
    const timeout = 60000;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('ASK_USER_QUESTION_WAIT_START', `Starting to wait for answers (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      // 每5秒输出一次等待状态
      if (pollCount % 50 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('ASK_USER_QUESTION_WAITING', `Still waiting for answers`, { elapsed: `${elapsed}ms`, pollCount });
      }

      if (existsSync(responseFile)) {
        debugLog('ASK_USER_QUESTION_RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('ASK_USER_QUESTION_RESPONSE_CONTENT', `Raw response content: ${responseContent}`);

          const responseData = JSON.parse(responseContent);
          const answers = responseData.answers;
          debugLog('ASK_USER_QUESTION_RESPONSE_PARSED', `Parsed answers`, { answers, elapsed: `${Date.now() - requestStartTime}ms` });

          // 清理响应文件
          try {
            unlinkSync(responseFile);
            debugLog('ASK_USER_QUESTION_FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('ASK_USER_QUESTION_FILE_CLEANUP_ERROR', `Failed to delete response file: ${cleanupError.message}`);
          }

          return answers;
        } catch (e) {
          debugLog('ASK_USER_QUESTION_RESPONSE_ERROR', `Error reading/parsing response: ${e.message}`);
          return null;
        }
      }
    }

    // 超时，返回 null
    const elapsed = Date.now() - requestStartTime;
    debugLog('ASK_USER_QUESTION_TIMEOUT', `Timeout waiting for answers`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });

    return null;

  } catch (error) {
    debugLog('ASK_USER_QUESTION_FATAL_ERROR', `Unexpected error: ${error.message}`, { stack: error.stack });
    return null;
  }
}

/**
 * Request plan approval via file system communication with Java process.
 * @param {Object} input - ExitPlanMode tool parameters (contains allowedPrompts)
 * @returns {Promise<Object>} - { approved: boolean, targetMode: string, message?: string }
 */
export async function requestPlanApproval(input) {
  const requestStartTime = Date.now();
  debugLog('PLAN_APPROVAL_START', 'Requesting plan approval', { input });

  try {
    const requestId = `plan-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    debugLog('PLAN_APPROVAL_ID', `Generated request ID: ${requestId}`);

    const requestFile = join(PERMISSION_DIR, `plan-approval-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `plan-approval-response-${SESSION_ID}-${requestId}.json`);

    const requestData = {
      requestId,
      toolName: 'ExitPlanMode',
      allowedPrompts: input?.allowedPrompts || [],
      timestamp: new Date().toISOString(),
      cwd: process.cwd()  // Add working directory for project matching in multi-IDEA scenarios
    };

    debugLog('PLAN_APPROVAL_FILE_WRITE', `Writing plan approval request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('PLAN_APPROVAL_FILE_WRITE_OK', `Plan approval request file written successfully`);

      if (existsSync(requestFile)) {
        debugLog('PLAN_APPROVAL_FILE_VERIFY', `Plan approval request file exists after write`);
      } else {
        debugLog('PLAN_APPROVAL_FILE_VERIFY_ERROR', `Plan approval request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('PLAN_APPROVAL_FILE_WRITE_ERROR', `Failed to write plan approval request file: ${writeError.message}`);
      return { approved: false, message: 'Failed to write plan approval request' };
    }

    // Wait for response file (up to 300 seconds for complex plan review)
    const timeout = 300000;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('PLAN_APPROVAL_WAIT_START', `Starting to wait for plan approval response (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      // Log status every 10 seconds
      if (pollCount % 100 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('PLAN_APPROVAL_WAITING', `Still waiting for plan approval`, { elapsed: `${elapsed}ms`, pollCount });
      }

      if (existsSync(responseFile)) {
        debugLog('PLAN_APPROVAL_RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('PLAN_APPROVAL_RESPONSE_CONTENT', `Raw response content: ${responseContent}`);

          const responseData = JSON.parse(responseContent);
          const approved = responseData.approved === true;
          const targetMode = responseData.targetMode || 'default';
          const message = responseData.message;

          debugLog('PLAN_APPROVAL_RESPONSE_PARSED', `Parsed response`, {
            approved,
            targetMode,
            elapsed: `${Date.now() - requestStartTime}ms`
          });

          // Clean up response file
          try {
            unlinkSync(responseFile);
            debugLog('PLAN_APPROVAL_FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('PLAN_APPROVAL_FILE_CLEANUP_ERROR', `Failed to delete response file: ${cleanupError.message}`);
          }

          return { approved, targetMode, message };
        } catch (e) {
          debugLog('PLAN_APPROVAL_RESPONSE_ERROR', `Error reading/parsing response: ${e.message}`);
          return { approved: false, message: 'Failed to parse plan approval response' };
        }
      }
    }

    // Timeout, return not approved
    const elapsed = Date.now() - requestStartTime;
    debugLog('PLAN_APPROVAL_TIMEOUT', `Timeout waiting for plan approval`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });

    return { approved: false, message: 'Plan approval timed out' };

  } catch (error) {
    debugLog('PLAN_APPROVAL_FATAL_ERROR', `Unexpected error: ${error.message}`, { stack: error.stack });
    return { approved: false, message: error.message };
  }
}

/**
 * Request permission via file system communication with Java process.
 * @param {string} toolName - Tool name
 * @param {Object} input - Tool parameters
 * @returns {Promise<boolean>} - Whether allowed
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
    const requestFile = join(PERMISSION_DIR, `request-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `response-${SESSION_ID}-${requestId}.json`);

    const requestData = {
      requestId,
      toolName,
      inputs: input,
      timestamp: new Date().toISOString(),
      cwd: process.cwd()  // Add working directory for project matching in multi-IDEA scenarios
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
 * canUseTool callback function.
 * Used by Claude SDK.
 * Signature: (toolName: string, input: ToolInput, options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }) => Promise<PermissionResult>
 * SDK expected return format: { behavior: 'allow' | 'deny', updatedInput?: object, message?: string }
 */
export async function canUseTool(toolName, input, options = {}) {
  const callStartTime = Date.now();
  console.log('[PERM_DEBUG][CAN_USE_TOOL] ========== CALLED ==========');
  console.log('[PERM_DEBUG][CAN_USE_TOOL] toolName:', toolName);
  console.log('[PERM_DEBUG][CAN_USE_TOOL] input:', JSON.stringify(input));
  console.log('[PERM_DEBUG][CAN_USE_TOOL] options:', options ? 'present' : 'undefined');
  debugLog('CAN_USE_TOOL', `Called with tool: ${toolName}`, { input });

  // 特殊处理：AskUserQuestion 工具
  // 这个工具需要向用户显示问题并收集答案，而不是简单的批准/拒绝
  if (toolName === 'AskUserQuestion') {
    debugLog('ASK_USER_QUESTION', 'Handling AskUserQuestion tool', { input });

    // 请求用户回答问题
    const answers = await requestAskUserQuestionAnswers(input);
    const elapsed = Date.now() - callStartTime;

    if (answers !== null) {
      debugLog('ASK_USER_QUESTION_SUCCESS', 'User provided answers', { answers, elapsed: `${elapsed}ms` });

      // 按照 SDK 要求返回答案：
      // behavior: 'allow'
      // updatedInput: { questions: 原始问题, answers: 用户答案 }
      return {
        behavior: 'allow',
        updatedInput: {
          questions: input.questions || [],
          answers: answers
        }
      };
    } else {
      debugLog('ASK_USER_QUESTION_FAILED', 'Failed to get answers from user', { elapsed: `${elapsed}ms` });

      // 如果用户取消或超时，拒绝工具调用
      return {
        behavior: 'deny',
        message: 'User did not provide answers'
      };
    }
  }

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
      message: `User denied permission for ${toolName} tool`
    };
  }
}