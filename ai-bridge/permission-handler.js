#!/usr/bin/env node

/**
 * Permission Handler.
 * Provides interactive permission request handling for Claude SDK.
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join, basename, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { getRealHomeDir } from './utils/path-utils.js';

// ========== Debug logging helpers ==========
function debugLog(tag, message, data = null) {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | Data: ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}][PERM_DEBUG][${tag}] ${message}${dataStr}`);
}

// Communication directory
const PERMISSION_DIR = process.env.CLAUDE_PERMISSION_DIR
  ? process.env.CLAUDE_PERMISSION_DIR
  : join(tmpdir(), 'claude-permission');

// Session ID for isolating permission requests across multiple IDEA instances
const SESSION_ID = process.env.CLAUDE_SESSION_ID || 'default';

// Permission request timeout (5 minutes), kept in sync with Java-side PermissionHandler.PERMISSION_TIMEOUT_SECONDS
const PERMISSION_TIMEOUT_MS = 300000;

debugLog('INIT', `Permission dir: ${PERMISSION_DIR}`);
debugLog('INIT', `Session ID: ${SESSION_ID}`);
debugLog('INIT', `tmpdir(): ${tmpdir()}`);
debugLog('INIT', `CLAUDE_PERMISSION_DIR env: ${process.env.CLAUDE_PERMISSION_DIR || 'NOT SET'}`);
debugLog('INIT', `CLAUDE_SESSION_ID env: ${process.env.CLAUDE_SESSION_ID || 'NOT SET'}`);

// Ensure the directory exists
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
    const sanitized = resolve(projectRoot, relative);

    // Verify the resolved path is still within the project root
    const resolvedRoot = resolve(projectRoot);
    if (!sanitized.startsWith(resolvedRoot + sep) && sanitized !== resolvedRoot) {
      debugLog('PATH_REWRITE_BLOCKED', `Rewritten path escaped project root`, { from: pathValue, to: sanitized, projectRoot: resolvedRoot });
      return pathValue; // Return the original path unchanged
    }

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

    // Wait for the response file (matches PERMISSION_TIMEOUT_MS: 5 minutes)
    const timeout = PERMISSION_TIMEOUT_MS;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('ASK_USER_QUESTION_WAIT_START', `Starting to wait for answers (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      // Log waiting status every 5 seconds
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

          // Clean up the response file
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

    // Timed out, return null
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
    const timeout = PERMISSION_TIMEOUT_MS;
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
    // List files in the current directory (for debugging)
    try {
      const existingFiles = readdirSync(PERMISSION_DIR);
      debugLog('DIR_CONTENTS', `Files in permission dir (before request)`, { files: existingFiles });
    } catch (e) {
      debugLog('DIR_ERROR', `Cannot read permission dir: ${e.message}`);
    }

    // Immediately deny obviously dangerous operations
    // Retrieve the user's home directory for path checks
    const userHomeDir = getRealHomeDir();
    const isWindows = process.platform === 'win32';

    const dangerousPatterns = [
      // Unix/macOS paths
      '/etc/',
      '/System/',
      '/usr/',
      '/bin/',
      `${userHomeDir}/.ssh/`,
      `${userHomeDir}/.aws/`,
      `${userHomeDir}/.gnupg/`,
      `${userHomeDir}/.kube/`,
      `${userHomeDir}/.docker/`,
    ];

    if (isWindows) {
      // Windows system paths (case-insensitive matching applied below)
      dangerousPatterns.push(
        'C:\\Windows\\',
        'C:\\Program Files\\',
        'C:\\Program Files (x86)\\',
        `${userHomeDir}\\.ssh\\`,
        `${userHomeDir}\\.aws\\`,
        `${userHomeDir}\\.gnupg\\`,
        `${userHomeDir}\\.kube\\`,
        `${userHomeDir}\\.docker\\`,
      );
    }

    // Check whether the file path matches any dangerous pattern
    if (input.file_path || input.path) {
      const filePath = input.file_path || input.path;
      const normalizedPath = isWindows ? filePath.toLowerCase() : filePath;
      for (const pattern of dangerousPatterns) {
        const normalizedPattern = isWindows ? pattern.toLowerCase() : pattern;
        if (normalizedPath.includes(normalizedPattern)) {
          debugLog('SECURITY', `Dangerous path detected, denying`, { path: filePath, pattern });
          return false;
        }
      }
    }

    // Generate a request ID
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    debugLog('REQUEST_ID', `Generated request ID: ${requestId}`);

    // Create the request file
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

      // Verify the file was actually created
      if (existsSync(requestFile)) {
        debugLog('FILE_VERIFY', `Request file exists after write`);
      } else {
        debugLog('FILE_VERIFY_ERROR', `Request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('FILE_WRITE_ERROR', `Failed to write request file: ${writeError.message}`);
      return false;
    }

    // Wait for the response file (extended to 5 minutes to give the user enough time to review context and decide)
    const timeout = PERMISSION_TIMEOUT_MS;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('WAIT_START', `Starting to wait for response (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      // Log waiting status every 5 seconds
      if (pollCount % 50 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('WAITING', `Still waiting for response`, { elapsed: `${elapsed}ms`, pollCount });

        // Check if the request file still exists (Java should have deleted it)
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

          // Clean up the response file
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

    // Timed out -- deny by default
    const elapsed = Date.now() - requestStartTime;
    debugLog('TIMEOUT', `Timeout waiting for response`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });

    // Check file status after timeout
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

  // Special handling for the AskUserQuestion tool:
  // This tool needs to display questions to the user and collect answers, not just approve/deny
  if (toolName === 'AskUserQuestion') {
    debugLog('ASK_USER_QUESTION', 'Handling AskUserQuestion tool', { input });

    // Request answers from the user
    const answers = await requestAskUserQuestionAnswers(input);
    const elapsed = Date.now() - callStartTime;

    if (answers !== null) {
      debugLog('ASK_USER_QUESTION_SUCCESS', 'User provided answers', { answers, elapsed: `${elapsed}ms` });

      // Return answers in the format expected by the SDK:
      // behavior: 'allow'
      // updatedInput: { questions: original questions, answers: user answers }
      return {
        behavior: 'allow',
        updatedInput: {
          questions: input.questions || [],
          answers: answers
        }
      };
    } else {
      debugLog('ASK_USER_QUESTION_FAILED', 'Failed to get answers from user', { elapsed: `${elapsed}ms` });

      // If the user cancelled or timed out, deny the tool call
      return {
        behavior: 'deny',
        message: 'User did not provide answers'
      };
    }
  }

  // Rewrite paths like /tmp to the project root directory
  const rewriteResult = rewriteToolInputPaths(toolName, input);
  if (rewriteResult.changed) {
    debugLog('PATH_REWRITE', `Paths were rewritten for tool: ${toolName}`, { input });
  }

  // Deny if no tool name is provided
  if (!toolName) {
    debugLog('ERROR', 'No tool name provided, denying');
    return {
      behavior: 'deny',
      message: 'Tool name is required'
    };
  }

  // Certain tools can be auto-allowed (read-only operations)
  const autoAllowedTools = ['Read', 'Glob', 'Grep'];
  if (autoAllowedTools.includes(toolName)) {
    debugLog('AUTO_ALLOW', `Auto-allowing read-only tool: ${toolName}`);
    return {
      behavior: 'allow',
      updatedInput: input
    };
  }

  // All other tools require explicit permission
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