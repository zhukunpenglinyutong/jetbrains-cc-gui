/**
 * Persistent query service for daemon mode.
 * Keeps Claude Query processes alive across turns to reduce per-request latency.
 */

import { loadClaudeSdk } from '../../utils/sdk-loader.js';
import { isCustomBaseUrl, loadClaudeSettings, setupApiKey } from '../../config/api-config.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import {
  mapModelIdToSdkName,
  resolveModelFromSettings,
  setModelEnvironmentVariables
} from '../../utils/model-utils.js';
import { AsyncStream } from '../../utils/async-stream.js';
import { canUseTool, requestPlanApproval } from '../../permission-handler.js';
import { buildContentBlocks, loadAttachments } from './attachment-service.js';
import { buildIDEContextPrompt } from '../system-prompts.js';
import { buildQuickFixPrompt } from '../quickfix-prompts.js';
import { emitAccumulatedUsage, mergeUsage } from '../../utils/usage-utils.js';
import { registerActiveQueryResult, removeSession } from './message-service.js';

const runtimesBySessionId = new Map();
const anonymousRuntimes = new Set();
const anonymousRuntimesBySignature = new Map();

let cachedQueryFn = null;

// Tracks the runtime currently executing a turn (for abort support)
let activeTurnRuntime = null;

const ACCEPT_EDITS_AUTO_APPROVE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'CreateDirectory',
  'MoveFile',
  'CopyFile',
  'Rename'
]);

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'TodoWrite', 'Skill', 'TaskOutput',
  'Task',
  'Write',
  'Edit',
  'Bash',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
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

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);

const MAX_TOOL_RESULT_CONTENT_CHARS = 20000;
const ERROR_CONTENT_PREFIXES = ['API Error', 'API error', 'Error:', 'Error '];

function truncateString(str, maxLen = 1000) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `... [truncated, total ${str.length} chars]`;
}

function truncateErrorContent(content, maxLen = 1000) {
  if (!content || content.length <= maxLen) return content;
  const isError = ERROR_CONTENT_PREFIXES.some(prefix => content.startsWith(prefix));
  if (!isError) return content;
  return content.substring(0, maxLen) + `... [truncated, total ${content.length} chars]`;
}

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

function emitUsageTag(msg) {
  if (msg.type === 'assistant' && msg.message?.usage) {
    const {
      input_tokens = 0,
      output_tokens = 0,
      cache_creation_input_tokens = 0,
      cache_read_input_tokens = 0
    } = msg.message.usage;
    console.log('[USAGE]', JSON.stringify({
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens
    }));
  }
}

function shouldAutoApproveTool(permissionMode, toolName) {
  if (!toolName) return false;
  if (INTERACTIVE_TOOLS.has(toolName)) return false;
  if (permissionMode === 'bypassPermissions') return true;
  if (permissionMode === 'acceptEdits') return ACCEPT_EDITS_AUTO_APPROVE_TOOLS.has(toolName);
  return false;
}

function createPreToolUseHook(permissionModeState) {
  const readPermissionMode = () => {
    // Daemon runtimes are reused across turns. Keep hook mode in sync with
    // runtime dynamic controls instead of capturing a stale value at creation time.
    if (permissionModeState && typeof permissionModeState === 'object') {
      const normalized = normalizePermissionMode(permissionModeState.value);
      if (permissionModeState.value !== normalized) {
        permissionModeState.value = normalized;
      }
      return normalized;
    }
    return normalizePermissionMode(permissionModeState);
  };

  return async (input) => {
    let currentPermissionMode = readPermissionMode();
    const toolName = input?.tool_name;

    if (currentPermissionMode === 'plan') {
      if (toolName === 'AskUserQuestion') {
        return { decision: 'approve' };
      }

      if (toolName === 'Edit' || toolName === 'Bash') {
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
          return {
            decision: 'block',
            reason: 'Permission check failed: ' + (error?.message || String(error))
          };
        }
      }

      if (toolName === 'ExitPlanMode') {
        try {
          const result = await requestPlanApproval(input?.tool_input);
          if (result?.approved) {
            const nextMode = result.targetMode || 'default';
            currentPermissionMode = nextMode;
            if (permissionModeState && typeof permissionModeState === 'object') {
              permissionModeState.value = nextMode;
            }
            return {
              decision: 'approve',
              updatedInput: {
                ...input.tool_input,
                approved: true,
                targetMode: nextMode
              }
            };
          }
          return {
            decision: 'block',
            reason: result?.message || 'Plan was rejected by user'
          };
        } catch (error) {
          return {
            decision: 'block',
            reason: 'Plan approval failed: ' + (error?.message || String(error))
          };
        }
      }

      if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
        return { decision: 'approve' };
      }

      if (toolName?.startsWith('mcp__') && !toolName.includes('Write') && !toolName.includes('Edit')) {
        return { decision: 'approve' };
      }

      return {
        decision: 'block',
        reason: `Tool "${toolName}" is not allowed in plan mode. Only read-only tools are permitted.`
      };
    }

    if (toolName === 'AskUserQuestion') {
      return { decision: 'approve' };
    }

    if (shouldAutoApproveTool(currentPermissionMode, toolName)) {
      return { decision: 'approve' };
    }

    try {
      const result = await canUseTool(toolName, input?.tool_input);
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
      return {
        decision: 'block',
        reason: 'Permission check failed: ' + (error?.message || String(error))
      };
    }
  };
}

const VALID_PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

function normalizePermissionMode(permissionMode) {
  if (!permissionMode || permissionMode === '') return 'default';
  if (VALID_PERMISSION_MODES.has(permissionMode)) return permissionMode;
  console.warn('[DAEMON] Unknown permission mode, falling back to default:', permissionMode);
  return 'default';
}

function buildRuntimeSignature(options, systemPromptAppend, streamingEnabled) {
  const material = {
    cwd: options.cwd || '',
    additionalDirectories: options.additionalDirectories || [],
    systemPromptAppend: systemPromptAppend || '',
    streamingEnabled: !!streamingEnabled
  };
  return JSON.stringify(material);
}

async function ensureQueryFn() {
  if (cachedQueryFn) return cachedQueryFn;
  const sdk = await loadClaudeSdk();
  const queryFn = sdk?.query;
  if (typeof queryFn !== 'function') {
    throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
  }
  cachedQueryFn = queryFn;
  return cachedQueryFn;
}

function resolveThinkingTokens(params, settings) {
  const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
  const configuredMax = settings?.maxThinkingTokens
    || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
    || 10000;

  if (params.disableThinking === true) return 0;
  if (alwaysThinkingEnabled) return configuredMax;
  return undefined;
}

function resolveStreamingEnabled(params, settings) {
  return params.streaming != null
    ? !!params.streaming
    : (settings?.streamingEnabled ?? false);
}

function buildSystemPromptAppend(params) {
  const openedFiles = params.openedFiles || null;
  const agentPrompt = params.agentPrompt || null;
  if (openedFiles && openedFiles.isQuickFix) {
    return buildQuickFixPrompt(openedFiles, params.message || '');
  }
  return buildIDEContextPrompt(openedFiles, agentPrompt);
}

function buildQueryOptions(workingDirectory, sdkModelName, permissionMode, maxThinkingTokens, streamingEnabled, systemPromptAppend, requestedSessionId) {
  return {
    cwd: workingDirectory,
    permissionMode,
    model: sdkModelName,
    maxTurns: 100,
    enableFileCheckpointing: true,
    ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
    ...(streamingEnabled && { includePartialMessages: true }),
    additionalDirectories: Array.from(
      new Set(
        [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
      )
    ),
    canUseTool,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(systemPromptAppend && { append: systemPromptAppend })
    },
    ...(requestedSessionId && { resume: requestedSessionId })
  };
}

async function buildUserMessage(params, withAttachments, requestedSessionId) {
  if (withAttachments) {
    const attachments = await loadAttachments({ attachments: params.attachments || [] });
    const contentBlocks = buildContentBlocks(attachments, params.message || '');
    return {
      type: 'user',
      session_id: requestedSessionId || '',
      parent_tool_use_id: null,
      message: { role: 'user', content: contentBlocks }
    };
  }

  const userText = (params.message || '').trim() || '[Empty message]';
  return {
    type: 'user',
    session_id: requestedSessionId || '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: userText }] }
  };
}

async function buildRequestContext(params, withAttachments) {
  process.env.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT || 'sdk-ts';
  setupApiKey();

  const baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_URL || '';
  if (isCustomBaseUrl(baseUrl)) {
    console.log('[DEBUG] Custom Base URL detected:', baseUrl);
  }

  const requestedSessionId = (typeof params.sessionId === 'string' && params.sessionId.trim() !== '')
    ? params.sessionId.trim()
    : null;

  const workingDirectory = selectWorkingDirectory(params.cwd || null);
  try {
    process.chdir(workingDirectory);
  } catch (error) {
    console.error('[WARNING] Failed to change process.cwd():', error.message);
  }

  const settings = loadClaudeSettings();
  const modelId = params.model || null;
  const sdkModelName = mapModelIdToSdkName(modelId);
  const resolvedModel = resolveModelFromSettings(modelId, settings?.env);
  setModelEnvironmentVariables(resolvedModel, modelId);

  const permissionMode = normalizePermissionMode(params.permissionMode);
  const streamingEnabled = resolveStreamingEnabled(params, settings);
  const maxThinkingTokens = resolveThinkingTokens(params, settings);
  const systemPromptAppend = buildSystemPromptAppend(params);

  const options = buildQueryOptions(
    workingDirectory, sdkModelName, permissionMode,
    maxThinkingTokens, streamingEnabled, systemPromptAppend, requestedSessionId
  );

  const userMessage = await buildUserMessage(params, withAttachments, requestedSessionId);

  return {
    requestedSessionId,
    streamingEnabled,
    options,
    userMessage,
    sdkModelName,
    permissionMode,
    maxThinkingTokens,
    runtimeSignature: buildRuntimeSignature(options, systemPromptAppend, streamingEnabled)
  };
}

function registerRuntimeSession(runtime, sessionId) {
  if (!sessionId) return;
  for (const [signature, item] of anonymousRuntimesBySignature.entries()) {
    if (item === runtime) {
      anonymousRuntimesBySignature.delete(signature);
    }
  }
  for (const [existingSessionId, existingRuntime] of runtimesBySessionId.entries()) {
    if (existingRuntime === runtime && existingSessionId !== sessionId) {
      runtimesBySessionId.delete(existingSessionId);
      removeSession(existingSessionId);
    }
  }
  runtime.sessionId = sessionId;
  runtimesBySessionId.set(sessionId, runtime);
  anonymousRuntimes.delete(runtime);
  registerActiveQueryResult(sessionId, runtime.query);
}

async function disposeRuntime(runtime) {
  if (!runtime || runtime.closed) return;
  runtime.closed = true;

  try {
    runtime.inputStream.done();
  } catch (_) {
  }
  try {
    runtime.query?.close?.();
  } catch (_) {
  }

  anonymousRuntimes.delete(runtime);
  for (const [signature, item] of anonymousRuntimesBySignature.entries()) {
    if (item === runtime) {
      anonymousRuntimesBySignature.delete(signature);
    }
  }
  for (const [sessionId, item] of runtimesBySessionId.entries()) {
    if (item === runtime) {
      runtimesBySessionId.delete(sessionId);
      removeSession(sessionId);
    }
  }
}

async function createRuntime(requestContext) {
  const queryFn = await ensureQueryFn();
  const initialPermissionMode = normalizePermissionMode(requestContext.permissionMode);

  const runtime = {
    closed: false,
    sessionId: requestContext.requestedSessionId || null,
    runtimeSignature: requestContext.runtimeSignature,
    currentModel: requestContext.sdkModelName || null,
    currentPermissionMode: initialPermissionMode,
    permissionModeState: { value: initialPermissionMode },
    currentMaxThinkingTokens: requestContext.maxThinkingTokens ?? null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    stderrLines: [],
    query: null,
    inputStream: new AsyncStream()
  };

  const options = {
    ...requestContext.options,
    stderr: (data) => {
      try {
        const text = (data ?? '').toString().trim();
        if (!text) return;
        runtime.stderrLines.push(text);
        if (runtime.stderrLines.length > 200) {
          runtime.stderrLines.shift();
        }
        console.error(`[SDK-STDERR] ${text}`);
      } catch (_) {
      }
    }
  };
  options.hooks = {
    ...(options.hooks || {}),
    PreToolUse: [{
      hooks: [createPreToolUseHook(runtime.permissionModeState)]
    }]
  };

  runtime.query = queryFn({
    prompt: runtime.inputStream,
    options
  });

  if (requestContext.requestedSessionId) {
    runtimesBySessionId.set(requestContext.requestedSessionId, runtime);
    registerActiveQueryResult(requestContext.requestedSessionId, runtime.query);
  } else {
    anonymousRuntimes.add(runtime);
    anonymousRuntimesBySignature.set(requestContext.runtimeSignature, runtime);
  }

  return runtime;
}

async function applyDynamicControls(runtime, requestContext) {
  if (!runtime || runtime.closed) return;

  const targetPermissionMode = normalizePermissionMode(requestContext.permissionMode);
  if (runtime.currentPermissionMode !== targetPermissionMode) {
    if (typeof runtime.query?.setPermissionMode === 'function') {
      try {
        await runtime.query.setPermissionMode(targetPermissionMode);
      } catch (error) {
        console.error('[DAEMON] setPermissionMode failed:', error.message);
      }
    }
    runtime.currentPermissionMode = targetPermissionMode;
    if (runtime.permissionModeState) {
      runtime.permissionModeState.value = targetPermissionMode;
    }
  }

  const targetModel = requestContext.sdkModelName || null;
  if (runtime.currentModel !== targetModel && typeof runtime.query?.setModel === 'function') {
    try {
      await runtime.query.setModel(targetModel || undefined);
      runtime.currentModel = targetModel;
    } catch (error) {
      console.error('[DAEMON] setModel failed:', error.message);
    }
  }

  const targetThinking = requestContext.maxThinkingTokens ?? null;
  if (runtime.currentMaxThinkingTokens !== targetThinking && typeof runtime.query?.setMaxThinkingTokens === 'function') {
    try {
      await runtime.query.setMaxThinkingTokens(targetThinking);
      runtime.currentMaxThinkingTokens = targetThinking;
    } catch (error) {
      console.error('[DAEMON] setMaxThinkingTokens failed:', error.message);
    }
  }
}

const ANONYMOUS_RUNTIME_MAX_IDLE_MS = 10 * 60 * 1000; // 10 minutes

async function cleanupStaleAnonymousRuntimes() {
  const now = Date.now();
  for (const runtime of anonymousRuntimes) {
    if (runtime.closed) {
      anonymousRuntimes.delete(runtime);
      continue;
    }
    if (now - runtime.lastUsedAt > ANONYMOUS_RUNTIME_MAX_IDLE_MS) {
      console.log(`[DAEMON] Disposing stale anonymous runtime (idle ${Math.round((now - runtime.lastUsedAt) / 1000)}s)`);
      await disposeRuntime(runtime);
    }
  }
}

async function acquireRuntime(requestContext) {
  // Periodically clean up idle anonymous runtimes to prevent memory leaks
  await cleanupStaleAnonymousRuntimes();

  let runtime = null;
  if (requestContext.requestedSessionId) {
    runtime = runtimesBySessionId.get(requestContext.requestedSessionId) || null;
  } else {
    runtime = anonymousRuntimesBySignature.get(requestContext.runtimeSignature) || null;
  }

  if (runtime && runtime.runtimeSignature !== requestContext.runtimeSignature) {
    await disposeRuntime(runtime);
    runtime = null;
  }

  if (!runtime) {
    runtime = await createRuntime(requestContext);
  }

  await applyDynamicControls(runtime, requestContext);
  runtime.lastUsedAt = Date.now();
  return runtime;
}

function processStreamEvent(msg, turnState) {
  const event = msg.event;
  if (!event) return;

  // Handle message_start: reset per-turn accumulator (matches CLI behavior)
  if (event.type === 'message_start' && event.message?.usage) {
    turnState.accumulatedUsage = mergeUsage(null, event.message.usage);
  }

  // Handle message_delta: accumulate output_tokens and emit [USAGE] tag
  if (event.type === 'message_delta' && event.usage) {
    turnState.accumulatedUsage = mergeUsage(turnState.accumulatedUsage, event.usage);
    emitAccumulatedUsage(turnState.accumulatedUsage);
  }

  // Handle content_block_delta: text and thinking deltas
  if (event.type === 'content_block_delta' && event.delta) {
    if (event.delta.type === 'text_delta' && event.delta.text) {
      process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(event.delta.text)}\n`);
      turnState.lastAssistantContent += event.delta.text;
    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
      process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(event.delta.thinking)}\n`);
      turnState.lastThinkingContent += event.delta.thinking;
    }
  }
}

function processMessageContent(msg, turnState) {
  if (msg.type !== 'assistant') return;
  const content = msg.message?.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        const currentText = block.text || '';
        if (turnState.streamingEnabled && !turnState.hasStreamEvents && currentText.length > turnState.lastAssistantContent.length) {
          const delta = currentText.substring(turnState.lastAssistantContent.length);
          if (delta) {
            process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
          }
          turnState.lastAssistantContent = currentText;
        } else if (turnState.streamingEnabled && turnState.hasStreamEvents) {
          if (currentText.length > turnState.lastAssistantContent.length) {
            turnState.lastAssistantContent = currentText;
          }
        } else if (!turnState.streamingEnabled) {
          console.log('[CONTENT]', truncateErrorContent(currentText));
        }
      } else if (block.type === 'thinking') {
        const thinkingText = block.thinking || block.text || '';
        if (turnState.streamingEnabled && !turnState.hasStreamEvents && thinkingText.length > turnState.lastThinkingContent.length) {
          const delta = thinkingText.substring(turnState.lastThinkingContent.length);
          if (delta) {
            process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
          }
          turnState.lastThinkingContent = thinkingText;
        } else if (turnState.streamingEnabled && turnState.hasStreamEvents) {
          if (thinkingText.length > turnState.lastThinkingContent.length) {
            turnState.lastThinkingContent = thinkingText;
          }
        } else if (!turnState.streamingEnabled) {
          console.log('[THINKING]', thinkingText);
        }
      }
    }
  } else if (typeof content === 'string') {
    if (turnState.streamingEnabled && !turnState.hasStreamEvents && content.length > turnState.lastAssistantContent.length) {
      const delta = content.substring(turnState.lastAssistantContent.length);
      if (delta) {
        process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
      }
      turnState.lastAssistantContent = content;
    } else if (turnState.streamingEnabled && turnState.hasStreamEvents) {
      if (content.length > turnState.lastAssistantContent.length) {
        turnState.lastAssistantContent = content;
      }
    } else if (!turnState.streamingEnabled) {
      console.log('[CONTENT]', truncateErrorContent(content));
    }
  }
}

function processToolResultMessages(msg) {
  if (msg.type !== 'user') return;
  const content = msg.message?.content ?? msg.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'tool_result') {
      console.log('[TOOL_RESULT]', JSON.stringify(truncateToolResultBlock(block)));
    }
  }
}

function shouldOutputMessage(msg, turnState) {
  if (!(turnState.streamingEnabled && msg.type === 'assistant')) {
    return true;
  }
  const msgContent = msg.message?.content;
  const hasToolUse = Array.isArray(msgContent) && msgContent.some(block => block.type === 'tool_use');
  return !!hasToolUse;
}

async function executeTurn(runtime, requestContext, turnMeta) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  activeTurnRuntime = runtime;

  const turnState = {
    streamingEnabled: requestContext.streamingEnabled,
    streamStarted: false,
    streamEnded: false,
    hasStreamEvents: false,
    lastAssistantContent: '',
    lastThinkingContent: '',
    finalSessionId: requestContext.requestedSessionId || runtime.sessionId || '',
    accumulatedUsage: null
  };
  if (turnMeta) {
    turnMeta.state = turnState;
  }

  console.log('[MESSAGE_START]');
  runtime.inputStream.enqueue(requestContext.userMessage);

  while (true) {
    let next;
    try {
      next = await runtime.query.next();
    } catch (error) {
      const wrapped = new Error(error?.message || String(error));
      wrapped.runtimeTerminated = true;
      throw wrapped;
    }

    if (next.done) {
      const err = new Error('Claude session stream ended unexpectedly');
      err.runtimeTerminated = true;
      throw err;
    }

    const msg = next.value;

    if (turnState.streamingEnabled && !turnState.streamStarted) {
      process.stdout.write('[STREAM_START]\n');
      turnState.streamStarted = true;
    }

    if (msg?.type === 'stream_event' && turnState.streamingEnabled) {
      turnState.hasStreamEvents = true;
      processStreamEvent(msg, turnState);
      continue;
    }

    if (shouldOutputMessage(msg, turnState)) {
      console.log('[MESSAGE]', JSON.stringify(msg));
    }

    processMessageContent(msg, turnState);
    emitUsageTag(msg);
    processToolResultMessages(msg);

    if (msg?.type === 'system' && msg.session_id) {
      turnState.finalSessionId = msg.session_id;
      console.log('[SESSION_ID]', msg.session_id);
      registerRuntimeSession(runtime, msg.session_id);
    }

    if (msg?.type === 'result') {
      if (msg.is_error) {
        throw new Error(msg.result || msg.message || 'API request failed');
      }
      break;
    }
  }

  if (turnState.streamingEnabled && turnState.streamStarted && !turnState.streamEnded) {
    // Emit final accumulated usage before stream end
    if (turnState.accumulatedUsage) {
      emitAccumulatedUsage(turnState.accumulatedUsage);
    }
    process.stdout.write('[STREAM_END]\n');
    turnState.streamEnded = true;
  }

  // Only clear if this runtime still owns the pointer (not cleared by abort)
  if (activeTurnRuntime === runtime) {
    activeTurnRuntime = null;
  }

  const finalSessionId = turnState.finalSessionId || runtime.sessionId || requestContext.requestedSessionId || '';
  if (finalSessionId) {
    registerRuntimeSession(runtime, finalSessionId);
  }

  console.log('[MESSAGE_END]');
  console.log(JSON.stringify({
    success: true,
    sessionId: finalSessionId
  }));
}

function emitSendError(runtime, error, requestContext) {
  const payload = {
    success: false,
    error: error?.message || String(error),
    details: {}
  };

  if (error?.code) payload.details.code = error.code;
  if (error?.stack) payload.details.stack = truncateString(error.stack, 2000);

  if (runtime?.stderrLines?.length) {
    const sdkErrorText = runtime.stderrLines.slice(-10).join('\n');
    payload.error = `SDK-STDERR:\n\`\`\`\n${sdkErrorText}\n\`\`\`\n\n${payload.error}`;
    payload.details.sdkError = sdkErrorText;
  }

  payload.error = truncateString(payload.error, 2500);

  console.error('[SEND_ERROR]', JSON.stringify(payload));
  console.log('[SEND_ERROR]', JSON.stringify(payload));
  console.log(JSON.stringify(payload));
}

async function sendInternal(params, withAttachments) {
  const safeParams = params || {};
  const turnMeta = { state: null };
  let runtime = null;
  let requestContext = null;
  try {
    requestContext = await buildRequestContext(safeParams, withAttachments);
    runtime = await acquireRuntime(requestContext);
    await executeTurn(runtime, requestContext, turnMeta);
  } catch (error) {
    // Only clear if this runtime still owns the pointer (not cleared by abort)
    if (activeTurnRuntime === runtime) {
      activeTurnRuntime = null;
    }
    if (turnMeta.state?.streamingEnabled && turnMeta.state?.streamStarted && !turnMeta.state?.streamEnded) {
      // Emit final accumulated usage before stream end
      if (turnMeta.state?.accumulatedUsage) {
        emitAccumulatedUsage(turnMeta.state.accumulatedUsage);
      }
      process.stdout.write('[STREAM_END]\n');
      turnMeta.state.streamEnded = true;
    }
    emitSendError(runtime, error, requestContext);
    // Only dispose if not already disposed by abort
    if (runtime && !runtime.closed && error?.runtimeTerminated) {
      await disposeRuntime(runtime);
    }
  }
}

export async function sendMessagePersistent(params = {}) {
  await sendInternal(params, false);
}

export async function sendMessageWithAttachmentsPersistent(params = {}) {
  await sendInternal(params, true);
}

export async function preconnectPersistent(params = {}) {
  const safeParams = params || {};
  const requestContext = await buildRequestContext(safeParams, false);
  await acquireRuntime(requestContext);
}

export async function abortCurrentTurn() {
  // Atomic swap: clear first to prevent double-disposal from rapid abort calls.
  // JS is single-threaded so assignment is atomic — only the first caller gets
  // a non-null runtime, subsequent callers see null and exit early.
  const runtime = activeTurnRuntime;
  if (!runtime) return;
  activeTurnRuntime = null;

  try {
    if (!runtime.closed) {
      await disposeRuntime(runtime);
    }
  } catch (error) {
    // Best-effort — log but don't throw so abort always "succeeds"
    console.error('[ABORT] Failed to dispose runtime:', error.message);
  }
}

export async function shutdownPersistentRuntimes() {
  const all = new Set([
    ...anonymousRuntimes,
    ...runtimesBySessionId.values()
  ]);
  for (const runtime of all) {
    await disposeRuntime(runtime);
  }
  anonymousRuntimes.clear();
  anonymousRuntimesBySignature.clear();
  runtimesBySessionId.clear();
  cachedQueryFn = null;
}
