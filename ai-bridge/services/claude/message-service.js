/**
 * Message sending service module.
 * Responsible for sending messages through Claude Agent SDK.
 */

// Dynamic SDK loading - loaded on demand instead of static imports
import {
    loadClaudeSdk,
    loadAnthropicSdk,
    loadBedrockSdk,
    isClaudeSdkAvailable
} from '../../utils/sdk-loader.js';
import { randomUUID } from 'crypto';

// SDK cache
let claudeSdk = null;
let anthropicSdk = null;
let bedrockSdk = null;

/**
 * Ensure Claude SDK is loaded
 */
async function ensureClaudeSdk() {
    if (!claudeSdk) {
        if (!isClaudeSdkAvailable()) {
            const error = new Error('Claude Code SDK not installed. Please install via Settings > Dependencies.');
            error.code = 'SDK_NOT_INSTALLED';
            error.provider = 'claude';
            throw error;
        }
        claudeSdk = await loadClaudeSdk();
    }
    return claudeSdk;
}

/**
 * Ensure Anthropic SDK is loaded
 */
async function ensureAnthropicSdk() {
    if (!anthropicSdk) {
        anthropicSdk = await loadAnthropicSdk();
    }
    return anthropicSdk;
}

/**
 * Ensure Bedrock SDK is loaded
 */
async function ensureBedrockSdk() {
    if (!bedrockSdk) {
        bedrockSdk = await loadBedrockSdk();
    }
    return bedrockSdk;
}
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';

import { getMcpServersStatus, loadMcpServersConfig, getMcpServerTools as getMcpServerToolsImpl } from './mcp-status/index.js';

import { setupApiKey, isCustomBaseUrl, loadClaudeSettings } from '../../config/api-config.js';
import { selectWorkingDirectory, getRealHomeDir, getClaudeDir } from '../../utils/path-utils.js';
import { mapModelIdToSdkName, setModelEnvironmentVariables } from '../../utils/model-utils.js';
import { AsyncStream } from '../../utils/async-stream.js';
import { canUseTool, requestPlanApproval } from '../../permission-handler.js';
import { persistJsonlMessage, loadSessionHistory } from './session-service.js';
import { loadAttachments, buildContentBlocks } from './attachment-service.js';
import { buildIDEContextPrompt } from '../system-prompts.js';
import { buildQuickFixPrompt } from '../quickfix-prompts.js';

// Store active query results for rewind operations
// Key: sessionId, Value: query result object
const activeQueryResults = new Map();

const ACCEPT_EDITS_AUTO_APPROVE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'CreateDirectory',
  'MoveFile',
  'CopyFile',
  'Rename'
]);

// Tools allowed in plan mode (read-only tools + planning tools + ExitPlanMode)
const PLAN_MODE_ALLOWED_TOOLS = new Set([
  // Read-only tools
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  // Planning tools
  'TodoWrite', 'Skill', 'TaskOutput',
  'Task', // Allow Task for exploration agents
  'Write', // Allow Write for writing plan files
  'Edit', // Allow Edit in plan mode (still gated by permission prompt)
  'Bash', // Allow Bash in plan mode (still gated by permission prompt)
  'AskUserQuestion', // Allow AskUserQuestion for asking user during planning
  'EnterPlanMode', // Allow EnterPlanMode
  'ExitPlanMode', // Allow ExitPlanMode to exit plan mode
  // MCP tools
  'mcp__ace-tool__search_context',
  'mcp__context7__resolve-library-id',
  'mcp__context7__query-docs',
  'mcp__conductor__GetWorkspaceDiff',
  'mcp__conductor__GetTerminalOutput',
  'mcp__conductor__AskUserQuestion',
  'mcp__conductor__DiffComment',
  'mcp__time__get_current_time',
  'mcp__time__convert_time'
]);

// ========== Auto-retry configuration for transient API errors ==========
// NOTE: Retry logic is duplicated in sendMessage and sendMessageWithAttachments.
// TODO: Consider extracting a generic withRetry(asyncFn, config) utility function
//       to reduce duplication. Deferred due to complex state management within retry loops.
const AUTO_RETRY_CONFIG = {
  maxRetries: 2,           // Maximum retry attempts
  retryDelayMs: 1500,      // Delay between retries (ms)
  maxMessagesForRetry: 3   // Only retry if fewer messages were processed (early failure)
};

/**
 * Determine if an error is retryable (transient network/API issues)
 * @param {Error|string} error - The error to check
 * @returns {boolean} - True if the error is likely transient and retryable
 */
function isRetryableError(error) {
  const msg = error?.message || String(error);
  const retryablePatterns = [
    'API request failed',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'network',
    'fetch failed',
    'socket hang up',
    'getaddrinfo',
    'connect EHOSTUNREACH',
    'No conversation found with session ID',
    'conversation not found'
  ];
  return retryablePatterns.some(pattern => msg.toLowerCase().includes(pattern.toLowerCase()));
}

function isNoConversationFoundError(error) {
  const msg = error?.message || String(error);
  return msg.includes('No conversation found with session ID');
}

/**
 * Sleep utility for retry delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelayMs(error) {
  if (isNoConversationFoundError(error)) return 250;
  return AUTO_RETRY_CONFIG.retryDelayMs;
}

function getClaudeProjectSessionFilePath(sessionId, cwd) {
  const projectsDir = join(getClaudeDir(), 'projects');
  const sanitizedCwd = String(cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
  return join(projectsDir, sanitizedCwd, `${sessionId}.jsonl`);
}

function hasClaudeProjectSessionFile(sessionId, cwd) {
  try {
    if (!sessionId || typeof sessionId !== 'string') return false;
    if (sessionId.includes('/') || sessionId.includes('\\')) return false;
    const sessionFile = getClaudeProjectSessionFilePath(sessionId, cwd);
    return existsSync(sessionFile);
  } catch {
    return false;
  }
}

async function waitForClaudeProjectSessionFile(sessionId, cwd, timeoutMs = 1500, intervalMs = 100) {
  if (hasClaudeProjectSessionFile(sessionId, cwd)) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(intervalMs);
    if (hasClaudeProjectSessionFile(sessionId, cwd)) return true;
  }
  return false;
}

// Tools that require user interaction even in bypassPermissions mode
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);

function shouldAutoApproveTool(permissionMode, toolName) {
  if (!toolName) return false;
  // Interactive tools always need user input, never auto-approve
  if (INTERACTIVE_TOOLS.has(toolName)) return false;
  if (permissionMode === 'bypassPermissions') return true;
  if (permissionMode === 'acceptEdits') return ACCEPT_EDITS_AUTO_APPROVE_TOOLS.has(toolName);
  return false;
}

function createPreToolUseHook(permissionMode) {
  let currentPermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;

  return async (input) => {
    const toolName = input?.tool_name;
    console.log('[PERM_DEBUG] PreToolUse hook called:', toolName, 'mode:', currentPermissionMode);

    // Handle plan mode: allow read-only tools, special handling for ExitPlanMode
    if (currentPermissionMode === 'plan') {
      if (toolName === 'AskUserQuestion') {
        console.log('[PERM_DEBUG] AskUserQuestion called in plan mode, deferring to canUseTool for answers...');
        return { decision: 'approve' };
      }

      // Edit / Bash: allow in plan mode but still ask user permission (same as default mode behavior)
      if (toolName === 'Edit' || toolName === 'Bash') {
        console.log(`[PERM_DEBUG] ${toolName} called in plan mode, requesting permission...`);
        try {
          const result = await canUseTool(toolName, input?.tool_input);
          if (result?.behavior === 'allow') {
            return { decision: 'approve', updatedInput: result.updatedInput ?? input?.tool_input };
          }
          return {
            decision: 'block',
            reason: result?.message || 'Permission denied'
          };
        } catch (error) {
          console.error(`[PERM_DEBUG] ${toolName} permission error:`, error?.message);
          return {
            decision: 'block',
            reason: 'Permission check failed: ' + (error?.message || String(error))
          };
        }
      }

      // Special handling for ExitPlanMode: request plan approval from user
      if (toolName === 'ExitPlanMode') {
        console.log('[PERM_DEBUG] ExitPlanMode called in plan mode, requesting approval...');
        try {
          const result = await requestPlanApproval(input?.tool_input);
          if (result?.approved) {
            const nextMode = result.targetMode || 'default';
            currentPermissionMode = nextMode;
            console.log('[PERM_DEBUG] Plan approved, switching mode to:', nextMode);
            return {
              decision: 'approve',
              updatedInput: {
                ...input.tool_input,
                approved: true,
                targetMode: nextMode
              }
            };
          }
          console.log('[PERM_DEBUG] Plan rejected by user');
          return {
            decision: 'block',
            reason: result?.message || 'Plan was rejected by user'
          };
        } catch (error) {
          console.error('[PERM_DEBUG] Plan approval error:', error?.message);
          return {
            decision: 'block',
            reason: 'Plan approval failed: ' + (error?.message || String(error))
          };
        }
      }

      // Allow read-only tools in plan mode
      if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
        console.log('[PERM_DEBUG] Allowing read-only tool in plan mode:', toolName);
        return { decision: 'approve' };
      }

      // Also allow MCP tools that start with 'mcp__' and are read-only
      if (toolName?.startsWith('mcp__') && !toolName.includes('Write') && !toolName.includes('Edit')) {
        console.log('[PERM_DEBUG] Allowing MCP read tool in plan mode:', toolName);
        return { decision: 'approve' };
      }

      // Block all other tools in plan mode
      console.log('[PERM_DEBUG] Blocking tool in plan mode:', toolName);
      return {
        decision: 'block',
        reason: `Tool "${toolName}" is not allowed in plan mode. Only read-only tools are permitted. Use ExitPlanMode to exit plan mode.`
      };
    }

    if (toolName === 'AskUserQuestion') {
      console.log('[PERM_DEBUG] AskUserQuestion encountered in PreToolUse, deferring to canUseTool for answers...');
      return { decision: 'approve' };
    }

    if (shouldAutoApproveTool(currentPermissionMode, toolName)) {
      console.log('[PERM_DEBUG] Auto-approve tool:', toolName, 'mode:', currentPermissionMode);
      return { decision: 'approve' };
    }

    console.log('[PERM_DEBUG] Calling canUseTool...');
    try {
      const result = await canUseTool(toolName, input?.tool_input);
      console.log('[PERM_DEBUG] canUseTool returned:', result?.behavior);

      if (result?.behavior === 'allow') {
        if (result?.updatedInput !== undefined) {
          return { decision: 'approve', updatedInput: result.updatedInput };
        }
        return { decision: 'approve' };
      }
      if (result?.behavior === 'deny') {
        return {
          decision: 'block',
          reason: result?.message || 'Permission denied'
        };
      }
      return {};
    } catch (error) {
      console.error('[PERM_DEBUG] canUseTool error:', error?.message);
      return {
        decision: 'block',
        reason: 'Permission check failed: ' + (error?.message || String(error))
      };
    }
  };
}

/**
 * Truncate a string to a maximum length, appending a suffix if truncated.
 * @param {string} str - The string to truncate
 * @param {number} maxLen - Maximum allowed length (default 1000)
 * @returns {string} The original or truncated string
 */
function truncateString(str, maxLen = 1000) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `... [truncated, total ${str.length} chars]`;
}

/**
 * Error prefixes that indicate the content is an error message from SDK or API.
 * When content starts with one of these prefixes and exceeds maxLen, it will be truncated.
 */
const ERROR_CONTENT_PREFIXES = [
  'API Error',
  'API error',
  'Error:',
  'Error ',
];

/**
 * Truncate content only if it looks like an error message (starts with known error prefixes).
 * Normal assistant responses are never truncated.
 * @param {string} content - The content to check and possibly truncate
 * @param {number} maxLen - Maximum allowed length (default 1000)
 * @returns {string} The original or truncated content
 */
function truncateErrorContent(content, maxLen = 1000) {
  if (!content || content.length <= maxLen) return content;
  const isError = ERROR_CONTENT_PREFIXES.some(prefix => content.startsWith(prefix));
  if (!isError) return content;
  return content.substring(0, maxLen) + `... [truncated, total ${content.length} chars]`;
}

/**
 * Emit [USAGE] tag for Java-side token tracking.
 * NOTE: The console.log below is intentional IPC — the Java backend parses
 * stdout lines starting with "[USAGE]" to extract token metrics.
 * This follows the same pattern used by other IPC tags (e.g. [TOOL_RESULT]).
 */
function emitUsageTag(msg) {
  if (msg.type === 'assistant' && msg.message?.usage) {
    const { input_tokens = 0, output_tokens = 0,
            cache_creation_input_tokens = 0, cache_read_input_tokens = 0 } = msg.message.usage;
    // Intentional stdout IPC — parsed by Java backend (see ClaudeMessageHandler.parseUsageTag)
    console.log('[USAGE]', JSON.stringify({
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
    }));
  }
}

const MAX_TOOL_RESULT_CONTENT_CHARS = 20000;

/**
 * Truncate tool_result block content for IPC transport.
 * Preserves all fields but limits the content string to avoid large payloads through stdout.
 * @param {object} block - The tool_result block
 * @returns {object} A block with truncated content (or the original if small enough)
 */
function truncateToolResultBlock(block) {
  if (!block || !block.content) return block;
  const content = block.content;
  if (typeof content === 'string' && content.length > MAX_TOOL_RESULT_CONTENT_CHARS) {
    const head = Math.floor(MAX_TOOL_RESULT_CONTENT_CHARS * 0.65);
    const tail = MAX_TOOL_RESULT_CONTENT_CHARS - head;
    return {
      ...block,
      content: content.substring(0, head) +
        `\n...\n(truncated, original length: ${content.length} chars)\n...\n` +
        content.substring(content.length - tail)
    };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const truncated = content.map(item => {
      if (item && item.type === 'text' && typeof item.text === 'string' && item.text.length > MAX_TOOL_RESULT_CONTENT_CHARS) {
        changed = true;
        const head = Math.floor(MAX_TOOL_RESULT_CONTENT_CHARS * 0.65);
        const tail = MAX_TOOL_RESULT_CONTENT_CHARS - head;
        return {
          ...item,
          text: item.text.substring(0, head) +
            `\n...\n(truncated, original length: ${item.text.length} chars)\n...\n` +
            item.text.substring(item.text.length - tail)
        };
      }
      return item;
    });
    return changed ? { ...block, content: truncated } : block;
  }
  return block;
}

/**
 * Build error payload for configuration errors
 * @param {Error} error - The error object to build payload from
 * @returns {Object} Error payload with error message and details
 */
	function buildConfigErrorPayload(error) {
			  try {
			    const rawError = error?.message || String(error);
			    const errorName = error?.name || 'Error';
			    const errorStack = error?.stack || null;

			    // Previously this handled AbortError / "Claude Code process aborted by user" with a timeout-specific message.
			    // Now we use unified error handling, but still record whether it's a timeout/abort error in details for debugging.
			    const isAbortError =
			      errorName === 'AbortError' ||
			      rawError.includes('Claude Code process aborted by user') ||
			      rawError.includes('The operation was aborted');

		    const settings = loadClaudeSettings();
	    const env = settings?.env || {};

    const settingsApiKey =
      env.ANTHROPIC_AUTH_TOKEN !== undefined && env.ANTHROPIC_AUTH_TOKEN !== null
        ? env.ANTHROPIC_AUTH_TOKEN
        : env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== null
          ? env.ANTHROPIC_API_KEY
          : null;

    const settingsBaseUrl =
      env.ANTHROPIC_BASE_URL !== undefined && env.ANTHROPIC_BASE_URL !== null
        ? env.ANTHROPIC_BASE_URL
        : null;

    // Note: Configuration is only read from settings.json; shell environment variables are no longer checked
    let keySource = 'Not configured';
    let rawKey = null;

    if (settingsApiKey !== null) {
      rawKey = String(settingsApiKey);
      if (env.ANTHROPIC_AUTH_TOKEN !== undefined && env.ANTHROPIC_AUTH_TOKEN !== null) {
        keySource = '~/.claude/settings.json: ANTHROPIC_AUTH_TOKEN';
      } else if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== null) {
        keySource = '~/.claude/settings.json: ANTHROPIC_API_KEY';
      } else {
        keySource = '~/.claude/settings.json';
      }
    }

    const keyPreview = rawKey && rawKey.length > 0
      ? `${rawKey.substring(0, 10)}... (length: ${rawKey.length} chars)`
      : 'Not configured (value is empty or missing)';

		    let baseUrl = settingsBaseUrl || 'https://api.anthropic.com';
		    let baseUrlSource;
		    if (settingsBaseUrl) {
		      baseUrlSource = '~/.claude/settings.json: ANTHROPIC_BASE_URL';
		    } else {
		      baseUrlSource = 'Default (https://api.anthropic.com)';
		    }

		    const heading = isAbortError
		      ? 'Claude Code was interrupted (possibly response timeout or user cancellation):'
		      : 'Claude Code error:';

		    const userMessage = [
	      heading,
	      `- Error message: ${truncateString(rawError)}`,
	      `- Current API Key source: ${keySource}`,
	      `- Current API Key preview: ${keyPreview}`,
	      `- Current Base URL: ${baseUrl} (source: ${baseUrlSource})`,
	      `- Tip: CLI can read from environment variables or settings.json; this plugin only supports reading from settings.json to avoid issues. You can configure it in the plugin's top-right Settings > Provider Management`,
	      ''
	    ].join('\n');

	    return {
	      success: false,
	      error: userMessage,
	      details: {
	        rawError,
	        errorName,
	        errorStack,
	        isAbortError,
	        keySource,
	        keyPreview,
	        baseUrl,
	        baseUrlSource
	      }
	    };
  } catch (innerError) {
    const rawError = error?.message || String(error);
    return {
      success: false,
      error: truncateString(rawError),
      details: {
        rawError,
        buildErrorFailed: String(innerError)
      }
    };
  }
}

/**
 * Send a message (supports session resumption and streaming)
 * @param {string} message - The message to send
 * @param {string} resumeSessionId - Session ID to resume
 * @param {string} cwd - Working directory
 * @param {string} permissionMode - Permission mode (optional)
 * @param {string} model - Model name (optional)
 * @param {object} openedFiles - List of opened files (optional)
 * @param {string} agentPrompt - Agent prompt (optional)
 * @param {boolean} streaming - Whether to enable streaming (optional, defaults to config value)
 */
export async function sendMessage(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null, openedFiles = null, agentPrompt = null, streaming = null) {
  console.log('[DIAG] ========== sendMessage() START ==========');
  console.log('[DIAG] message length:', message ? message.length : 0);
  console.log('[DIAG] resumeSessionId:', resumeSessionId || '(new session)');
  console.log('[DIAG] cwd:', cwd);
  console.log('[DIAG] permissionMode:', permissionMode);
  console.log('[DIAG] model:', model);

  const sdkStderrLines = [];
  let timeoutId;
  // BUG FIX: Declare these variables early to prevent undefined access in catch block if setupApiKey() throws
  let streamingEnabled = false;
  let streamStarted = false;
  let streamEnded = false;
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';
    console.log('[DEBUG] CLAUDE_CODE_ENTRYPOINT:', process.env.CLAUDE_CODE_ENTRYPOINT);

    // Set up API Key and retrieve configuration
    const { baseUrl, apiKeySource, baseUrlSource } = setupApiKey();

    // Check if a custom Base URL is being used
    if (isCustomBaseUrl(baseUrl)) {
      console.log('[DEBUG] Custom Base URL detected:', baseUrl);
      console.log('[DEBUG] Will use system Claude CLI (not Anthropic SDK fallback)');
    }

    console.log('[DEBUG] sendMessage called with params:', {
      resumeSessionId,
      cwd,
      permissionMode,
      model,
      IDEA_PROJECT_PATH: process.env.IDEA_PROJECT_PATH,
      PROJECT_PATH: process.env.PROJECT_PATH
    });

    console.log('[DEBUG] API Key source:', apiKeySource);
    console.log('[DEBUG] Base URL:', baseUrl || 'https://api.anthropic.com');
    console.log('[DEBUG] Base URL source:', baseUrlSource);

    console.log('[MESSAGE_START]');
    console.log('[DEBUG] Calling query() with prompt:', message);

    // Determine working directory intelligently
    const workingDirectory = selectWorkingDirectory(cwd);

    console.log('[DEBUG] process.cwd() before chdir:', process.cwd());
    try {
      process.chdir(workingDirectory);
      console.log('[DEBUG] Using working directory:', workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }
    console.log('[DEBUG] process.cwd() after chdir:', process.cwd());

    // Map model ID to the name expected by the SDK
    const sdkModelName = mapModelIdToSdkName(model);
    console.log('[DEBUG] Model mapping:', model, '->', sdkModelName);

    // FIX: Set model environment variables so the SDK knows which specific version to use.
    // For example, when the user selects claude-opus-4-6, we need to set ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6.
    // Otherwise the SDK only knows to use 'opus' but doesn't know whether it's 4.5 or 4.6.
    setModelEnvironmentVariables(model);

	    // Build systemPrompt.append content (for adding opened files context and agent prompt)
	    // Use the unified prompt management module to build IDE context prompt (including agent prompt)
	    console.log('[Agent] message-service.sendMessage received agentPrompt:', agentPrompt ? `✓ (${agentPrompt.length} chars)` : '✗ null');
	    let systemPromptAppend;
	    if (openedFiles && openedFiles.isQuickFix) {
	      systemPromptAppend = buildQuickFixPrompt(openedFiles, message);
	    } else {
	      systemPromptAppend = buildIDEContextPrompt(openedFiles, agentPrompt);
	    }
	    console.log('[Agent] systemPromptAppend built:', systemPromptAppend ? `✓ (${systemPromptAppend.length} chars)` : '✗ empty');

	    // Prepare options
	    // Note: No longer passing pathToClaudeCodeExecutable; the SDK will use its built-in cli.js.
	    // This avoids system CLI path issues on Windows (ENOENT errors).
	    const effectivePermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;
	    // Always provide canUseTool to ensure interactive tools like AskUserQuestion can receive user input
	    const shouldUseCanUseTool = true;
	    console.log('[PERM_DEBUG] permissionMode:', permissionMode);
	    console.log('[PERM_DEBUG] effectivePermissionMode:', effectivePermissionMode);
	    console.log('[PERM_DEBUG] shouldUseCanUseTool:', shouldUseCanUseTool);
	    console.log('[PERM_DEBUG] canUseTool function defined:', typeof canUseTool);

    // Read Extended Thinking configuration from settings.json
    const settings = loadClaudeSettings();
    const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
    const configuredMaxThinkingTokens = settings?.maxThinkingTokens
      || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
      || 10000;

    // Read streaming configuration from settings.json
    // The streaming parameter takes priority; otherwise read from config. Defaults to off (non-streaming on first install).
    // Note: Using != null to handle both null and undefined, preventing undefined from being treated as a value.
    streamingEnabled = streaming != null ? streaming : (settings?.streamingEnabled ?? false);
    console.log('[STREAMING_DEBUG] streaming param:', streaming);
    console.log('[STREAMING_DEBUG] settings.streamingEnabled:', settings?.streamingEnabled);
    console.log('[STREAMING_DEBUG] streamingEnabled (final):', streamingEnabled);

	    // Decide whether to enable Extended Thinking based on configuration
	    // - If alwaysThinkingEnabled is true, use the configured maxThinkingTokens value
	    // - If alwaysThinkingEnabled is false, don't set maxThinkingTokens (let SDK use default behavior)
	    const maxThinkingTokens = alwaysThinkingEnabled ? configuredMaxThinkingTokens : undefined;

	    console.log('[THINKING_DEBUG] alwaysThinkingEnabled:', alwaysThinkingEnabled);
	    console.log('[THINKING_DEBUG] maxThinkingTokens:', maxThinkingTokens);

	    const options = {
	      cwd: workingDirectory,
	      permissionMode: effectivePermissionMode,
	      model: sdkModelName,
	      maxTurns: 100,
	      // Enable file checkpointing for rewind feature
	      enableFileCheckpointing: true,
	      // Extended Thinking config (controlled by alwaysThinkingEnabled in settings.json)
	      // Thinking content is output via the [THINKING] tag for frontend display
	      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
	      // Streaming config: enable includePartialMessages to receive incremental content
	      // When streamingEnabled is true, the SDK returns partial messages with incremental content
	      ...(streamingEnabled && { includePartialMessages: true }),
	      additionalDirectories: Array.from(
	        new Set(
	          [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
	        )
	      ),
	      canUseTool: shouldUseCanUseTool ? canUseTool : undefined,
	      hooks: {
	        PreToolUse: [{
	          hooks: [createPreToolUseHook(effectivePermissionMode)]
	        }]
	      },
	      // Don't pass pathToClaudeCodeExecutable; SDK will use its built-in cli.js
	      settingSources: ['user', 'project', 'local'],
	      // Use the Claude Code preset system prompt so Claude knows the current working directory.
	      // This is key to fixing path issues: without systemPrompt, Claude doesn't know the cwd.
	      // If openedFiles is present, add the opened files context via the append field.
	      systemPrompt: {
	        type: 'preset',
	        preset: 'claude_code',
	        ...(systemPromptAppend && { append: systemPromptAppend })
	      },
	      // Capture SDK/CLI stderr output
	      stderr: (data) => {
	        try {
	          const text = (data ?? '').toString().trim();
	          if (text) {
	            sdkStderrLines.push(text);
	            if (sdkStderrLines.length > 50) sdkStderrLines.shift();
	            console.error(`[SDK-STDERR] ${text}`);
	          }
	        } catch (_) {}
	      }
	    };
	    console.log('[PERM_DEBUG] options.canUseTool:', options.canUseTool ? 'SET' : 'NOT SET');
	    console.log('[PERM_DEBUG] options.hooks:', options.hooks ? 'SET (PreToolUse)' : 'NOT SET');
	    console.log('[STREAMING_DEBUG] options.includePartialMessages:', options.includePartialMessages ? 'SET' : 'NOT SET');

		// AbortController-based 60s timeout (disabled due to critical issues; keeping normal query logic only)
		// const abortController = new AbortController();
		// options.abortController = abortController;

    console.log('[DEBUG] Using SDK built-in Claude CLI (cli.js)');

    console.log('[DEBUG] Options:', JSON.stringify(options, null, 2));

    // If sessionId exists and is non-empty, use resume to restore the session
    if (resumeSessionId && resumeSessionId !== '') {
      options.resume = resumeSessionId;
      console.log('[RESUMING]', resumeSessionId);
      if (!hasClaudeProjectSessionFile(resumeSessionId, workingDirectory)) {
        console.log('[RESUME_WAIT] Waiting for session file to appear before resuming...');
        await waitForClaudeProjectSessionFile(resumeSessionId, workingDirectory, 2500, 100);
      }
    }

	    console.log('[DEBUG] Query started, waiting for messages...');

	    // Dynamically load Claude SDK and get the query function
	    console.log('[DIAG] Loading Claude SDK...');
	    const sdk = await ensureClaudeSdk();
	    console.log('[DIAG] SDK loaded, exports:', sdk ? Object.keys(sdk) : 'null');
	    const query = sdk?.query;
	    if (typeof query !== 'function') {
	      throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
	    }
	    console.log('[DIAG] query function available, calling...');

    // ========== Auto-retry loop for transient API errors ==========
    let retryAttempt = 0;
    let lastRetryError = null;

    while (retryAttempt <= AUTO_RETRY_CONFIG.maxRetries) {
      // Reset state for each attempt (important for retry)
      let currentSessionId = resumeSessionId;
      let messageCount = 0;
      let hasStreamEvents = false;
      let lastAssistantContent = '';
      let lastThinkingContent = '';

      // Only log retry attempts (not the first attempt)
      if (retryAttempt > 0) {
        console.log(`[RETRY] Attempt ${retryAttempt}/${AUTO_RETRY_CONFIG.maxRetries} after error: ${lastRetryError?.message || 'unknown'}`);
      }

      try {
	    // Call the query function
        let result;
        try {
	        result = query({
	          prompt: message,
	          options
	        });
        } catch (queryError) {
          const canRetry = isRetryableError(queryError) &&
                           retryAttempt < AUTO_RETRY_CONFIG.maxRetries &&
                           messageCount <= AUTO_RETRY_CONFIG.maxMessagesForRetry;
          if (canRetry) {
            lastRetryError = queryError;
            retryAttempt++;
            const retryDelayMs = getRetryDelayMs(queryError);
            if (isNoConversationFoundError(queryError) && resumeSessionId && resumeSessionId !== '') {
              await waitForClaudeProjectSessionFile(resumeSessionId, workingDirectory, 2500, 100);
            }
            console.log(`[RETRY] Will retry (attempt ${retryAttempt}/${AUTO_RETRY_CONFIG.maxRetries}) after ${retryDelayMs}ms delay`);
            console.log(`[RETRY] Reason: ${queryError.message || String(queryError)}, messageCount: ${messageCount}`);
            await sleep(retryDelayMs);
            continue;
          }
          throw queryError;
        }
	    console.log('[DIAG] query() returned, starting message loop...');

		// 60s timeout via AbortController to cancel query (disabled due to critical issues)
		// timeoutId = setTimeout(() => {
		//   console.log('[DEBUG] Query timeout after 60 seconds, aborting...');
		//   abortController.abort();
		// }, 60000);

	    console.log('[DEBUG] Starting message loop...');

    // Streaming output
    // Streaming state tracking (streamingEnabled, streamStarted, streamEnded declared at function top)
    // Track whether stream_event has been received (to avoid duplicate fallback diff output)
    // Diff fallback: track previous assistant content for computing incremental deltas

    try {
    for await (const msg of result) {
      messageCount++;
      console.log(`[DEBUG] Received message #${messageCount}, type: ${msg.type}`);

      // Streaming: output stream start marker (only once)
      if (streamingEnabled && !streamStarted) {
        process.stdout.write('[STREAM_START]\n');
        streamStarted = true;
      }

      // Streaming: handle SDKPartialAssistantMessage (type: 'stream_event')
      // Stream events returned by SDK via includePartialMessages
      // Relaxed matching: process any stream_event type
      if (streamingEnabled && msg.type === 'stream_event') {
        hasStreamEvents = true;
        const event = msg.event;

        if (event) {
          // content_block_delta: text or JSON incremental update
          if (event.type === 'content_block_delta' && event.delta) {
            if (event.delta.type === 'text_delta' && event.delta.text) {
              // Atomic write to prevent interleaved output
              process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(event.delta.text)}\n`);
              // Accumulate synchronously to prevent duplicate output from fallback diff
              lastAssistantContent += event.delta.text;
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              // Atomic write to prevent interleaved output
              process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(event.delta.thinking)}\n`);
              lastThinkingContent += event.delta.thinking;
            }
            // input_json_delta is for tool calls; not handled yet
          }

          // content_block_start: new content block started (can identify thinking blocks)
          if (event.type === 'content_block_start' && event.content_block) {
            if (event.content_block.type === 'thinking') {
              console.log('[THINKING_START]');
            }
          }
        }

        // Critical fix: don't output [MESSAGE] for stream_event to avoid polluting the Java-side parsing pipeline
        // console.log('[STREAM_DEBUG]', JSON.stringify(msg));
        continue; // Stream event processed; skip remaining logic
      }

      // Output raw message (for Java-side parsing)
      // In streaming mode, assistant messages need special handling:
      // - If it contains tool_use, output it so the frontend can render tool blocks
      // - Pure text assistant messages are skipped to avoid overwriting streaming state
      let shouldOutputMessage = true;
      if (streamingEnabled && msg.type === 'assistant') {
        const msgContent = msg.message?.content;
        const hasToolUse = Array.isArray(msgContent) && msgContent.some(block => block.type === 'tool_use');
        if (!hasToolUse) {
          shouldOutputMessage = false;
        }
      }
      if (shouldOutputMessage) {
        console.log('[MESSAGE]', JSON.stringify(msg));
      }

      // Output assistant content in real-time (non-streaming or complete messages)
      if (msg.type === 'assistant') {
        const content = msg.message?.content;

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              const currentText = block.text || '';
              // Streaming fallback: if streaming is enabled but SDK didn't send stream_event, compute delta via diff
              if (streamingEnabled && !hasStreamEvents && currentText.length > lastAssistantContent.length) {
                const delta = currentText.substring(lastAssistantContent.length);
                if (delta) {
                  process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
                }
                lastAssistantContent = currentText;
              } else if (streamingEnabled && hasStreamEvents) {
                // Already output incrementally via stream_event; just sync state to avoid duplicates
                if (currentText.length > lastAssistantContent.length) {
                  lastAssistantContent = currentText;
                }
              } else if (!streamingEnabled) {
                // Non-streaming mode: output full content
                console.log('[CONTENT]', truncateErrorContent(currentText));
              }
            } else if (block.type === 'thinking') {
              // Output thinking process
              const thinkingText = block.thinking || block.text || '';
              // Streaming fallback: also use diff for thinking content
              if (streamingEnabled && !hasStreamEvents && thinkingText.length > lastThinkingContent.length) {
                const delta = thinkingText.substring(lastThinkingContent.length);
                if (delta) {
                  process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
                }
                lastThinkingContent = thinkingText;
              } else if (streamingEnabled && hasStreamEvents) {
                if (thinkingText.length > lastThinkingContent.length) {
                  lastThinkingContent = thinkingText;
                }
              } else if (!streamingEnabled) {
                console.log('[THINKING]', thinkingText);
              }
            } else if (block.type === 'tool_use') {
              console.log('[TOOL_USE]', JSON.stringify({ id: block.id, name: block.name }));
            }
          }
        } else if (typeof content === 'string') {
          // Streaming fallback: also use diff for string content
          if (streamingEnabled && !hasStreamEvents && content.length > lastAssistantContent.length) {
            const delta = content.substring(lastAssistantContent.length);
            if (delta) {
              process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
            }
            lastAssistantContent = content;
          } else if (streamingEnabled && hasStreamEvents) {
            if (content.length > lastAssistantContent.length) {
              lastAssistantContent = content;
            }
          } else if (!streamingEnabled) {
            console.log('[CONTENT]', truncateErrorContent(content));
          }
        }
      }

      // Emit usage data for Java-side token tracking
      emitUsageTag(msg);

      // Output tool call results in real-time (tool_result in user messages)
      if (msg.type === 'user') {
        const content = msg.message?.content ?? msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              console.log('[TOOL_RESULT]', JSON.stringify(truncateToolResultBlock(block)));
            }
          }
        }
      }

      // Capture and save session_id
      if (msg.type === 'system' && msg.session_id) {
        currentSessionId = msg.session_id;
        console.log('[SESSION_ID]', msg.session_id);

        // Store the query result for rewind operations
        activeQueryResults.set(msg.session_id, result);
        console.log('[REWIND_DEBUG] Stored query result for session:', msg.session_id);

        // Output slash_commands (if present)
        if (msg.subtype === 'init' && Array.isArray(msg.slash_commands)) {
          // console.log('[SLASH_COMMANDS]', JSON.stringify(msg.slash_commands));
        }
      }

      // Check for error result messages (quick detection of API Key errors)
      if (msg.type === 'result' && msg.is_error) {
        console.error('[DEBUG] Received error result message:', JSON.stringify(msg));
        const errorText = msg.result || msg.message || 'API request failed';
        throw new Error(errorText);
      }
    }
    } catch (loopError) {
      // Catch errors in the for-await loop (including SDK internal subprocess spawn failures)
      console.error('[DEBUG] Error in message loop:', loopError.message);
      console.error('[DEBUG] Error name:', loopError.name);
      console.error('[DEBUG] Error stack:', loopError.stack);
      // Check for subprocess-related errors
      if (loopError.code) {
        console.error('[DEBUG] Error code:', loopError.code);
      }
      if (loopError.errno) {
        console.error('[DEBUG] Error errno:', loopError.errno);
      }
      if (loopError.syscall) {
        console.error('[DEBUG] Error syscall:', loopError.syscall);
      }
      if (loopError.path) {
        console.error('[DEBUG] Error path:', loopError.path);
      }
      if (loopError.spawnargs) {
        console.error('[DEBUG] Error spawnargs:', JSON.stringify(loopError.spawnargs));
      }

      // ========== Auto-retry logic for transient API errors ==========
      // Only retry if:
      // 1. Error is retryable (transient network/API issue)
      // 2. Haven't exceeded max retries
      // 3. Few messages were processed (early failure, not mid-stream)
      const canRetry = isRetryableError(loopError) &&
                       retryAttempt < AUTO_RETRY_CONFIG.maxRetries &&
                       messageCount <= AUTO_RETRY_CONFIG.maxMessagesForRetry;

      if (canRetry) {
        lastRetryError = loopError;
        retryAttempt++;
        const retryDelayMs = getRetryDelayMs(loopError);
        if (isNoConversationFoundError(loopError) && resumeSessionId && resumeSessionId !== '') {
          await waitForClaudeProjectSessionFile(resumeSessionId, workingDirectory, 2500, 100);
        }
        console.log(`[RETRY] Will retry (attempt ${retryAttempt}/${AUTO_RETRY_CONFIG.maxRetries}) after ${retryDelayMs}ms delay`);
        console.log(`[RETRY] Reason: ${loopError.message}, messageCount: ${messageCount}`);

        // Reset streaming state for retry
        if (streamingEnabled && streamStarted && !streamEnded) {
          // Don't output STREAM_END here - we'll start fresh on retry
          streamStarted = false;
        }

        // Wait before retry
        await sleep(retryDelayMs);
        continue; // Go to next retry attempt
      }

      // Not retryable or max retries exceeded - throw to outer catch
      throw loopError;
    }

    // ========== Success - break out of retry loop ==========
    console.log(`[DEBUG] Message loop completed. Total messages: ${messageCount}`);
    if (retryAttempt > 0) {
      console.log(`[RETRY] Success after ${retryAttempt} retry attempt(s)`);
    }

    // Streaming: output stream end marker
    if (streamingEnabled && streamStarted) {
      console.log('[STREAM_END]');
      streamEnded = true;
    }

	    console.log('[MESSAGE_END]');
	    console.log(JSON.stringify({
	      success: true,
	      sessionId: currentSessionId
	    }));

    // Success - exit retry loop
    break;

      } catch (retryError) {
        // Catch errors from within the retry attempt (outer try of retryLoop)
        // This handles errors thrown by the inner catch when not retryable
        throw retryError;
      }
    } // end retryLoop

	  } catch (error) {
	    // Streaming: also end stream on error to prevent the frontend from getting stuck in streaming state
	    if (streamingEnabled && streamStarted && !streamEnded) {
	      console.log('[STREAM_END]');
	      streamEnded = true;
	    }
	    const payload = buildConfigErrorPayload(error);
    if (sdkStderrLines.length > 0) {
      const sdkErrorText = sdkStderrLines.slice(-10).join('\n');
      // Prepend SDK-STDERR to the error message
      payload.error = `SDK-STDERR:
\`\`\`
${sdkErrorText}
\`\`\`

${payload.error}`;
      payload.details.sdkError = sdkErrorText;
    }
    // Truncate final payload.error to prevent webview freezing
    payload.error = truncateString(payload.error);
    console.error('[SEND_ERROR]', JSON.stringify(payload));
    console.log(JSON.stringify(payload));
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Send message using Anthropic SDK (fallback for third-party API proxies)
 */
export async function sendMessageWithAnthropicSDK(message, resumeSessionId, cwd, permissionMode, model, apiKey, baseUrl, authType) {
  try {
    // Dynamically load Anthropic SDK
    const anthropicModule = await ensureAnthropicSdk();
    const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;

    const workingDirectory = selectWorkingDirectory(cwd);
    try { process.chdir(workingDirectory); } catch {}

    const sessionId = (resumeSessionId && resumeSessionId !== '') ? resumeSessionId : randomUUID();
    const modelId = model || 'claude-sonnet-4-5';

    // Use the correct SDK parameters based on auth type
    // authType = 'auth_token': use authToken parameter (Bearer authentication)
    // authType = 'api_key': use apiKey parameter (x-api-key authentication)
    let client;
    if (authType === 'auth_token') {
      console.log('[DEBUG] Using Bearer authentication (ANTHROPIC_AUTH_TOKEN)');
      // Use authToken parameter (Bearer authentication) and clear apiKey
      client = new Anthropic({
        authToken: apiKey,
        apiKey: null,  // Explicitly set to null to avoid sending the x-api-key header
        baseURL: baseUrl || undefined
      });
      // Prefer Bearer (ANTHROPIC_AUTH_TOKEN) and prevent sending x-api-key
      delete process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else if (authType === 'aws_bedrock') {
        console.log('[DEBUG] Using AWS_BEDROCK authentication (AWS_BEDROCK)');
        // Dynamically load Bedrock SDK
        const bedrockModule = await ensureBedrockSdk();
        const AnthropicBedrock = bedrockModule.AnthropicBedrock || bedrockModule.default || bedrockModule;
        client = new AnthropicBedrock();
    } else {
      console.log('[DEBUG] Using API Key authentication (ANTHROPIC_API_KEY)');
      // Use apiKey parameter (x-api-key authentication)
      client = new Anthropic({
        apiKey,
        baseURL: baseUrl || undefined
      });
    }

    console.log('[MESSAGE_START]');
    console.log('[SESSION_ID]', sessionId);
    console.log('[DEBUG] Using Anthropic SDK fallback for custom Base URL (non-streaming)');
    console.log('[DEBUG] Model:', modelId);
    console.log('[DEBUG] Base URL:', baseUrl);
    console.log('[DEBUG] Auth type:', authType || 'api_key (default)');

    const userContent = [{ type: 'text', text: message }];

    persistJsonlMessage(sessionId, cwd, {
      type: 'user',
      message: { content: userContent }
    });

    let messagesForApi = [{ role: 'user', content: userContent }];
    if (resumeSessionId && resumeSessionId !== '') {
      const historyMessages = loadSessionHistory(sessionId, cwd);
      if (historyMessages.length > 0) {
        messagesForApi = [...historyMessages, { role: 'user', content: userContent }];
        console.log('[DEBUG] Loaded', historyMessages.length, 'history messages for session continuity');
      }
    }

    const systemMsg = {
      type: 'system',
      subtype: 'init',
      cwd: workingDirectory,
      session_id: sessionId,
      tools: [],
      mcp_servers: [],
      model: modelId,
      permissionMode: permissionMode || 'default',
      apiKeySource: 'ANTHROPIC_API_KEY',
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(systemMsg));

    console.log('[DEBUG] Calling messages.create() with non-streaming API...');

    const response = await client.messages.create({
      model: modelId,
      max_tokens: 8192,
      messages: messagesForApi
    });

    console.log('[DEBUG] API response received');

    if (response.error || response.type === 'error') {
      const errorMsg = response.error?.message || response.message || 'Unknown API error';
      console.error('[API_ERROR]', errorMsg);

      const errorContent = [{
        type: 'text',
        text: `API error: ${errorMsg}

Possible causes:
1. API Key is not configured correctly
2. Third-party proxy service configuration issue
3. Please check the configuration in ~/.claude/settings.json`
      }];

      const assistantMsg = {
        type: 'assistant',
        message: {
          id: randomUUID(),
          model: modelId,
          role: 'assistant',
          stop_reason: 'error',
          type: 'message',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: errorContent
        },
        session_id: sessionId,
        uuid: randomUUID()
      };
      console.log('[MESSAGE]', JSON.stringify(assistantMsg));
      console.log('[CONTENT]', truncateErrorContent(errorContent[0].text));

      const resultMsg = {
        type: 'result',
        subtype: 'error',
        is_error: true,
        duration_ms: 0,
        num_turns: 1,
        result: errorContent[0].text,
        session_id: sessionId,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: randomUUID()
      };
      console.log('[MESSAGE]', JSON.stringify(resultMsg));
      console.log('[MESSAGE_END]');
      console.log(JSON.stringify({ success: false, error: errorMsg }));
      return;
    }

    const respContent = response.content || [];
    const usage = response.usage || {};

    const assistantMsg = {
      type: 'assistant',
      message: {
        id: response.id || randomUUID(),
        model: response.model || modelId,
        role: 'assistant',
        stop_reason: response.stop_reason || 'end_turn',
        type: 'message',
        usage: {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        content: respContent
      },
      session_id: sessionId,
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(assistantMsg));

    persistJsonlMessage(sessionId, cwd, {
      type: 'assistant',
      message: { content: respContent }
    });

    for (const block of respContent) {
      if (block.type === 'text') {
        console.log('[CONTENT]', truncateErrorContent(block.text));
      }
    }

    const resultMsg = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 0,
      num_turns: 1,
      result: respContent.map(b => b.type === 'text' ? b.text : '').join(''),
      session_id: sessionId,
      total_cost_usd: 0,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(resultMsg));

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({ success: true, sessionId }));

  } catch (error) {
    console.error('[SEND_ERROR]', error.message);
    if (error.response) {
      console.error('[ERROR_DETAILS] Status:', error.response.status);
      console.error('[ERROR_DETAILS] Data:', JSON.stringify(error.response.data));
    }
    console.log(JSON.stringify({ success: false, error: error.message }));
  }
}

/**
 * Send message with attachments using Claude Agent SDK (multimodal)
 */
export async function sendMessageWithAttachments(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null, stdinData = null) {
  const sdkStderrLines = [];
  let timeoutId;
  // BUG FIX: Declare these variables early to prevent undefined access in catch block if setupApiKey() throws
  let streamingEnabled = false;
  let streamStarted = false;
  let streamEnded = false;
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // Set up API Key
    setupApiKey();

    console.log('[MESSAGE_START]');

    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // Load attachments
    const attachments = await loadAttachments(stdinData);

    // Extract opened files list and agent prompt (from stdinData)
    const openedFiles = stdinData?.openedFiles || null;
    const agentPrompt = stdinData?.agentPrompt || null;
    console.log('[Agent] message-service.sendMessageWithAttachments received agentPrompt:', agentPrompt ? `✓ (${agentPrompt.length} chars)` : '✗ null');

    // Build systemPrompt.append content (for adding opened files context and agent prompt)
    // Use the unified prompt management module to build IDE context prompt (including agent prompt)
    let systemPromptAppend;
    if (openedFiles && openedFiles.isQuickFix) {
      systemPromptAppend = buildQuickFixPrompt(openedFiles, message);
    } else {
      systemPromptAppend = buildIDEContextPrompt(openedFiles, agentPrompt);
    }
    console.log('[Agent] systemPromptAppend built (with attachments):', systemPromptAppend ? `✓ (${systemPromptAppend.length} chars)` : '✗ empty');

    // Build user message content blocks
    const contentBlocks = buildContentBlocks(attachments, message);

    // Build SDKUserMessage format
    const userMessage = {
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: contentBlocks
      }
    };

    const sdkModelName = mapModelIdToSdkName(model);
    // FIX: Set model environment variables so the SDK knows which specific version to use
    setModelEnvironmentVariables(model);
    // No longer searching for system CLI; using SDK's built-in cli.js
    console.log('[DEBUG] (withAttachments) Using SDK built-in Claude CLI (cli.js)');

    // Note: inputStream is created inside the retry loop because AsyncStream can only be consumed once

    // Normalize permissionMode: treat empty string or null as 'default'
    // See docs/multimodal-permission-bug.md
    const normalizedPermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;
    console.log('[PERM_DEBUG] (withAttachments) permissionMode:', permissionMode);
    console.log('[PERM_DEBUG] (withAttachments) normalizedPermissionMode:', normalizedPermissionMode);

    // PreToolUse hook for permission control (replaces canUseTool since it's not called in AsyncIterable mode)
    // See docs/multimodal-permission-bug.md
    const preToolUseHook = createPreToolUseHook(normalizedPermissionMode);

    // Note: Per SDK docs, if no matcher is specified, the hook matches all tools.
    // We use a single global PreToolUse hook and let its internal logic decide which tools to auto-approve.

    // Read Extended Thinking configuration from settings.json
    const settings = loadClaudeSettings();
    const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
    const configuredMaxThinkingTokens = settings?.maxThinkingTokens
      || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
      || 10000;

    // Read streaming configuration from stdinData or settings.json
    // Note: Using != null to handle both null and undefined
    // Note: Variables are declared outside the try block; only assigned here
    const streamingParam = stdinData?.streaming;
    streamingEnabled = streamingParam != null
      ? streamingParam
      : (settings?.streamingEnabled ?? false);
    console.log('[STREAMING_DEBUG] (withAttachments) stdinData.streaming:', streamingParam);
    console.log('[STREAMING_DEBUG] (withAttachments) settings.streamingEnabled:', settings?.streamingEnabled);
    console.log('[STREAMING_DEBUG] (withAttachments) streamingEnabled (final):', streamingEnabled);

    // Decide whether to enable Extended Thinking based on configuration
    // - If alwaysThinkingEnabled is true, use the configured maxThinkingTokens value
    // - If alwaysThinkingEnabled is false, don't set maxThinkingTokens (let SDK use default behavior)
    const maxThinkingTokens = alwaysThinkingEnabled ? configuredMaxThinkingTokens : undefined;

    console.log('[THINKING_DEBUG] (withAttachments) alwaysThinkingEnabled:', alwaysThinkingEnabled);
    console.log('[THINKING_DEBUG] (withAttachments) maxThinkingTokens:', maxThinkingTokens);

    const options = {
      cwd: workingDirectory,
      permissionMode: normalizedPermissionMode,
      model: sdkModelName,
      maxTurns: 100,
      // Enable file checkpointing for rewind feature
      enableFileCheckpointing: true,
      // Extended Thinking config (controlled by alwaysThinkingEnabled in settings.json)
      // Thinking content is output via the [THINKING] tag for frontend display
      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
      // Streaming config: enable includePartialMessages to receive incremental content
      ...(streamingEnabled && { includePartialMessages: true }),
      additionalDirectories: Array.from(
        new Set(
          [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
        )
      ),
      // AskUserQuestion depends on canUseTool to return answers, so canUseTool must be provided for all modes
      canUseTool,
      hooks: {
        PreToolUse: [{
          hooks: [preToolUseHook]
        }]
      },
      // Don't pass pathToClaudeCodeExecutable; SDK will use its built-in cli.js
      settingSources: ['user', 'project', 'local'],
      // Use the Claude Code preset system prompt so Claude knows the current working directory.
      // This is key to fixing path issues: without systemPrompt, Claude doesn't know the cwd.
      // If openedFiles is present, add the opened files context via the append field.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(systemPromptAppend && { append: systemPromptAppend })
      },
      // Capture SDK/CLI stderr output
      stderr: (data) => {
        try {
          const text = (data ?? '').toString().trim();
          if (text) {
            sdkStderrLines.push(text);
            if (sdkStderrLines.length > 50) sdkStderrLines.shift();
            console.error(`[SDK-STDERR] ${text}`);
          }
        } catch (_) {}
      }
    };
    console.log('[PERM_DEBUG] (withAttachments) options.canUseTool:', options.canUseTool ? 'SET' : 'NOT SET');
    console.log('[PERM_DEBUG] (withAttachments) options.hooks:', options.hooks ? 'SET (PreToolUse)' : 'NOT SET');
    console.log('[PERM_DEBUG] (withAttachments) options.permissionMode:', options.permissionMode);
    console.log('[STREAMING_DEBUG] (withAttachments) options.includePartialMessages:', options.includePartialMessages ? 'SET' : 'NOT SET');

	    // Previously this used AbortController + 30s auto-timeout to cancel attachment requests.
	    // This caused misleading "Claude Code process aborted by user" errors even when config was correct.
	    // To stay consistent with plain-text sendMessage, auto-timeout is disabled here; interruption is controlled by the IDE side.
	    // const abortController = new AbortController();
	    // options.abortController = abortController;

	    if (resumeSessionId && resumeSessionId !== '') {
	      options.resume = resumeSessionId;
	      console.log('[RESUMING]', resumeSessionId);
	      if (!hasClaudeProjectSessionFile(resumeSessionId, workingDirectory)) {
	        console.log('[RESUME_WAIT] Waiting for session file to appear before resuming...');
	        await waitForClaudeProjectSessionFile(resumeSessionId, workingDirectory, 2500, 100);
	      }
	    }

		    // Dynamically load Claude SDK
		    const sdk = await ensureClaudeSdk();
		    const queryFn = sdk?.query;
            if (typeof queryFn !== 'function') {
              throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
            }

    // ========== Auto-retry loop for transient API errors ==========
    let retryAttempt = 0;
    let lastRetryError = null;
    let messageCount = 0;  // Track messages for retry decision

    while (retryAttempt <= AUTO_RETRY_CONFIG.maxRetries) {
      // Reset state for each attempt (important for retry)
      let currentSessionId = resumeSessionId;
      messageCount = 0;
      let hasStreamEvents = false;
      let lastAssistantContent = '';
      let lastThinkingContent = '';

      // Only log retry attempts (not the first attempt)
      if (retryAttempt > 0) {
        console.log(`[RETRY] (withAttachments) Attempt ${retryAttempt}/${AUTO_RETRY_CONFIG.maxRetries} after error: ${lastRetryError?.message || 'unknown'}`);
      }

      try {
        // Recreate inputStream for each retry (AsyncStream can only be consumed once)
        const inputStream = new AsyncStream();
        inputStream.enqueue(userMessage);
        inputStream.done();

        let result;
        try {
		    result = queryFn({
		      prompt: inputStream,
		      options
		    });
        } catch (queryError) {
          const canRetry = isRetryableError(queryError) &&
                           retryAttempt < AUTO_RETRY_CONFIG.maxRetries &&
                           messageCount <= AUTO_RETRY_CONFIG.maxMessagesForRetry;
          if (canRetry) {
            lastRetryError = queryError;
            retryAttempt++;
            const retryDelayMs = getRetryDelayMs(queryError);
            if (isNoConversationFoundError(queryError) && resumeSessionId && resumeSessionId !== '') {
              await waitForClaudeProjectSessionFile(resumeSessionId, workingDirectory, 2500, 100);
            }
            console.log(`[RETRY] (withAttachments) Will retry (attempt ${retryAttempt}/${AUTO_RETRY_CONFIG.maxRetries}) after ${retryDelayMs}ms delay`);
            console.log(`[RETRY] Reason: ${queryError.message || String(queryError)}, messageCount: ${messageCount}`);
            if (streamingEnabled && streamStarted && !streamEnded) {
              streamStarted = false;
            }
            await sleep(retryDelayMs);
            continue;
          }
          throw queryError;
        }

	    // To re-enable auto-timeout, implement it here via AbortController with a clear "response timeout" message
	    // timeoutId = setTimeout(() => {
	    //   console.log('[DEBUG] Query with attachments timeout after 30 seconds, aborting...');
	    //   abortController.abort();
	    // }, 30000);

		    // Streaming state tracking (streamingEnabled, streamStarted, streamEnded declared at function top)
		    // Diff fallback: track previous assistant content for computing incremental deltas

		    try {
		    for await (const msg of result) {
		      messageCount++;
		      // Streaming: output stream start marker (only once)
		      if (streamingEnabled && !streamStarted) {
		        process.stdout.write('[STREAM_START]\n');
		        streamStarted = true;
		      }

		      // Streaming: handle SDKPartialAssistantMessage (type: 'stream_event')
		      // Relaxed matching: process any stream_event type
		      if (streamingEnabled && msg.type === 'stream_event') {
		        hasStreamEvents = true;
		        const event = msg.event;

		        if (event) {
		          // content_block_delta: text or JSON incremental update
		          if (event.type === 'content_block_delta' && event.delta) {
		            if (event.delta.type === 'text_delta' && event.delta.text) {
		              process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(event.delta.text)}\n`);
		              lastAssistantContent += event.delta.text;
		            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
		              process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(event.delta.thinking)}\n`);
		              lastThinkingContent += event.delta.thinking;
		            }
		          }

		          // content_block_start: new content block started
		          if (event.type === 'content_block_start' && event.content_block) {
		            if (event.content_block.type === 'thinking') {
		              console.log('[THINKING_START]');
		            }
		          }
		        }

		        // Critical fix: don't output [MESSAGE] for stream_event
		        // console.log('[STREAM_DEBUG]', JSON.stringify(msg));
		        continue;
		      }

	    	      // In streaming mode, assistant messages need special handling
	    	      let shouldOutputMessage2 = true;
	    	      if (streamingEnabled && msg.type === 'assistant') {
	    	        const msgContent2 = msg.message?.content;
	    	        const hasToolUse2 = Array.isArray(msgContent2) && msgContent2.some(block => block.type === 'tool_use');
	    	        if (!hasToolUse2) {
	    	          shouldOutputMessage2 = false;
	    	        }
	    	      }
	    	      if (shouldOutputMessage2) {
	    	        console.log('[MESSAGE]', JSON.stringify(msg));
	    	      }

	    	      // Process complete assistant messages
	    	      if (msg.type === 'assistant') {
	    	        const content = msg.message?.content;

	    	        if (Array.isArray(content)) {
	    	          for (const block of content) {
	    	            if (block.type === 'text') {
	    	              const currentText = block.text || '';
	    	              // Streaming fallback: if streaming is enabled but SDK didn't send stream_event, compute delta via diff
	    	              if (streamingEnabled && !hasStreamEvents && currentText.length > lastAssistantContent.length) {
	    	                const delta = currentText.substring(lastAssistantContent.length);
	    	                if (delta) {
	    	                  process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
	    	                }
	    	                lastAssistantContent = currentText;
	    	              } else if (streamingEnabled && hasStreamEvents) {
	    	                if (currentText.length > lastAssistantContent.length) {
	    	                  lastAssistantContent = currentText;
	    	                }
	    	              } else if (!streamingEnabled) {
	    	                console.log('[CONTENT]', truncateErrorContent(currentText));
	    	              }
	    	            } else if (block.type === 'thinking') {
	    	              const thinkingText = block.thinking || block.text || '';
	    	              // Streaming fallback: also use diff for thinking content
	    	              if (streamingEnabled && !hasStreamEvents && thinkingText.length > lastThinkingContent.length) {
	    	                const delta = thinkingText.substring(lastThinkingContent.length);
	    	                if (delta) {
	    	                  process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
	    	                }
	    	                lastThinkingContent = thinkingText;
	    	              } else if (streamingEnabled && hasStreamEvents) {
	    	                if (thinkingText.length > lastThinkingContent.length) {
	    	                  lastThinkingContent = thinkingText;
	    	                }
	    	              } else if (!streamingEnabled) {
	    	                console.log('[THINKING]', thinkingText);
	    	              }
	    	            } else if (block.type === 'tool_use') {
	    	              console.log('[TOOL_USE]', JSON.stringify({ id: block.id, name: block.name }));
	    	            } else if (block.type === 'tool_result') {
	    	              console.log('[DEBUG] Tool result payload (withAttachments):', JSON.stringify(block));
	    	            }
	    	          }
	    	        } else if (typeof content === 'string') {
	    	          // Streaming fallback: also use diff for string content
	    	          if (streamingEnabled && !hasStreamEvents && content.length > lastAssistantContent.length) {
	    	            const delta = content.substring(lastAssistantContent.length);
	    	            if (delta) {
	    	              process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
	    	            }
	    	            lastAssistantContent = content;
	    	          } else if (streamingEnabled && hasStreamEvents) {
	    	            if (content.length > lastAssistantContent.length) {
	    	              lastAssistantContent = content;
	    	            }
	    	          } else if (!streamingEnabled) {
	    	            console.log('[CONTENT]', truncateErrorContent(content));
	    	          }
	    	        }
	    	      }

	    	      // Emit usage data for Java-side token tracking
	    	      emitUsageTag(msg);

	    	      // Output tool call results in real-time (tool_result in user messages)
	    	      if (msg.type === 'user') {
	    	        const content = msg.message?.content ?? msg.content;
	    	        if (Array.isArray(content)) {
	    	          for (const block of content) {
	    	            if (block.type === 'tool_result') {
	    	              console.log('[TOOL_RESULT]', JSON.stringify(truncateToolResultBlock(block)));
	    	            }
	    	          }
	    	        }
	    	      }

	    	      if (msg.type === 'system' && msg.session_id) {
	    	        currentSessionId = msg.session_id;
	    	        console.log('[SESSION_ID]', msg.session_id);

	    	        // Store the query result for rewind operations
	    	        activeQueryResults.set(msg.session_id, result);
	    	        console.log('[REWIND_DEBUG] (withAttachments) Stored query result for session:', msg.session_id);
	    	      }

	    	      // Check for error result messages (quick detection of API Key errors)
	    	      if (msg.type === 'result' && msg.is_error) {
	    	        console.error('[DEBUG] (withAttachments) Received error result message:', JSON.stringify(msg));
	    	        const errorText = msg.result || msg.message || 'API request failed';
	    	        throw new Error(errorText);
	    	      }
	    	    }
	    	    } catch (loopError) {
	    	      // Catch errors in the for-await loop
	    	      console.error('[DEBUG] Error in message loop (withAttachments):', loopError.message);
	    	      console.error('[DEBUG] Error name:', loopError.name);
	    	      console.error('[DEBUG] Error stack:', loopError.stack);
	    	      if (loopError.code) console.error('[DEBUG] Error code:', loopError.code);
	    	      if (loopError.errno) console.error('[DEBUG] Error errno:', loopError.errno);
	    	      if (loopError.syscall) console.error('[DEBUG] Error syscall:', loopError.syscall);
	    	      if (loopError.path) console.error('[DEBUG] Error path:', loopError.path);
	    	      if (loopError.spawnargs) console.error('[DEBUG] Error spawnargs:', JSON.stringify(loopError.spawnargs));

          // ========== Auto-retry logic for transient API errors ==========
          // Only retry if:
          // 1. Error is retryable (transient network/API issue)
          // 2. Haven't exceeded max retries
          // 3. Few messages were processed (early failure, not mid-stream)
          const canRetry = isRetryableError(loopError) &&
                           retryAttempt < AUTO_RETRY_CONFIG.maxRetries &&
                           messageCount <= AUTO_RETRY_CONFIG.maxMessagesForRetry;

          if (canRetry) {
            lastRetryError = loopError;
            retryAttempt++;
            const retryDelayMs = getRetryDelayMs(loopError);
            if (isNoConversationFoundError(loopError) && resumeSessionId && resumeSessionId !== '') {
              await waitForClaudeProjectSessionFile(resumeSessionId, workingDirectory, 2500, 100);
            }
            console.log(`[RETRY] (withAttachments) Will retry (attempt ${retryAttempt}/${AUTO_RETRY_CONFIG.maxRetries}) after ${retryDelayMs}ms delay`);
            console.log(`[RETRY] Reason: ${loopError.message}, messageCount: ${messageCount}`);

            // Reset streaming state for retry
            if (streamingEnabled && streamStarted && !streamEnded) {
              streamStarted = false;
            }

            // Wait before retry
            await sleep(retryDelayMs);
            continue; // Go to next retry attempt
          }

          // Not retryable or max retries exceeded - throw to outer catch
	    	      throw loopError;
	    	    }

    // ========== Success - break out of retry loop ==========
    if (retryAttempt > 0) {
      console.log(`[RETRY] (withAttachments) Success after ${retryAttempt} retry attempt(s)`);
    }

	    // Streaming: output stream end marker
	    if (streamingEnabled && streamStarted) {
	      console.log('[STREAM_END]');
	      streamEnded = true;
	    }

	    console.log('[MESSAGE_END]');
	    console.log(JSON.stringify({
	      success: true,
	      sessionId: currentSessionId
	    }));

    // Success - exit retry loop
    break;

      } catch (retryError) {
        // Catch errors from within the retry attempt (outer try of retryLoop)
        // This handles errors thrown by the inner catch when not retryable
        throw retryError;
      }
    } // end retryLoop

	  } catch (error) {
	    // Streaming: also end stream on error to prevent the frontend from getting stuck in streaming state
	    if (streamingEnabled && streamStarted && !streamEnded) {
	      console.log('[STREAM_END]');
	      streamEnded = true;
	    }
	    const payload = buildConfigErrorPayload(error);
    if (sdkStderrLines.length > 0) {
      const sdkErrorText = sdkStderrLines.slice(-10).join('\n');
      // Prepend SDK-STDERR to the error message
      payload.error = `SDK-STDERR:
\`\`\`
${sdkErrorText}
\`\`\`

${payload.error}`;
      payload.details.sdkError = sdkErrorText;
    }
    // Truncate final payload.error to prevent webview freezing
    payload.error = truncateString(payload.error);
    console.error('[SEND_ERROR]', JSON.stringify(payload));
    console.log(JSON.stringify(payload));
	  } finally {
	    if (timeoutId) clearTimeout(timeoutId);
	  }
	}

/**
 * Get the slash commands list.
 * Uses the SDK's supportedCommands() method to get the full command list.
 * This method does not require sending a message and can be called at plugin startup.
 */
export async function getSlashCommands(cwd = null) {
  // Default command list (used as fallback)
  const defaultCommands = [
    { name: '/help', description: 'Get help with using Claude Code' },
    { name: '/clear', description: 'Clear conversation history' },
    { name: '/compact', description: 'Toggle compact mode' },
    { name: '/config', description: 'View or modify configuration' },
    { name: '/cost', description: 'Show current session cost' },
    { name: '/doctor', description: 'Run diagnostic checks' },
    { name: '/init', description: 'Initialize a new project' },
    { name: '/login', description: 'Log in to your account' },
    { name: '/logout', description: 'Log out of your account' },
    { name: '/memory', description: 'View or manage memory' },
    { name: '/model', description: 'Change the current model' },
    { name: '/permissions', description: 'View or modify permissions' },
    { name: '/review', description: 'Review changes before applying' },
    { name: '/status', description: 'Show current status' },
    { name: '/terminal-setup', description: 'Set up terminal integration' },
    { name: '/vim', description: 'Toggle vim mode' },
  ];

  // Create a timeout Promise
  const withTimeout = (promise, ms, fallback) => {
    return Promise.race([
      promise,
      new Promise((resolve) => {
        setTimeout(() => resolve(fallback), ms);
      })
    ]);
  };

  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // Set up API Key
    setupApiKey();

    // Ensure the HOME environment variable is set correctly
    if (!process.env.HOME) {
      process.env.HOME = getRealHomeDir();
    }

    // Intelligently determine the working directory
    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // Create an empty input stream
    const inputStream = new AsyncStream();

    // Dynamically load Claude SDK (with timeout)
    const loadSdkPromise = ensureClaudeSdk();
    const sdk = await withTimeout(loadSdkPromise, 30000, null);

    if (!sdk) {
      console.log('[SLASH_COMMANDS]', JSON.stringify(defaultCommands));
      return;
    }

    const query = sdk?.query;
    if (typeof query !== 'function') {
      console.log('[SLASH_COMMANDS]', JSON.stringify(defaultCommands));
      return;
    }

    // Call the query function with the empty input stream
    const result = query({
      prompt: inputStream,
      options: {
        cwd: workingDirectory,
        permissionMode: 'default',
        maxTurns: 0,
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'Config loading only'
        }),
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        stderr: (data) => {
          if (data && data.trim()) {
            console.log(`[SDK-STDERR] ${data.trim()}`);
          }
        }
      }
    });

    // Close the input stream immediately
    inputStream.done();

    // Get supported commands list (with timeout)
    const getCommandsPromise = result.supportedCommands?.() || Promise.resolve([]);
    const slashCommands = await withTimeout(getCommandsPromise, 15000, defaultCommands);

    // Clean up resources (with timeout, non-blocking)
    withTimeout(result.return?.() || Promise.resolve(), 5000, null).catch(() => {});

    // Output the command list
    const finalCommands = slashCommands.length > 0 ? slashCommands : defaultCommands;
    console.log('[SLASH_COMMANDS]', JSON.stringify(finalCommands));

    console.log(JSON.stringify({
      success: true,
      commands: finalCommands
    }));

  } catch (error) {
    console.error('[GET_SLASH_COMMANDS_ERROR]', error.message);
    console.error('[GET_SLASH_COMMANDS_ERROR_STACK]', error.stack);
    // On error, return the default command list instead of an empty list
    console.log('[SLASH_COMMANDS]', JSON.stringify(defaultCommands));
    console.log(JSON.stringify({
      success: true, // Using default commands; not considered a failure
      commands: defaultCommands
    }));
  }
}

/**
 * Get MCP server connection status.
 * Directly validates the actual connection status of each MCP server (via mcp-status-service module).
 * @param {string} [cwd=null] - Working directory (used to detect project-specific MCP configuration)
 */
export async function getMcpServerStatus(cwd = null) {
  try {
    // Use the mcp-status-service module to get status, passing cwd for project-specific config
    const mcpStatus = await getMcpServersStatus(cwd);

    // Output with [MCP_SERVER_STATUS] tag for fast identification on the Java side.
    // Also keep a compatible JSON format as fallback.
    console.log('[MCP_SERVER_STATUS]' + JSON.stringify(mcpStatus));
  } catch (error) {
    console.error('[GET_MCP_SERVER_STATUS_ERROR]', error.message);
    // Use the tag on error too, so the Java side can identify it quickly
    console.log('[MCP_SERVER_STATUS]' + JSON.stringify([]));
  }
}

/**
 * Get the tools list for a specific MCP server.
 * Directly connects to the MCP server and retrieves its available tools (via mcp-status-service module).
 * @param {string} serverId - MCP server ID
 * @param {string} [cwd=null] - Working directory (used to detect project-specific MCP configuration)
 */
export async function getMcpServerTools(serverId, cwd = null) {
  try {
    console.log('[McpTools] Getting tools for MCP server:', serverId);

    // First load server configuration, passing cwd for project-specific config
    const mcpServers = await loadMcpServersConfig(cwd);
    const targetServer = mcpServers.find(s => s.name === serverId);

    if (!targetServer) {
      console.log(JSON.stringify({
        success: false,
        serverId,
        error: `Server not found: ${serverId}`
      }));
      return;
    }

    // Call mcp-status-service to get the tools list
    const toolsResult = await getMcpServerToolsImpl(serverId, targetServer.config);

    // Output results with a prefix tag for quick identification by the Java backend
    const tools = toolsResult.tools || [];
    const hasError = !!toolsResult.error;
    // success=true means tools are usable; error may still contain warnings
    // success=false only when no tools AND has error (e.g. timeout, connection failure)
    const resultJson = JSON.stringify({
      success: !hasError || tools.length > 0,
      serverId,
      serverName: toolsResult.name,
      tools,
      error: toolsResult.error
    });
    console.log('[MCP_SERVER_TOOLS]', resultJson);
    console.log(resultJson);

  } catch (error) {
    console.error('[GET_MCP_SERVER_TOOLS_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      serverId,
      error: error.message,
      tools: []
    }));
  }
}

/**
 * Rewind files to a specific user message state
 * Uses the SDK's rewindFiles() API to restore files to their state at a given message
 * @param {string} sessionId - Session ID
 * @param {string} userMessageId - User message UUID to rewind to
 * @param {string} cwd - Working directory (optional)
 */
export async function rewindFiles(sessionId, userMessageId, cwd = null) {
  let result = null;
  try {
    console.log('[REWIND] ========== REWIND OPERATION START ==========');
    console.log('[REWIND] Session ID:', sessionId);
    console.log('[REWIND] Target message ID:', userMessageId);
    console.log('[REWIND] CWD:', cwd);
    console.log('[REWIND] Active sessions in memory:', Array.from(activeQueryResults.keys()));

    // Get the stored query result for this session
    result = activeQueryResults.get(sessionId);
    console.log('[REWIND] Result found in memory:', !!result);

    // If result not in memory, try to resume the session to get a fresh query result
    if (!result) {
      console.log('[REWIND] Session not in memory, attempting to resume...');

      try {
        process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

        setupApiKey();

        if (!process.env.HOME) {
          process.env.HOME = getRealHomeDir();
        }

        const workingDirectory = selectWorkingDirectory(cwd);
        try {
          process.chdir(workingDirectory);
        } catch (chdirError) {
          console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
        }

        if (!hasClaudeProjectSessionFile(sessionId, workingDirectory)) {
          console.log('[RESUME_WAIT] Waiting for session file to appear before resuming...');
          await waitForClaudeProjectSessionFile(sessionId, workingDirectory, 2500, 100);
        }

        const options = {
          resume: sessionId,
          cwd: workingDirectory,
          permissionMode: 'default',
          enableFileCheckpointing: true,
          maxTurns: 1,
          tools: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project', 'local'],
          additionalDirectories: Array.from(
            new Set(
              [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
            )
          ),
          canUseTool: async () => ({
            behavior: 'deny',
            message: 'Rewind operation'
          }),
          stderr: (data) => {
            if (data && data.trim()) {
              console.log(`[SDK-STDERR] ${data.trim()}`);
            }
          }
        };

        console.log('[REWIND] Resuming session with options:', JSON.stringify(options));

        // Dynamically load Claude SDK
        const sdk = await ensureClaudeSdk();
        const query = sdk?.query;
        if (typeof query !== 'function') {
          throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
        }

        try {
          result = query({ prompt: '', options });
        } catch (queryError) {
          if (isNoConversationFoundError(queryError)) {
            await waitForClaudeProjectSessionFile(sessionId, workingDirectory, 2500, 100);
            result = query({ prompt: '', options });
          } else {
            throw queryError;
          }
        }

      } catch (resumeError) {
        const errorMsg = `Failed to resume session ${sessionId}: ${resumeError.message}`;
        console.error('[REWIND_ERROR]', errorMsg);
        console.log(JSON.stringify({
          success: false,
          error: errorMsg
        }));
        return;
      }
    }

    // Check if rewindFiles method exists on the result object
    if (typeof result.rewindFiles !== 'function') {
      const errorMsg = 'rewindFiles method not available. File checkpointing may not be enabled or SDK version too old.';
      console.error('[REWIND_ERROR]', errorMsg);
      console.log(JSON.stringify({
        success: false,
        error: errorMsg
      }));
      return;
    }

    const timeoutMs = 45000;

    const attemptRewind = async (targetUserMessageId) => {
      console.log('[REWIND] Calling result.rewindFiles()...', JSON.stringify({ targetUserMessageId }));
      await Promise.race([
        result.rewindFiles(targetUserMessageId),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Rewind timeout (${timeoutMs}ms)`)), timeoutMs))
      ]);
      return targetUserMessageId;
    };

    let usedMessageId = null;
    try {
      usedMessageId = await attemptRewind(userMessageId);
    } catch (primaryError) {
      const msg = primaryError?.message || String(primaryError);
      if (!msg.includes('No file checkpoint found for message')) {
        throw primaryError;
      }

      console.log('[REWIND] No checkpoint for requested message, attempting to resolve alternative user message id...');

      const candidateIds = await resolveRewindCandidateMessageIds(sessionId, cwd, userMessageId);
      console.log('[REWIND] Candidate message ids:', JSON.stringify(candidateIds));

      let lastError = primaryError;
      for (const candidateId of candidateIds) {
        if (!candidateId || candidateId === userMessageId) continue;
        try {
          usedMessageId = await attemptRewind(candidateId);
          lastError = null;
          break;
        } catch (candidateError) {
          lastError = candidateError;
          const candidateMsg = candidateError?.message || String(candidateError);
          if (!candidateMsg.includes('No file checkpoint found for message')) {
            throw candidateError;
          }
        }
      }

      if (!usedMessageId) {
        throw lastError;
      }
    }

    console.log('[REWIND] Files rewound successfully');

    console.log(JSON.stringify({
      success: true,
      message: 'Files restored successfully',
      sessionId,
      targetMessageId: usedMessageId
    }));

  } catch (error) {
    console.error('[REWIND_ERROR]', error.message);
    console.error('[REWIND_ERROR_STACK]', error.stack);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
  } finally {
    try {
      await result?.return?.();
    } catch {
    }
  }
}

async function resolveRewindCandidateMessageIds(sessionId, cwd, providedMessageId) {
  const messages = await readClaudeProjectSessionMessages(sessionId, cwd);
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const byId = new Map();
  for (const m of messages) {
    if (m && typeof m === 'object' && typeof m.uuid === 'string') {
      byId.set(m.uuid, m);
    }
  }

  const isUserTextMessage = (m) => {
    if (!m || m.type !== 'user') return false;
    const content = m.message?.content;
    if (!content) return false;
    if (typeof content === 'string') {
      return content.trim().length > 0;
    }
    if (Array.isArray(content)) {
      return content.some((b) => b && b.type === 'text' && String(b.text || '').trim().length > 0);
    }
    return false;
  };

  const candidates = [];
  const visited = new Set();

  let current = providedMessageId ? byId.get(providedMessageId) : null;
  while (current && current.uuid && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    if (typeof current.uuid === 'string') {
      candidates.push(current.uuid);
    }
    if (isUserTextMessage(current) && typeof current.uuid === 'string') {
      candidates.push(current.uuid);
      break;
    }
    const parent = current.parentUuid ? byId.get(current.parentUuid) : null;
    current = parent || null;
  }

  const lastUserText = [...messages].reverse().find(isUserTextMessage);
  if (lastUserText?.uuid) {
    candidates.push(lastUserText.uuid);
  }

  const unique = [];
  const seen = new Set();
  for (const id of candidates) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }

  const maxCandidates = 8;
  if (unique.length <= maxCandidates) return unique;
  return unique.slice(0, maxCandidates);
}

async function readClaudeProjectSessionMessages(sessionId, cwd) {
  try {
    const projectsDir = join(getClaudeDir(), 'projects');
    const sanitizedCwd = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
    const sessionFile = join(projectsDir, sanitizedCwd, `${sessionId}.jsonl`);
    if (!existsSync(sessionFile)) {
      return [];
    }
    const content = await readFile(sessionFile, 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get active session IDs for debugging
 * @returns {string[]} Array of active session IDs
 */
export function getActiveSessionIds() {
  return Array.from(activeQueryResults.keys());
}

/**
 * Check if a session has an active query result for rewind operations
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} True if session has active query result
 */
export function hasActiveSession(sessionId) {
  return activeQueryResults.has(sessionId);
}

/**
 * Remove a session from the active query results map
 * Should be called when a session ends to free up memory
 * @param {string} sessionId - Session ID to remove
 */
export function removeSession(sessionId) {
  if (activeQueryResults.has(sessionId)) {
    activeQueryResults.delete(sessionId);
    console.log('[REWIND_DEBUG] Removed session from active queries:', sessionId);
    return true;
  }
  return false;
}
