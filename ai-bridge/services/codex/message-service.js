/**
 * Codex Message Service
 *
 * Handles message sending through Codex SDK (@openai/codex-sdk).
 * Provides unified interface that matches Claude's message service.
 *
 * Key Differences from Claude:
 * - Uses threadId instead of sessionId
 * - Permission model: skipGitRepoCheck + sandbox (not permissionMode string)
 * - Events: thread.*, turn.*, item.* (not system/assistant/user/result)
 * - No attachments support (text-only)
 *
 * @author Crafted with geek spirit
 */

// SDK 动态加载 - 不再静态导入，而是按需加载
import { loadCodexSdk, isCodexSdkAvailable } from '../../utils/sdk-loader.js';
import { CodexPermissionMapper } from '../../utils/permission-mapper.js';
import { randomUUID } from 'crypto';

// SDK 缓存
let codexSdk = null;

/**
 * 确保 Codex SDK 已加载
 */
async function ensureCodexSdk() {
    if (!codexSdk) {
        if (!isCodexSdkAvailable()) {
            const error = new Error('Codex SDK not installed. Please install via Settings > Dependencies.');
            error.code = 'SDK_NOT_INSTALLED';
            error.provider = 'codex';
            throw error;
        }
        codexSdk = await loadCodexSdk();
    }
    return codexSdk;
}

const MAX_TOOL_RESULT_CHARS = 20000;

/**
 * Send message to Codex (with optional thread resumption)
 *
 * @param {string} message - User message to send
 * @param {string} threadId - Thread ID to resume (optional)
 * @param {string} cwd - Working directory (optional)
 * @param {string} permissionMode - Unified permission mode (optional)
 * @param {string} model - Model name (optional)
 * @param {string} baseUrl - API base URL (optional, for custom endpoints)
 * @param {string} apiKey - API key (optional, for custom auth)
 */
export async function sendMessage(
  message,
  threadId = null,
  cwd = null,
  permissionMode = null,
  model = null,
  baseUrl = null,
  apiKey = null,
  reasoningEffort = 'medium'
) {
  try {
    console.log('[DEBUG] Codex sendMessage called with params:', {
      threadId,
      cwd,
      permissionMode,
      model,
      reasoningEffort,
      hasBaseUrl: !!baseUrl,
      hasApiKey: !!apiKey
    });

    console.log('[MESSAGE_START]');

    // ============================================================
    // 1. Initialize Codex SDK (动态加载)
    // ============================================================

    // 动态加载 Codex SDK
    const sdk = await ensureCodexSdk();
    const Codex = sdk.Codex || sdk.default || sdk;

    const codexOptions = {};

    // Configure custom API endpoint
    if (baseUrl) {
      codexOptions.baseUrl = baseUrl;
    }

    // Configure custom API key
    if (apiKey) {
      codexOptions.apiKey = apiKey;
    }

    const codex = new Codex(codexOptions);

    // ============================================================
    // 2. Map Unified Permission Mode to Codex Format
    // ============================================================

    const permissionConfig = CodexPermissionMapper.toProvider(
      permissionMode || 'default'
    );

    console.log('[PERM_DEBUG] Codex permission config:', permissionConfig);

    // ============================================================
    // 3. Build Thread Options
    // ============================================================

    const threadOptions = {
      skipGitRepoCheck: permissionConfig.skipGitRepoCheck,
      maxTurns: 20  // Prevent infinite loops
    };

    // Set reasoning effort (thinking depth)
    if (reasoningEffort && reasoningEffort.trim() !== '') {
      threadOptions.modelReasoningEffort = reasoningEffort;
      console.log('[DEBUG] Reasoning effort:', reasoningEffort);
    }

    if (permissionConfig.approvalPolicy) {
      threadOptions.approvalPolicy = permissionConfig.approvalPolicy;
    }

    // CRITICAL: Only set working directory for NEW threads
    // When resuming an existing thread, Codex SDK needs to find the session file
    // in its default location (~/.codex/sessions/), so we must NOT override workingDirectory
    const isResumingThread = threadId && threadId.trim() !== '';

    if (!isResumingThread) {
      // New thread: set working directory if provided
      if (cwd && cwd.trim() !== '') {
        threadOptions.workingDirectory = cwd;
        console.log('[DEBUG] Working directory:', cwd);
      }
    } else {
      console.log('[DEBUG] Resuming thread - skipping workingDirectory to allow session lookup');
    }

    // Set model
    if (model && model.trim() !== '') {
      threadOptions.model = model;
      console.log('[DEBUG] Model:', model);
    }

    // Set sandbox mode (permission restriction)
    if (permissionConfig.sandbox) {
      threadOptions.sandboxMode = permissionConfig.sandbox;
      console.log('[DEBUG] Sandbox mode:', permissionConfig.sandbox);
    }

    // ============================================================
    // 4. Create or Resume Thread
    // ============================================================

    let thread;
    if (isResumingThread) {
      console.log('[DEBUG] Resuming thread:', threadId);
      thread = codex.resumeThread(threadId, threadOptions);
    } else {
      console.log('[DEBUG] Starting new thread');
      thread = codex.startThread(threadOptions);
    }

    // ============================================================
    // 5. Execute Streaming Query
    // ============================================================

    const { events } = await thread.runStreamed(message);

    let currentThreadId = threadId;
    let finalResponse = '';
    let assistantText = '';
    const pendingToolUseIdsByCommand = new Map();
    const emittedToolUseIds = new Set();
    const reasoningTextCache = new Map();
    let reasoningObserved = false;

    const emitMessage = (msg) => {
      console.log('[MESSAGE]', JSON.stringify(msg));
    };

    const truncateForDisplay = (text, maxChars) => {
      if (typeof text !== 'string') {
        return String(text ?? '');
      }
      if (maxChars <= 0 || text.length <= maxChars) {
        return text;
      }
      const head = Math.max(0, Math.floor(maxChars * 0.65));
      const tail = Math.max(0, maxChars - head);
      const prefix = text.slice(0, head);
      const suffix = tail > 0 ? text.slice(Math.max(0, text.length - tail)) : '';
      return `${prefix}\n...\n(truncated, original length: ${text.length} chars)\n...\n${suffix}`;
    };

    const getStableItemId = (item) => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item.id ?? item.item_id ?? item.uuid;
      return typeof candidate === 'string' && candidate.trim() ? candidate : null;
    };

    const extractCommand = (item) => {
      const cmd = item?.command;
      return typeof cmd === 'string' ? cmd : '';
    };

    const rememberPendingToolUseId = (command, toolUseId) => {
      if (!command) return;
      const list = pendingToolUseIdsByCommand.get(command) ?? [];
      list.push(toolUseId);
      pendingToolUseIdsByCommand.set(command, list);
    };

    const consumePendingToolUseId = (command) => {
      if (!command) return null;
      const list = pendingToolUseIdsByCommand.get(command);
      if (!Array.isArray(list) || list.length === 0) return null;
      const id = list.shift() ?? null;
      if (list.length === 0) {
        pendingToolUseIdsByCommand.delete(command);
      } else {
        pendingToolUseIdsByCommand.set(command, list);
      }
      return id;
    };

    const ensureToolUseId = (phase, item) => {
      const stableId = getStableItemId(item);
      if (stableId) return stableId;

      const command = extractCommand(item);
      if (phase === 'completed') {
        return consumePendingToolUseId(command) ?? randomUUID();
      }

      const id = randomUUID();
      rememberPendingToolUseId(command, id);
      return id;
    };

    /**
     * Extract actual command from shell wrapper
     * Handles formats like: /bin/zsh -lc 'cd dir && command'
     */
    const extractActualCommand = (command) => {
      if (!command || typeof command !== 'string') {
        return command;
      }

      let cmd = command.trim();

      // Extract from /bin/zsh -lc '...' or /bin/bash -c '...'
      const shellWrapperMatch = cmd.match(/^\/bin\/(zsh|bash)\s+(?:-lc|-c)\s+['"](.+)['"]$/);
      if (shellWrapperMatch) {
        cmd = shellWrapperMatch[2];
      }

      // Remove 'cd dir &&' prefix if present
      const cdPrefixMatch = cmd.match(/^cd\s+\S+\s+&&\s+(.+)$/);
      if (cdPrefixMatch) {
        cmd = cdPrefixMatch[1];
      }

      return cmd.trim();
    };

    /**
     * Smart tool name conversion - matches HistoryHandler.java logic
     * Converts shell commands to more specific tool types based on command pattern
     */
    const smartToolName = (command) => {
      if (!command || typeof command !== 'string') {
        return 'bash';
      }

      // Extract actual command from shell wrapper
      const actualCmd = extractActualCommand(command);

      // File viewing commands -> read
      if (/^(ls|pwd|find|cat|head|tail|file|stat|tree)\b/.test(actualCmd)) {
        return 'read';
      }

      // sed -n (read-only mode for viewing specific lines) -> read
      // Example: sed -n '700,780p' file.txt
      if (/^sed\s+-n\s+/.test(actualCmd)) {
        return 'read';
      }

      // Search commands -> glob (collapsible)
      if (/^(grep|rg|ack|ag)\b/.test(actualCmd)) {
        return 'glob';
      }

      // Other commands stay as bash
      return 'bash';
    };

    /**
     * Generate smart description based on command pattern
     * Provides more meaningful descriptions than generic "Codex command execution"
     */
    const smartDescription = (command) => {
      if (!command || typeof command !== 'string') {
        return 'Execute command';
      }

      // Extract actual command from shell wrapper
      const actualCmd = extractActualCommand(command);
      const firstWord = actualCmd.split(/\s+/)[0];

      // File viewing commands
      if (/^ls\b/.test(actualCmd)) return 'List directory contents';
      if (/^pwd\b/.test(actualCmd)) return 'Show current directory';
      if (/^cat\b/.test(actualCmd)) return 'Read file contents';
      if (/^head\b/.test(actualCmd)) return 'Read first lines';
      if (/^tail\b/.test(actualCmd)) return 'Read last lines';
      if (/^find\b/.test(actualCmd)) return 'Find files';
      if (/^tree\b/.test(actualCmd)) return 'Show directory tree';

      // sed -n for reading specific lines
      if (/^sed\s+-n\s+/.test(actualCmd)) return 'Read file lines';

      // Search commands
      if (/^(grep|rg|ack|ag)\b/.test(actualCmd)) return 'Search in files';

      // Git commands
      if (/^git\s+status\b/.test(actualCmd)) return 'Check git status';
      if (/^git\s+diff\b/.test(actualCmd)) return 'Show git diff';
      if (/^git\s+log\b/.test(actualCmd)) return 'Show git log';
      if (/^git\s+add\b/.test(actualCmd)) return 'Stage changes';
      if (/^git\s+commit\b/.test(actualCmd)) return 'Commit changes';
      if (/^git\s+push\b/.test(actualCmd)) return 'Push to remote';
      if (/^git\s+pull\b/.test(actualCmd)) return 'Pull from remote';
      if (/^git\s+/.test(actualCmd)) return `Run git ${actualCmd.substring(4).split(/\s+/)[0]}`;

      // Build/Package commands
      if (/^npm\s+install\b/.test(actualCmd)) return 'Install npm packages';
      if (/^npm\s+run\b/.test(actualCmd)) return 'Run npm script';
      if (/^npm\s+/.test(actualCmd)) return `Run npm ${actualCmd.substring(4).split(/\s+/)[0]}`;
      if (/^(yarn|pnpm)\s+/.test(actualCmd)) return `Run ${firstWord} command`;
      if (/^(gradle|mvn|make)\b/.test(actualCmd)) return `Run ${firstWord} build`;

      // Default: use command as-is for short commands, or first word for long ones
      return actualCmd.length <= 30 ? actualCmd : `Run ${firstWord}`;
    };

    const emitThinkingBlock = (text) => {
      console.log('[THINKING]', text);
      emitMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: text,
              text
            }
          ]
        }
      });
    };

    const maybeEmitReasoning = (item) => {
      if (!item || item.type !== 'reasoning') return;
      const raw = typeof item.text === 'string' ? item.text : '';
      const text = raw.trim();
      if (!text) return;
      const stableId = getStableItemId(item) ?? randomUUID();
      if (reasoningTextCache.get(stableId) === text) {
        return;
      }
      reasoningTextCache.set(stableId, text);
      reasoningObserved = true;
      emitThinkingBlock(text);
    };

    // ============================================================
    // 6. Process Events and Map to Claude-Compatible [MESSAGE] JSON
    // ============================================================

    for await (const event of events) {
      console.log('[DEBUG] Codex event:', event.type);

      switch (event.type) {
        case 'thread.started': {
          currentThreadId = event.thread_id;
          console.log('[THREAD_ID]', currentThreadId);
          break;
        }

        case 'turn.started': {
          console.log('[DEBUG] Turn started');
          break;
        }

        case 'item.started': {
          maybeEmitReasoning(event.item);
          if (event.item && event.item.type === 'command_execution') {
            const toolUseId = ensureToolUseId('started', event.item);
            const command = extractCommand(event.item);

            // Use smart tool name and description conversion
            const toolName = smartToolName(command);
            const description = smartDescription(command);

            emitMessage({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: toolUseId,
                    name: toolName,
                    input: {
                      command,
                      description
                    }
                  }
                ]
              }
            });
            emittedToolUseIds.add(toolUseId);
          }
          break;
        }

        case 'item.updated': {
          maybeEmitReasoning(event.item);
          break;
        }

        case 'item.completed': {
          if (!event.item) break;

          // 【DEBUG】详细记录 item 信息，帮助诊断
          console.log('[DEBUG] item.completed - type:', event.item.type);
          console.log('[DEBUG] item.completed - has text:', !!event.item.text);
          console.log('[DEBUG] item.completed - has agent_message:', !!event.item.agent_message);

          maybeEmitReasoning(event.item);

          if (event.item.type === 'agent_message') {
            const text = event.item.text || '';
            console.log('[DEBUG] agent_message text length:', text.length);
            console.log('[DEBUG] agent_message text (first 100 chars):', text.substring(0, 100));
            console.log('[DEBUG] agent_message text.trim() length:', text.trim().length);

            finalResponse = text;
            assistantText += text;
            if (text && text.trim()) {
              console.log('[DEBUG] About to emit agent message');
              emitMessage({
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text }]
                }
              });
              console.log('[DEBUG] Agent message emitted');
            } else {
              console.log('[DEBUG] Skipping empty agent message');
            }
          } else if (event.item.type === 'command_execution') {
            const toolUseId = ensureToolUseId('completed', event.item);
            const command = extractCommand(event.item);
            const output =
              event.item.aggregated_output ??
              event.item.output ??
              event.item.stdout ??
              event.item.result ??
              '';
            const outputStrRaw = typeof output === 'string' ? output : JSON.stringify(output);
            const outputStr = truncateForDisplay(outputStrRaw, MAX_TOOL_RESULT_CHARS);
            const isError =
              (typeof event.item.exit_code === 'number' && event.item.exit_code !== 0) ||
              event.item.is_error === true;

            // Use smart tool name and description conversion
            const toolName = smartToolName(command);
            const description = smartDescription(command);

            if (!emittedToolUseIds.has(toolUseId)) {
              emitMessage({
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool_use',
                      id: toolUseId,
                      name: toolName,
                      input: {
                        command,
                        description
                      }
                    }
                  ]
                }
              });
              emittedToolUseIds.add(toolUseId);
            }

            emitMessage({
              type: 'user',
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    is_error: isError,
                    content: outputStr && outputStr.trim() ? outputStr : '(no output)'
                  }
                ]
              }
            });
          } else {
            console.log('[DEBUG] Unhandled item.completed item type:', event.item.type);
          }
          break;
        }

        case 'turn.completed': {
          console.log('[DEBUG] Turn completed');
          if (event.usage) {
            console.log('[DEBUG] Token usage:', event.usage);

            // Convert Codex usage format to Claude-compatible format
            // Codex format: { input_tokens, cached_input_tokens, output_tokens }
            // Claude format: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
            const claudeUsage = {
              input_tokens: event.usage.input_tokens || 0,
              output_tokens: event.usage.output_tokens || 0,
              cache_creation_input_tokens: 0, // Codex doesn't provide this
              cache_read_input_tokens: event.usage.cached_input_tokens || 0
            };

            // Emit usage statistics as a result-like message for compatibility with Java layer
            // This allows the frontend to display usage statistics for Codex sessions
            const usageMessage = {
              type: 'result',
              subtype: 'usage',
              is_error: false,
              usage: claudeUsage,
              session_id: currentThreadId,
              uuid: randomUUID()
            };

            emitMessage(usageMessage);
            console.log('[DEBUG] Emitted usage statistics (Claude-compatible format):', claudeUsage);
          }
          break;
        }

        case 'turn.failed': {
          const errorMsg = event.error?.message || 'Turn failed';
          console.error('[DEBUG] Turn failed:', errorMsg);
          throw new Error(errorMsg);
        }

        case 'error': {
          const generalError = event.message || 'Unknown error';
          console.error('[DEBUG] Codex error:', generalError);
          throw new Error(generalError);
        }

        default: {
          console.log('[DEBUG] Unknown event type:', event.type);
        }
      }
    }

    if (!reasoningObserved) {
      console.warn('[THINKING_HINT]', 'Codex 未返回 reasoning 项。若依然看不到思考过程，请参考 docs/codex/docs/config.md 中 hide_agent_reasoning/show_raw_agent_reasoning 的说明，并确认 OpenAI 账号已完成验证。');
    }

    // ============================================================
    // 7. Send Completion Signal
    // ============================================================

    // If no agent message received, provide explanation
    if (assistantText.length === 0) {
      const noResponseMsg = [
        '\n⚠️ Codex completed tool executions but did not generate a text response.',
        'This may happen when:',
        '- The task was purely about gathering information',
        '- Codex reached maxTurns limit (20 turns)',
        '- The query required only command execution',
        '\nPlease try:',
        '- Asking a more specific question',
        '- Requesting explicit analysis or explanation',
        '- Checking the command outputs above for your answer'
      ].join('\n');

      emitMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: noResponseMsg }]
        }
      });
      finalResponse = noResponseMsg;
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      threadId: currentThreadId,
      result: finalResponse
    }));

  } catch (error) {
    console.error('[DEBUG] Error:', error.message);
    console.error('[DEBUG] Error stack:', error.stack);

    const errorPayload = buildErrorPayload(error);
    console.error('[SEND_ERROR]', JSON.stringify(errorPayload));
    console.log(JSON.stringify(errorPayload));
  }
}

/**
 * Build error response with helpful diagnostics
 *
 * @param {Error} error - The error object
 * @returns {object} Structured error payload
 */
function buildErrorPayload(error) {
  const rawError = error?.message || String(error);
  const errorName = error?.name || 'Error';

  // Detect common error types
  const isAuthError = rawError.includes('API key') ||
                      rawError.includes('authentication') ||
                      rawError.includes('unauthorized') ||
                      rawError.includes('401') ||
                      rawError.includes('Missing environment variable') ||
                      rawError.includes('CODEX_API_KEY');

  const isNetworkError = rawError.includes('ECONNREFUSED') ||
                         rawError.includes('ETIMEDOUT') ||
                         rawError.includes('network') ||
                         rawError.includes('fetch failed');

  let userMessage;

  if (isAuthError) {
    userMessage = [
      'Codex 认证错误:',
      `- 错误信息: ${rawError}`,
      '',
      '请检查以下配置:',
      '1. 插件设置中的 Codex API Key 是否正确',
      '2. API Key 是否有足够的权限',
      '3. 如果使用自定义 Base URL，请确认地址正确',
      '',
      '提示: Codex 需要有效的 OpenAI API Key'
    ].join('\n');
  } else if (isNetworkError) {
    userMessage = [
      'Codex 网络错误:',
      `- 错误信息: ${rawError}`,
      '',
      '请检查:',
      '1. 网络连接是否正常',
      '2. 如果使用代理，请确认代理配置',
      '3. 防火墙是否阻止了连接'
    ].join('\n');
  } else {
    userMessage = [
      'Codex 出现错误:',
      `- 错误信息: ${rawError}`,
      '',
      '请检查网络连接和 Codex 配置'
    ].join('\n');
  }

  return {
    success: false,
    error: userMessage,
    details: {
      rawError,
      errorName,
      isAuthError,
      isNetworkError
    }
  };
}
