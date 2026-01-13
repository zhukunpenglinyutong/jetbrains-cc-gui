/**
 * Message sending service module.
 * Responsible for sending messages through Claude Agent SDK.
 */

// SDK 动态加载 - 不再静态导入，而是按需加载
import {
    loadClaudeSdk,
    loadAnthropicSdk,
    loadBedrockSdk,
    isClaudeSdkAvailable
} from '../../utils/sdk-loader.js';
import { randomUUID } from 'crypto';

// SDK 缓存
let claudeSdk = null;
let anthropicSdk = null;
let bedrockSdk = null;

/**
 * 确保 Claude SDK 已加载
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
 * 确保 Anthropic SDK 已加载
 */
async function ensureAnthropicSdk() {
    if (!anthropicSdk) {
        anthropicSdk = await loadAnthropicSdk();
    }
    return anthropicSdk;
}

/**
 * 确保 Bedrock SDK 已加载
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
import { homedir } from 'os';

import { setupApiKey, isCustomBaseUrl, loadClaudeSettings } from '../../config/api-config.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import { mapModelIdToSdkName } from '../../utils/model-utils.js';
import { AsyncStream } from '../../utils/async-stream.js';
import { canUseTool } from '../../permission-handler.js';
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
  const normalizedPermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;

  return async (input) => {
    console.log('[PERM_DEBUG] PreToolUse hook called:', input?.tool_name);

    if (normalizedPermissionMode === 'plan') {
      return {
        decision: 'block',
        reason: 'Permission mode is plan (no execution)'
      };
    }

    if (shouldAutoApproveTool(normalizedPermissionMode, input?.tool_name)) {
      console.log('[PERM_DEBUG] Auto-approve tool:', input?.tool_name, 'mode:', normalizedPermissionMode);
      return { decision: 'approve' };
    }

    console.log('[PERM_DEBUG] Calling canUseTool...');
    try {
      const result = await canUseTool(input?.tool_name, input?.tool_input);
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
 * 发送消息（支持会话恢复）
 * @param {string} message - 要发送的消息
 * @param {string} resumeSessionId - 要恢复的会话ID
 * @param {string} cwd - 工作目录
 * @param {string} permissionMode - 权限模式（可选）
 * @param {string} model - 模型名称（可选）
 */
	function buildConfigErrorPayload(error) {
			  try {
			    const rawError = error?.message || String(error);
			    const errorName = error?.name || 'Error';
			    const errorStack = error?.stack || null;

			    // 之前这里对 AbortError / "Claude Code process aborted by user" 做了超时提示
			    // 现在统一走错误处理逻辑，但仍然在 details 中记录是否为超时/中断类错误，方便排查
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

    // 注意：配置只从 settings.json 读取，不再检查 shell 环境变量
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
	      `- Error message: ${rawError}`,
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
      error: rawError,
      details: {
        rawError,
        buildErrorFailed: String(innerError)
      }
    };
  }
}

/**
 * 发送消息（支持会话恢复和流式传输）
 * @param {string} message - 要发送的消息
 * @param {string} resumeSessionId - 要恢复的会话ID
 * @param {string} cwd - 工作目录
 * @param {string} permissionMode - 权限模式（可选）
 * @param {string} model - 模型名称（可选）
 * @param {object} openedFiles - 打开的文件列表（可选）
 * @param {string} agentPrompt - 智能体提示词（可选）
 * @param {boolean} streaming - 是否启用流式传输（可选，默认从配置读取）
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
  // 🔧 BUG FIX: 提前声明这些变量，避免在 setupApiKey() 抛出错误时，catch 块访问未定义变量
  let streamingEnabled = false;
  let streamStarted = false;
  let streamEnded = false;
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';
    console.log('[DEBUG] CLAUDE_CODE_ENTRYPOINT:', process.env.CLAUDE_CODE_ENTRYPOINT);

    // 设置 API Key 并获取配置信息（包含认证类型）
    const { baseUrl, authType, apiKeySource, baseUrlSource } = setupApiKey();

    // 检测是否使用自定义 Base URL
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

    // 智能确定工作目录
    const workingDirectory = selectWorkingDirectory(cwd);

    console.log('[DEBUG] process.cwd() before chdir:', process.cwd());
    try {
      process.chdir(workingDirectory);
      console.log('[DEBUG] Using working directory:', workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }
    console.log('[DEBUG] process.cwd() after chdir:', process.cwd());

    // 将模型 ID 映射为 SDK 期望的名称
    const sdkModelName = mapModelIdToSdkName(model);
    console.log('[DEBUG] Model mapping:', model, '->', sdkModelName);

	    // Build systemPrompt.append content (for adding opened files context and agent prompt)
	    // 使用统一的提示词管理模块构建 IDE 上下文提示词（包括智能体提示词）
	    console.log('[Agent] message-service.sendMessage received agentPrompt:', agentPrompt ? `✓ (${agentPrompt.length} chars)` : '✗ null');
	    let systemPromptAppend;
	    if (openedFiles && openedFiles.isQuickFix) {
	      systemPromptAppend = buildQuickFixPrompt(openedFiles, message);
	    } else {
	      systemPromptAppend = buildIDEContextPrompt(openedFiles, agentPrompt);
	    }
	    console.log('[Agent] systemPromptAppend built:', systemPromptAppend ? `✓ (${systemPromptAppend.length} chars)` : '✗ empty');

	    // 准备选项
	    // 注意：不再传递 pathToClaudeCodeExecutable，让 SDK 自动使用内置 cli.js
	    // 这样可以避免 Windows 下系统 CLI 路径问题（ENOENT 错误）
	    const effectivePermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;
	    const shouldUseCanUseTool = effectivePermissionMode === 'default';
	    console.log('[PERM_DEBUG] permissionMode:', permissionMode);
	    console.log('[PERM_DEBUG] effectivePermissionMode:', effectivePermissionMode);
	    console.log('[PERM_DEBUG] shouldUseCanUseTool:', shouldUseCanUseTool);
	    console.log('[PERM_DEBUG] canUseTool function defined:', typeof canUseTool);

    // 🔧 从 settings.json 读取 Extended Thinking 配置
    const settings = loadClaudeSettings();
    const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
    const configuredMaxThinkingTokens = settings?.maxThinkingTokens
      || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
      || 10000;

    // 🔧 从 settings.json 读取流式传输配置
    // streaming 参数优先，否则从配置读取，默认关闭（首次安装时为非流式）
    // 注意：使用 != null 同时处理 null 和 undefined，避免 undefined 被当成"有值"
    streamingEnabled = streaming != null ? streaming : (settings?.streamingEnabled ?? false);
    console.log('[STREAMING_DEBUG] streaming param:', streaming);
    console.log('[STREAMING_DEBUG] settings.streamingEnabled:', settings?.streamingEnabled);
    console.log('[STREAMING_DEBUG] streamingEnabled (final):', streamingEnabled);

	    // 根据配置决定是否启用 Extended Thinking
	    // - 如果 alwaysThinkingEnabled 为 true，使用配置的 maxThinkingTokens 值
	    // - 如果 alwaysThinkingEnabled 为 false，不设置 maxThinkingTokens（让 SDK 使用默认行为）
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
	      // Extended Thinking 配置（根据 settings.json 的 alwaysThinkingEnabled 决定）
	      // 思考内容会通过 [THINKING] 标签输出给前端展示
	      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
	      // 🔧 流式传输配置：启用 includePartialMessages 以获取增量内容
	      // 当 streamingEnabled 为 true 时，SDK 会返回包含增量内容的部分消息
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
	      // 不传递 pathToClaudeCodeExecutable，SDK 将自动使用内置 cli.js
	      settingSources: ['user', 'project', 'local'],
	      // 使用 Claude Code 预设系统提示，让 Claude 知道当前工作目录
	      // 这是修复路径问题的关键：没有 systemPrompt 时 Claude 不知道 cwd
	      // 如果有 openedFiles，通过 append 字段添加打开文件的上下文
	      systemPrompt: {
	        type: 'preset',
	        preset: 'claude_code',
	        ...(systemPromptAppend && { append: systemPromptAppend })
	      },
	      // 新增：捕获 SDK/CLI 的标准错误输出
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

		// 使用 AbortController 实现 60 秒超时控制（已发现严重问题，暂时禁用自动超时，仅保留正常查询逻辑）
		// const abortController = new AbortController();
		// options.abortController = abortController;

    console.log('[DEBUG] Using SDK built-in Claude CLI (cli.js)');

    console.log('[DEBUG] Options:', JSON.stringify(options, null, 2));

    // 如果有 sessionId 且不为空字符串，使用 resume 恢复会话
    if (resumeSessionId && resumeSessionId !== '') {
      options.resume = resumeSessionId;
      console.log('[RESUMING]', resumeSessionId);
    }

	    console.log('[DEBUG] Query started, waiting for messages...');

	    // 动态加载 Claude SDK 并获取 query 函数
	    console.log('[DIAG] Loading Claude SDK...');
	    const sdk = await ensureClaudeSdk();
	    console.log('[DIAG] SDK loaded, exports:', sdk ? Object.keys(sdk) : 'null');
	    const query = sdk?.query;
	    if (typeof query !== 'function') {
	      throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
	    }
	    console.log('[DIAG] query function available, calling...');

	    // 调用 query 函数
	    const result = query({
	      prompt: message,
	      options
	    });
	    console.log('[DIAG] query() returned, starting message loop...');

		// 设置 60 秒超时，超时后通过 AbortController 取消查询（已发现严重问题，暂时注释掉自动超时逻辑）
		// timeoutId = setTimeout(() => {
		//   console.log('[DEBUG] Query timeout after 60 seconds, aborting...');
		//   abortController.abort();
		// }, 60000);

	    console.log('[DEBUG] Starting message loop...');

    let currentSessionId = resumeSessionId;

    // 流式输出
    let messageCount = 0;
    // 🔧 流式传输状态追踪（已在函数开头声明 streamingEnabled, streamStarted, streamEnded）
    // 🔧 标记是否收到了 stream_event（用于避免 fallback diff 重复输出）
    let hasStreamEvents = false;
    // 🔧 diff fallback: 追踪上次的 assistant 内容，用于计算增量
    let lastAssistantContent = '';
    let lastThinkingContent = '';

    try {
    for await (const msg of result) {
      messageCount++;
      console.log(`[DEBUG] Received message #${messageCount}, type: ${msg.type}`);

      // 🔧 流式传输：输出流式开始标记（仅首次）
      if (streamingEnabled && !streamStarted) {
        console.log('[STREAM_START]');
        streamStarted = true;
      }

      // 🔧 流式传输：处理 SDKPartialAssistantMessage（type: 'stream_event'）
      // SDK 通过 includePartialMessages 返回的流式事件
      // 放宽识别条件：只要是 stream_event 类型就尝试处理
      if (streamingEnabled && msg.type === 'stream_event') {
        hasStreamEvents = true;
        const event = msg.event;

        if (event) {
          // content_block_delta: 文本或 JSON 增量
          if (event.type === 'content_block_delta' && event.delta) {
            if (event.delta.type === 'text_delta' && event.delta.text) {
              // 🔧 使用 JSON 编码，保留换行符等特殊字符
              console.log('[CONTENT_DELTA]', JSON.stringify(event.delta.text));
              // 同步累积，避免后续 fallback diff 重复输出
              lastAssistantContent += event.delta.text;
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              // 🔧 使用 JSON 编码，保留换行符等特殊字符
              console.log('[THINKING_DELTA]', JSON.stringify(event.delta.thinking));
              lastThinkingContent += event.delta.thinking;
            }
            // input_json_delta 用于工具调用，暂不处理
          }

          // content_block_start: 新内容块开始（可用于识别 thinking 块）
          if (event.type === 'content_block_start' && event.content_block) {
            if (event.content_block.type === 'thinking') {
              console.log('[THINKING_START]');
            }
          }
        }

        // 🔧 关键修复：stream_event 不输出 [MESSAGE]，避免污染 Java 侧解析链路
        // console.log('[STREAM_DEBUG]', JSON.stringify(msg));
        continue; // 流式事件已处理，跳过后续逻辑
      }

      // 输出原始消息（方便 Java 解析）
      // 🔧 流式模式下，assistant 消息需要特殊处理
      // - 如果包含 tool_use，需要输出让前端显示工具块
      // - 纯文本 assistant 消息不输出，避免覆盖流式状态
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

      // 实时输出助手内容（非流式或完整消息）
      if (msg.type === 'assistant') {
        const content = msg.message?.content;

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              const currentText = block.text || '';
              // 🔧 流式 fallback: 如果启用流式但 SDK 没给 stream_event，则用 diff 计算 delta
              if (streamingEnabled && !hasStreamEvents && currentText.length > lastAssistantContent.length) {
                const delta = currentText.substring(lastAssistantContent.length);
                if (delta) {
                  console.log('[CONTENT_DELTA]', delta);
                }
                lastAssistantContent = currentText;
              } else if (streamingEnabled && hasStreamEvents) {
                // 已通过 stream_event 输出过增量，避免重复；仅做状态对齐
                if (currentText.length > lastAssistantContent.length) {
                  lastAssistantContent = currentText;
                }
              } else if (!streamingEnabled) {
                // 非流式模式：输出完整内容
                console.log('[CONTENT]', currentText);
              }
            } else if (block.type === 'thinking') {
              // 输出思考过程
              const thinkingText = block.thinking || block.text || '';
              // 🔧 流式 fallback: thinking 也用 diff
              if (streamingEnabled && !hasStreamEvents && thinkingText.length > lastThinkingContent.length) {
                const delta = thinkingText.substring(lastThinkingContent.length);
                if (delta) {
                  console.log('[THINKING_DELTA]', delta);
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
          // 🔧 流式 fallback: 字符串内容也用 diff
          if (streamingEnabled && !hasStreamEvents && content.length > lastAssistantContent.length) {
            const delta = content.substring(lastAssistantContent.length);
            if (delta) {
              console.log('[CONTENT_DELTA]', delta);
            }
            lastAssistantContent = content;
          } else if (streamingEnabled && hasStreamEvents) {
            if (content.length > lastAssistantContent.length) {
              lastAssistantContent = content;
            }
          } else if (!streamingEnabled) {
            console.log('[CONTENT]', content);
          }
        }
      }

      // 实时输出工具调用结果（user 消息中的 tool_result）
      if (msg.type === 'user') {
        const content = msg.message?.content ?? msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              console.log('[TOOL_RESULT]', JSON.stringify({ tool_use_id: block.tool_use_id, is_error: block.is_error }));
            }
          }
        }
      }

      // 捕获并保存 session_id
      if (msg.type === 'system' && msg.session_id) {
        currentSessionId = msg.session_id;
        console.log('[SESSION_ID]', msg.session_id);

        // Store the query result for rewind operations
        activeQueryResults.set(msg.session_id, result);
        console.log('[REWIND_DEBUG] Stored query result for session:', msg.session_id);

        // 输出 slash_commands（如果存在）
        if (msg.subtype === 'init' && Array.isArray(msg.slash_commands)) {
          // console.log('[SLASH_COMMANDS]', JSON.stringify(msg.slash_commands));
        }
      }

      // 检查是否收到错误结果消息（快速检测 API Key 错误）
      if (msg.type === 'result' && msg.is_error) {
        console.error('[DEBUG] Received error result message:', JSON.stringify(msg));
        const errorText = msg.result || msg.message || 'API request failed';
        throw new Error(errorText);
      }
    }
    } catch (loopError) {
      // 捕获 for await 循环中的错误（包括 SDK 内部 spawn 子进程失败等）
      console.error('[DEBUG] Error in message loop:', loopError.message);
      console.error('[DEBUG] Error name:', loopError.name);
      console.error('[DEBUG] Error stack:', loopError.stack);
      // 检查是否是子进程相关错误
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
      throw loopError; // 重新抛出让外层 catch 处理
    }

    console.log(`[DEBUG] Message loop completed. Total messages: ${messageCount}`);

    // 🔧 流式传输：输出流式结束标记
    if (streamingEnabled && streamStarted) {
      console.log('[STREAM_END]');
      streamEnded = true;
    }

	    console.log('[MESSAGE_END]');
	    console.log(JSON.stringify({
	      success: true,
	      sessionId: currentSessionId
	    }));

	  } catch (error) {
	    // 🔧 流式传输：异常时也要结束流式，避免前端卡在 streaming 状态
	    if (streamingEnabled && streamStarted && !streamEnded) {
	      console.log('[STREAM_END]');
	      streamEnded = true;
	    }
	    const payload = buildConfigErrorPayload(error);
    if (sdkStderrLines.length > 0) {
      const sdkErrorText = sdkStderrLines.slice(-10).join('\n');
      // 在错误信息最前面添加 SDK-STDERR
      payload.error = `SDK-STDERR:\n\`\`\`\n${sdkErrorText}\n\`\`\`\n\n${payload.error}`;
      payload.details.sdkError = sdkErrorText;
    }
    console.error('[SEND_ERROR]', JSON.stringify(payload));
    console.log(JSON.stringify(payload));
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * 使用 Anthropic SDK 发送消息（用于第三方 API 代理的回退方案）
 */
export async function sendMessageWithAnthropicSDK(message, resumeSessionId, cwd, permissionMode, model, apiKey, baseUrl, authType) {
  try {
    // 动态加载 Anthropic SDK
    const anthropicModule = await ensureAnthropicSdk();
    const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;

    const workingDirectory = selectWorkingDirectory(cwd);
    try { process.chdir(workingDirectory); } catch {}

    const sessionId = (resumeSessionId && resumeSessionId !== '') ? resumeSessionId : randomUUID();
    const modelId = model || 'claude-sonnet-4-5';

    // 根据认证类型使用正确的 SDK 参数
    // authType = 'auth_token': 使用 authToken 参数（Bearer 认证）
    // authType = 'api_key': 使用 apiKey 参数（x-api-key 认证）
    let client;
    if (authType === 'auth_token') {
      console.log('[DEBUG] Using Bearer authentication (ANTHROPIC_AUTH_TOKEN)');
      // 使用 authToken 参数（Bearer 认证）并清除 apiKey
      client = new Anthropic({
        authToken: apiKey,
        apiKey: null,  // 明确设置为 null 避免使用 x-api-key header
        baseURL: baseUrl || undefined
      });
      // 优先使用 Bearer（ANTHROPIC_AUTH_TOKEN），避免继续发送 x-api-key
      delete process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else if (authType === 'aws_bedrock') {
        console.log('[DEBUG] Using AWS_BEDROCK authentication (AWS_BEDROCK)');
        // 动态加载 Bedrock SDK
        const bedrockModule = await ensureBedrockSdk();
        const AnthropicBedrock = bedrockModule.AnthropicBedrock || bedrockModule.default || bedrockModule;
        client = new AnthropicBedrock();
    } else {
      console.log('[DEBUG] Using API Key authentication (ANTHROPIC_API_KEY)');
      // 使用 apiKey 参数（x-api-key 认证）
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
        text: `API error: ${errorMsg}\n\nPossible causes:\n1. API Key is not configured correctly\n2. Third-party proxy service configuration issue\n3. Please check the configuration in ~/.claude/settings.json`
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
      console.log('[CONTENT]', errorContent[0].text);

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
        console.log('[CONTENT]', block.text);
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
 * 使用 Claude Agent SDK 发送带附件的消息（多模态）
 */
export async function sendMessageWithAttachments(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null, stdinData = null) {
  const sdkStderrLines = [];
  let timeoutId;
  // 🔧 BUG FIX: 提前声明这些变量，避免在 setupApiKey() 抛出错误时，catch 块访问未定义变量
  let streamingEnabled = false;
  let streamStarted = false;
  let streamEnded = false;
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // 设置 API Key 并获取配置信息（包含认证类型）
    const { baseUrl, authType } = setupApiKey();

    console.log('[MESSAGE_START]');

    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // 加载附件
    const attachments = await loadAttachments(stdinData);

    // 提取打开的文件列表和智能体提示词（从 stdinData）
    const openedFiles = stdinData?.openedFiles || null;
    const agentPrompt = stdinData?.agentPrompt || null;
    console.log('[Agent] message-service.sendMessageWithAttachments received agentPrompt:', agentPrompt ? `✓ (${agentPrompt.length} chars)` : '✗ null');

    // Build systemPrompt.append content (for adding opened files context and agent prompt)
    // 使用统一的提示词管理模块构建 IDE 上下文提示词（包括智能体提示词）
    let systemPromptAppend;
    if (openedFiles && openedFiles.isQuickFix) {
      systemPromptAppend = buildQuickFixPrompt(openedFiles, message);
    } else {
      systemPromptAppend = buildIDEContextPrompt(openedFiles, agentPrompt);
    }
    console.log('[Agent] systemPromptAppend built (with attachments):', systemPromptAppend ? `✓ (${systemPromptAppend.length} chars)` : '✗ empty');

    // 构建用户消息内容块
    const contentBlocks = buildContentBlocks(attachments, message);

    // 构建 SDKUserMessage 格式
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
    // 不再查找系统 CLI，使用 SDK 内置 cli.js
    console.log('[DEBUG] (withAttachments) Using SDK built-in Claude CLI (cli.js)');

    // 创建输入流并放入用户消息
    const inputStream = new AsyncStream();
    inputStream.enqueue(userMessage);
    inputStream.done();

    // 规范化 permissionMode：空字符串或 null 都视为 'default'
    // 参见 docs/multimodal-permission-bug.md
    const normalizedPermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;
    console.log('[PERM_DEBUG] (withAttachments) permissionMode:', permissionMode);
    console.log('[PERM_DEBUG] (withAttachments) normalizedPermissionMode:', normalizedPermissionMode);

    // PreToolUse hook 用于权限控制（替代 canUseTool，因为在 AsyncIterable 模式下 canUseTool 不被调用）
    // 参见 docs/multimodal-permission-bug.md
    const preToolUseHook = createPreToolUseHook(normalizedPermissionMode);

    // 注意：根据 SDK 文档，如果不指定 matcher，则该 Hook 会匹配所有工具
    // 这里统一使用一个全局 PreToolUse Hook，由 Hook 内部决定哪些工具自动放行

    // 🔧 从 settings.json 读取 Extended Thinking 配置
    const settings = loadClaudeSettings();
    const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
    const configuredMaxThinkingTokens = settings?.maxThinkingTokens
      || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
      || 10000;

    // 🔧 从 stdinData 或 settings.json 读取流式传输配置
    // 注意：使用 != null 同时处理 null 和 undefined
    // 注意：变量已在 try 块外部声明，这里只赋值
    const streamingParam = stdinData?.streaming;
    streamingEnabled = streamingParam != null
      ? streamingParam
      : (settings?.streamingEnabled ?? false);
    console.log('[STREAMING_DEBUG] (withAttachments) stdinData.streaming:', streamingParam);
    console.log('[STREAMING_DEBUG] (withAttachments) settings.streamingEnabled:', settings?.streamingEnabled);
    console.log('[STREAMING_DEBUG] (withAttachments) streamingEnabled (final):', streamingEnabled);

    // 根据配置决定是否启用 Extended Thinking
    // - 如果 alwaysThinkingEnabled 为 true，使用配置的 maxThinkingTokens 值
    // - 如果 alwaysThinkingEnabled 为 false，不设置 maxThinkingTokens（让 SDK 使用默认行为）
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
      // Extended Thinking 配置（根据 settings.json 的 alwaysThinkingEnabled 决定）
      // 思考内容会通过 [THINKING] 标签输出给前端展示
      ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
      // 🔧 流式传输配置：启用 includePartialMessages 以获取增量内容
      ...(streamingEnabled && { includePartialMessages: true }),
      additionalDirectories: Array.from(
        new Set(
          [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
        )
      ),
      // 同时设置 canUseTool 和 hooks，确保至少一个生效
      // 在 AsyncIterable 模式下 canUseTool 可能不被调用，所以必须配置 PreToolUse hook
      canUseTool: normalizedPermissionMode === 'default' ? canUseTool : undefined,
      hooks: {
        PreToolUse: [{
          hooks: [preToolUseHook]
        }]
      },
      // 不传递 pathToClaudeCodeExecutable，SDK 将自动使用内置 cli.js
      settingSources: ['user', 'project', 'local'],
      // 使用 Claude Code 预设系统提示，让 Claude 知道当前工作目录
      // 这是修复路径问题的关键：没有 systemPrompt 时 Claude 不知道 cwd
      // 如果有 openedFiles，通过 append 字段添加打开文件的上下文
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(systemPromptAppend && { append: systemPromptAppend })
      },
      // 新增：捕获 SDK/CLI 的标准错误输出
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

	    // 之前这里通过 AbortController + 30 秒自动超时来中断带附件的请求
	    // 这会导致在配置正确的情况下仍然出现 "Claude Code process aborted by user" 的误导性错误
	    // 为保持与纯文本 sendMessage 一致，这里暂时禁用自动超时逻辑，改由 IDE 侧中断控制
	    // const abortController = new AbortController();
	    // options.abortController = abortController;

	    if (resumeSessionId && resumeSessionId !== '') {
	      options.resume = resumeSessionId;
	      console.log('[RESUMING]', resumeSessionId);
	    }

		    // 动态加载 Claude SDK
		    const sdk = await ensureClaudeSdk();
		    const queryFn = sdk?.query;
            if (typeof queryFn !== 'function') {
              throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
            }

		    const result = queryFn({
		      prompt: inputStream,
		      options
		    });

	    // 如需再次启用自动超时，可在此处通过 AbortController 实现，并确保给出清晰的"响应超时"提示
	    // timeoutId = setTimeout(() => {
	    //   console.log('[DEBUG] Query with attachments timeout after 30 seconds, aborting...');
	    //   abortController.abort();
	    // }, 30000);

		    let currentSessionId = resumeSessionId;
		    // 🔧 流式传输状态追踪（已在函数开头声明 streamingEnabled, streamStarted, streamEnded）
		    let hasStreamEvents = false;
		    // 🔧 diff fallback: 追踪上次的 assistant 内容，用于计算增量
		    let lastAssistantContent = '';
		    let lastThinkingContent = '';

		    try {
		    for await (const msg of result) {
		      // 🔧 流式传输：输出流式开始标记（仅首次）
		      if (streamingEnabled && !streamStarted) {
		        console.log('[STREAM_START]');
		        streamStarted = true;
		      }

		      // 🔧 流式传输：处理 SDKPartialAssistantMessage（type: 'stream_event'）
		      // 放宽识别条件：只要是 stream_event 类型就尝试处理
		      if (streamingEnabled && msg.type === 'stream_event') {
		        hasStreamEvents = true;
		        const event = msg.event;

		        if (event) {
		          // content_block_delta: 文本或 JSON 增量
		          if (event.type === 'content_block_delta' && event.delta) {
		            if (event.delta.type === 'text_delta' && event.delta.text) {
		              console.log('[CONTENT_DELTA]', event.delta.text);
		              lastAssistantContent += event.delta.text;
		            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
		              console.log('[THINKING_DELTA]', event.delta.thinking);
		              lastThinkingContent += event.delta.thinking;
		            }
		          }

		          // content_block_start: 新内容块开始
		          if (event.type === 'content_block_start' && event.content_block) {
		            if (event.content_block.type === 'thinking') {
		              console.log('[THINKING_START]');
		            }
		          }
		        }

		        // 🔧 关键修复：stream_event 不输出 [MESSAGE]
		        // console.log('[STREAM_DEBUG]', JSON.stringify(msg));
		        continue;
		      }

	    	      // 🔧 流式模式下，assistant 消息需要特殊处理
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

	    	      // 处理完整的助手消息
	    	      if (msg.type === 'assistant') {
	    	        const content = msg.message?.content;

	    	        if (Array.isArray(content)) {
	    	          for (const block of content) {
	    	            if (block.type === 'text') {
	    	              const currentText = block.text || '';
	    	              // 🔧 流式 fallback: 如果启用流式但 SDK 没给 stream_event，则用 diff 计算 delta
	    	              if (streamingEnabled && !hasStreamEvents && currentText.length > lastAssistantContent.length) {
	    	                const delta = currentText.substring(lastAssistantContent.length);
	    	                if (delta) {
	    	                  console.log('[CONTENT_DELTA]', delta);
	    	                }
	    	                lastAssistantContent = currentText;
	    	              } else if (streamingEnabled && hasStreamEvents) {
	    	                if (currentText.length > lastAssistantContent.length) {
	    	                  lastAssistantContent = currentText;
	    	                }
	    	              } else if (!streamingEnabled) {
	    	                console.log('[CONTENT]', currentText);
	    	              }
	    	            } else if (block.type === 'thinking') {
	    	              const thinkingText = block.thinking || block.text || '';
	    	              // 🔧 流式 fallback: thinking 也用 diff
	    	              if (streamingEnabled && !hasStreamEvents && thinkingText.length > lastThinkingContent.length) {
	    	                const delta = thinkingText.substring(lastThinkingContent.length);
	    	                if (delta) {
	    	                  console.log('[THINKING_DELTA]', delta);
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
	    	          // 🔧 流式 fallback: 字符串内容也用 diff
	    	          if (streamingEnabled && !hasStreamEvents && content.length > lastAssistantContent.length) {
	    	            const delta = content.substring(lastAssistantContent.length);
	    	            if (delta) {
	    	              console.log('[CONTENT_DELTA]', delta);
	    	            }
	    	            lastAssistantContent = content;
	    	          } else if (streamingEnabled && hasStreamEvents) {
	    	            if (content.length > lastAssistantContent.length) {
	    	              lastAssistantContent = content;
	    	            }
	    	          } else if (!streamingEnabled) {
	    	            console.log('[CONTENT]', content);
	    	          }
	    	        }
	    	      }

	    	      // 实时输出工具调用结果（user 消息中的 tool_result）
	    	      if (msg.type === 'user') {
	    	        const content = msg.message?.content ?? msg.content;
	    	        if (Array.isArray(content)) {
	    	          for (const block of content) {
	    	            if (block.type === 'tool_result') {
	    	              console.log('[TOOL_RESULT]', JSON.stringify({ tool_use_id: block.tool_use_id, is_error: block.is_error }));
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

	    	      // 检查是否收到错误结果消息（快速检测 API Key 错误）
	    	      if (msg.type === 'result' && msg.is_error) {
	    	        console.error('[DEBUG] (withAttachments) Received error result message:', JSON.stringify(msg));
	    	        const errorText = msg.result || msg.message || 'API request failed';
	    	        throw new Error(errorText);
	    	      }
	    	    }
	    	    } catch (loopError) {
	    	      // 捕获 for await 循环中的错误
	    	      console.error('[DEBUG] Error in message loop (withAttachments):', loopError.message);
	    	      console.error('[DEBUG] Error name:', loopError.name);
	    	      console.error('[DEBUG] Error stack:', loopError.stack);
	    	      if (loopError.code) console.error('[DEBUG] Error code:', loopError.code);
	    	      if (loopError.errno) console.error('[DEBUG] Error errno:', loopError.errno);
	    	      if (loopError.syscall) console.error('[DEBUG] Error syscall:', loopError.syscall);
	    	      if (loopError.path) console.error('[DEBUG] Error path:', loopError.path);
	    	      if (loopError.spawnargs) console.error('[DEBUG] Error spawnargs:', JSON.stringify(loopError.spawnargs));
	    	      throw loopError;
	    	    }

	    // 🔧 流式传输：输出流式结束标记
	    if (streamingEnabled && streamStarted) {
	      console.log('[STREAM_END]');
	      streamEnded = true;
	    }

	    console.log('[MESSAGE_END]');
	    console.log(JSON.stringify({
	      success: true,
	      sessionId: currentSessionId
	    }));

	  } catch (error) {
	    // 🔧 流式传输：异常时也要结束流式，避免前端卡在 streaming 状态
	    if (streamingEnabled && streamStarted && !streamEnded) {
	      console.log('[STREAM_END]');
	      streamEnded = true;
	    }
	    const payload = buildConfigErrorPayload(error);
    if (sdkStderrLines.length > 0) {
      const sdkErrorText = sdkStderrLines.slice(-10).join('\n');
      // 在错误信息最前面添加 SDK-STDERR
      payload.error = `SDK-STDERR:\n\`\`\`\n${sdkErrorText}\n\`\`\`\n\n${payload.error}`;
      payload.details.sdkError = sdkErrorText;
    }
    console.error('[SEND_ERROR]', JSON.stringify(payload));
    console.log(JSON.stringify(payload));
	  } finally {
	    if (timeoutId) clearTimeout(timeoutId);
	  }
	}

/**
 * 获取斜杠命令列表
 * 通过 SDK 的 supportedCommands() 方法获取完整的命令列表
 * 这个方法不需要发送消息，可以在插件启动时调用
 */
export async function getSlashCommands(cwd = null) {
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // 设置 API Key
    setupApiKey();

    // 确保 HOME 环境变量设置正确
    if (!process.env.HOME) {
      const os = await import('os');
      process.env.HOME = os.homedir();
    }

    // 智能确定工作目录
    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // 创建一个空的输入流
    const inputStream = new AsyncStream();

    // 动态加载 Claude SDK
    const sdk = await ensureClaudeSdk();
    const query = sdk?.query;
    if (typeof query !== 'function') {
      throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
    }

    // 调用 query 函数，使用空输入流
    // 这样不会发送任何消息，只是初始化 SDK 以获取配置
    const result = query({
      prompt: inputStream,
      options: {
        cwd: workingDirectory,
        permissionMode: 'default',
        maxTurns: 0,  // 不需要进行任何轮次
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'Config loading only'
        }),
        // 明确启用默认工具集
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        // 捕获 SDK stderr 调试日志，帮助定位 CLI 初始化问题
        stderr: (data) => {
          if (data && data.trim()) {
            console.log(`[SDK-STDERR] ${data.trim()}`);
          }
        }
      }
    });

    // 立即关闭输入流，告诉 SDK 我们没有消息要发送
    inputStream.done();

    // 获取支持的命令列表
    // SDK 返回的格式是 SlashCommand[]，包含 name 和 description
    const slashCommands = await result.supportedCommands?.() || [];

    // 清理资源
    await result.return?.();

    // 输出命令列表（包含 name 和 description）
    console.log('[SLASH_COMMANDS]', JSON.stringify(slashCommands));

    console.log(JSON.stringify({
      success: true,
      commands: slashCommands
    }));

  } catch (error) {
    console.error('[GET_SLASH_COMMANDS_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message,
      commands: []
    }));
  }
}

/**
 * 获取 MCP 服务器连接状态
 * 通过 SDK 的 mcpServerStatus() 方法获取所有配置的 MCP 服务器的连接状态
 * @param {string} cwd - 工作目录（可选）
 */
export async function getMcpServerStatus(cwd = null) {
  try {
    process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';

    // 设置 API Key
    setupApiKey();

    // 确保 HOME 环境变量设置正确
    if (!process.env.HOME) {
      const os = await import('os');
      process.env.HOME = os.homedir();
    }

    // 智能确定工作目录
    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch (chdirError) {
      console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
    }

    // 创建一个空的输入流
    const inputStream = new AsyncStream();

    // 动态加载 Claude SDK
    const sdk = await ensureClaudeSdk();
    const query = sdk?.query;
    if (typeof query !== 'function') {
      throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
    }

    // 调用 query 函数，使用空输入流
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

    // 立即关闭输入流
    inputStream.done();

    // 获取 MCP 服务器状态
    // SDK 返回的格式是 McpServerStatus[]，包含 name, status, serverInfo
    const mcpStatus = await result.mcpServerStatus?.() || [];

    // 清理资源
    await result.return?.();

    // 输出 MCP 服务器状态
    console.log('[MCP_SERVER_STATUS]', JSON.stringify(mcpStatus));

    console.log(JSON.stringify({
      success: true,
      servers: mcpStatus
    }));

  } catch (error) {
    console.error('[GET_MCP_SERVER_STATUS_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message,
      servers: []
    }));
  }
}

/**
 * Rewind files to a specific user message state
 * Uses the SDK's rewindFiles() API to restore files to their state at a given message
 * @param {string} sessionId - Session ID
 * @param {string} userMessageId - User message UUID to rewind to
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
          const os = await import('os');
          process.env.HOME = os.homedir();
        }

        const workingDirectory = selectWorkingDirectory(cwd);
        try {
          process.chdir(workingDirectory);
        } catch (chdirError) {
          console.error('[WARNING] Failed to change process.cwd():', chdirError.message);
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

        // 动态加载 Claude SDK
        const sdk = await ensureClaudeSdk();
        const query = sdk?.query;
        if (typeof query !== 'function') {
          throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
        }

        result = query({ prompt: '', options });

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
    const projectsDir = join(homedir(), '.claude', 'projects');
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
