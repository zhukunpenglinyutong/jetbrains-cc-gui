/**
 * Persistent query service for daemon mode.
 * Keeps Claude Query processes alive across turns to reduce per-request latency.
 */

import { isCustomBaseUrl, loadClaudeSettings, setupApiKey, buildCliEnv } from '../../config/api-config.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import {
  mapModelIdToSdkName,
  resolveModelFromSettings,
  setModelEnvironmentVariables
} from '../../utils/model-utils.js';
import { canUseTool } from '../../permission-handler.js';
import { buildContentBlocks, loadAttachments } from './attachment-service.js';
import { buildIDEContextPrompt } from '../system-prompts.js';
import { buildQuickFixPrompt } from '../quickfix-prompts.js';
import { registerActiveQueryResult, removeSession } from './message-service.js';
import { normalizePermissionMode } from './permission-mode.js';
import { truncateString } from './message-output-filter.js';
import {
  beginRuntimeTurn,
  cleanupStaleAnonymousRuntimes,
  cleanupStaleSessionRuntimes,
  disposeRuntime,
  registerRuntimeSession,
  acquireRuntime,
  buildRuntimeSignature,
  endRuntimeTurn,
  resetCachedQueryFn,
  setCachedQueryFn,
  touchRuntime,
} from './runtime-lifecycle.js';
import {
  SESSION_CLEANUP_INTERVAL_MS,
  clearActiveTurnRuntime,
  clearActiveTurnRuntimeIf,
  getActiveTurnRuntime,
  getAllRuntimes,
  getRuntimeForSession,
  getSnapshot,
  resetRegistryState,
  setActiveTurnRuntime,
} from './runtime-registry.js';
import {
  createTurnState,
  emitUsageTag,
  processMessageContent,
  processStreamEvent,
  processToolResultMessages,
  shouldOutputMessage,
} from './stream-event-processor.js';

const SUPPORTED_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function resolveReasoningEffort(params) {
  const effort = typeof params.reasoningEffort === 'string'
    ? params.reasoningEffort.trim()
    : '';
  return SUPPORTED_EFFORT_LEVELS.has(effort) ? effort : undefined;
}

function resolveThinkingTokens(params, settings) {
  if (resolveReasoningEffort(params)) return undefined;

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

function buildQueryOptions(workingDirectory, sdkModelName, permissionMode, maxThinkingTokens, reasoningEffort, streamingEnabled, systemPromptAppend, requestedSessionId) {
  return {
    cwd: workingDirectory,
    permissionMode,
    model: sdkModelName,
    maxTurns: 100,
    enableFileCheckpointing: true,
    env: buildCliEnv(),
    ...(reasoningEffort && { effort: reasoningEffort }),
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
  setupApiKey();

  const baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_URL || '';
  if (isCustomBaseUrl(baseUrl)) {
    console.debug('[DEBUG] Custom Base URL detected');
  }

  const requestedSessionId = (typeof params.sessionId === 'string' && params.sessionId.trim() !== '')
    ? params.sessionId.trim()
    : null;
  const runtimeSessionEpoch = (typeof params.runtimeSessionEpoch === 'string' && params.runtimeSessionEpoch.trim() !== '')
    ? params.runtimeSessionEpoch.trim()
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
  const reasoningEffort = resolveReasoningEffort(params);
  const maxThinkingTokens = resolveThinkingTokens(params, settings);
  const systemPromptAppend = buildSystemPromptAppend(params);

  const options = buildQueryOptions(
    workingDirectory, sdkModelName, permissionMode,
    maxThinkingTokens, reasoningEffort, streamingEnabled, systemPromptAppend, requestedSessionId
  );

  const userMessage = await buildUserMessage(params, withAttachments, requestedSessionId);

  const runtimeSignature = buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch);
  console.log('[LIFECYCLE] buildRequestContext sessionId=' + (requestedSessionId || '(new)')
    + ' epoch=' + (runtimeSessionEpoch || '(none)')
    + ' signature=' + runtimeSignature);

  return {
    requestedSessionId,
    runtimeSessionEpoch,
    streamingEnabled,
    options,
    userMessage,
    sdkModelName,
    permissionMode,
    maxThinkingTokens,
    reasoningEffort,
    runtimeSignature
  };
}

// Background cleanup of idle session runtimes, decoupled from the request hot path.
// Runs every 5 minutes instead of on every acquireRuntime call to avoid O(n) scans.
const _sessionCleanupTimer = setInterval(async () => {
  await cleanupStaleSessionRuntimes({ registerActiveQueryResult, removeSession });
}, SESSION_CLEANUP_INTERVAL_MS);
// unref() so the timer does not prevent natural process exit
_sessionCleanupTimer.unref();

async function executeTurn(runtime, requestContext, turnMeta) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  setActiveTurnRuntime(runtime);
  console.log('[LIFECYCLE] executeTurn sessionId=' + (requestContext.requestedSessionId || runtime.sessionId || '(new)')
    + ' epoch=' + (requestContext.runtimeSessionEpoch || runtime.runtimeSessionEpoch || '(none)'));

  const turnState = createTurnState(requestContext, runtime);
  if (turnMeta) {
    turnMeta.state = turnState;
  }

  try {
    beginRuntimeTurn(runtime);
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

      touchRuntime(runtime);
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
      // Emit usage tag for assistant messages.
      // IMPORTANT: This is the authoritative source for token usage, NOT the accumulatedUsage.
      // The assistant message's usage field contains the correct cumulative total.
      // In streaming mode, this overwrites any intermediate [USAGE] values sent during streaming.
      // The Java backend (ClaudeMessageHandler.handleAssistantMessage) relies on this for correct totals.
      emitUsageTag(msg);
      processToolResultMessages(msg);

      if (msg?.type === 'system' && msg.session_id) {
        turnState.finalSessionId = msg.session_id;
        console.log('[SESSION_ID]', msg.session_id);
        registerRuntimeSession(runtime, msg.session_id, { registerActiveQueryResult, removeSession });
      }

      if (msg?.type === 'result') {
        if (msg.is_error) {
          throw new Error(msg.result || msg.message || 'API request failed');
        }
        break;
      }
    }

    if (turnState.streamingEnabled && turnState.streamStarted && !turnState.streamEnded) {
      // NOTE: Do NOT emit accumulatedUsage at stream end.
      // The assistant message's usage (sent via emitUsageTag above) is the authoritative final value.
      // Emitting accumulatedUsage here would send a redundant or potentially stale value.
      process.stdout.write('[STREAM_END]\n');
      turnState.streamEnded = true;
    }

    const finalSessionId = turnState.finalSessionId || runtime.sessionId || requestContext.requestedSessionId || '';
    if (finalSessionId) {
      registerRuntimeSession(runtime, finalSessionId, { registerActiveQueryResult, removeSession });
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      sessionId: finalSessionId
    }));
  } finally {
    endRuntimeTurn(runtime);
    // Only clear if this runtime still owns the pointer (not cleared by abort)
    clearActiveTurnRuntimeIf(runtime);
  }
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
    runtime = await acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
    await executeTurn(runtime, requestContext, turnMeta);
  } catch (error) {
    // Only clear if this runtime still owns the pointer (not cleared by abort)
    clearActiveTurnRuntimeIf(runtime);
    if (turnMeta.state?.streamingEnabled && turnMeta.state?.streamStarted && !turnMeta.state?.streamEnded) {
      // NOTE: Do NOT emit accumulatedUsage at stream end, even on error.
      // If an assistant message was received, emitUsageTag already sent the correct usage.
      // If no assistant message was received, the usage would be incomplete anyway.
      process.stdout.write('[STREAM_END]\n');
      turnMeta.state.streamEnded = true;
    }
    emitSendError(runtime, error, requestContext);
    // Only dispose if not already disposed by abort
    if (runtime && !runtime.closed && error?.runtimeTerminated) {
      await disposeRuntime(runtime, { removeSession });
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
  console.log('[LIFECYCLE] preconnectPersistent epoch=' + (requestContext.runtimeSessionEpoch || '(none)'));
  await acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
}

export async function resetRuntimePersistent(params = {}) {
  const runtimeSessionEpoch = typeof params === 'string'
    ? params
    : (params?.runtimeSessionEpoch || null);

  console.log('[LIFECYCLE] resetRuntimePersistent targetEpoch=' + (runtimeSessionEpoch || '(all-runtimes)'));

  const runtimes = getAllRuntimes();

  for (const runtime of runtimes) {
    if (!runtimeSessionEpoch || runtime.runtimeSessionEpoch === runtimeSessionEpoch) {
      await disposeRuntime(runtime, { removeSession });
    }
  }
}

export async function abortCurrentTurn() {
  // Atomic swap: clear first to prevent double-disposal from rapid abort calls.
  // JS is single-threaded so assignment is atomic — only the first caller gets
  // a non-null runtime, subsequent callers see null and exit early.
  const runtime = getActiveTurnRuntime();
  if (!runtime) return;
  console.log('[LIFECYCLE] abortCurrentTurn epoch=' + (runtime.runtimeSessionEpoch || '(none)'));
  clearActiveTurnRuntime();

  try {
    if (!runtime.closed) {
      await disposeRuntime(runtime, { removeSession });
    }
  } catch (error) {
    // Best-effort — log but don't throw so abort always "succeeds"
    console.error('[ABORT] Failed to dispose runtime:', error.message);
  }
}

export async function shutdownPersistentRuntimes() {
  const all = getAllRuntimes();
  for (const runtime of all) {
    await disposeRuntime(runtime, { removeSession });
  }
  resetRegistryState();
  resetCachedQueryFn();
}

export const __testing = {
  async resetState() {
    await shutdownPersistentRuntimes();
    clearActiveTurnRuntime();
  },
  setQueryFn(queryFn) {
    setCachedQueryFn(queryFn);
  },
  async buildRequestContext(params = {}, withAttachments = false) {
    return buildRequestContext(params, withAttachments);
  },
  async acquireRuntime(requestContext) {
    return acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
  },
  async executeTurn(runtime, requestContext, turnMeta = null) {
    return executeTurn(runtime, requestContext, turnMeta);
  },
  async cleanupAnonymousRuntimes() {
    return cleanupStaleAnonymousRuntimes({ registerActiveQueryResult, removeSession });
  },
  async cleanupSessionRuntimes() {
    return cleanupStaleSessionRuntimes({ registerActiveQueryResult, removeSession });
  },
  async resetRuntimePersistent(params = {}) {
    return resetRuntimePersistent(params);
  },
  async abortCurrentTurn() {
    return abortCurrentTurn();
  },
  setActiveTurnRuntime(runtime) {
    setActiveTurnRuntime(runtime);
  },
  getRuntimeForSession(sessionId) {
    return getRuntimeForSession(sessionId);
  },
  getSnapshot() {
    return getSnapshot();
  }
};
