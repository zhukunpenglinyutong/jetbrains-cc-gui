/**
 * Codex event processing loop and helper functions.
 *
 * Extracted from the inner closures and for-await loop of sendMessage()
 * in message-service.js. Every former closure now receives its captured
 * variables through an explicit `state` (mutable) or `config` (immutable)
 * parameter.
 *
 * Exports:
 *   - createInitialEventState(emitMessage) — factory for the mutable state bag
 *   - processCodexEventStream(events, state, config) — the main event loop
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { requestPermissionFromJava } from '../../permission-handler.js';
import { findSessionFileByThreadId } from './codex-agents-loader.js';
import {
  truncateForDisplay, getStableItemId, extractCommand,
  smartToolName, smartDescription, mapCommandToolNameToPermissionToolName,
  stringifyRawEvent, isApprovalRelatedRawEvent
} from './codex-command-utils.js';
import {
  DEBUG_LEVEL, MAX_TOOL_RESULT_CHARS,
  SESSION_PATCH_SCAN_MAX_LINES, SESSION_CONTEXT_SCAN_MAX_LINES,
  logWarn, logInfo, logDebug,
  isAutoEditPermissionMode, isReconnectNotice, emitStatusMessage
} from './codex-utils.js';
import {
  normalizeMcpToolName, normalizeMcpToolInput,
  parseFunctionCallArguments, normalizeFunctionCallTool,
  rememberToolInvocation, buildToolInvocationSignature,
} from './codex-tool-normalization.js';
import {
  captureTurnWorkspaceSnapshot,
  collectPatchOperationsFromSession,
  emitSyntheticPatchOperations,
  emitTurnWorkspaceDiff,
  findUniqueRollbackIndex,
  requestPatchApprovalsViaBridge,
  rollbackDeniedPatchBatches,
} from './codex-event-patch-tracking.js';

export { emitSyntheticPatchOperations, findUniqueRollbackIndex };

const COMMAND_DENIED_ABORT_ERROR = '__CODEX_COMMAND_DENIED_ABORT__';

const LIFECYCLE_TOOL_NAMES = new Set(['spawn_agent', 'wait_agent', 'close_agent', 'send_input', 'resume_agent']);

function isLifecycleTool(toolName) {
  return typeof toolName === 'string' && LIFECYCLE_TOOL_NAMES.has(toolName);
}

function nextLifecycleToolUseId(state, toolName, stableHint = '') {
  state.lifecycleToolSequence = (state.lifecycleToolSequence || 0) + 1;
  const prefix = state.eventStateId || 'state';
  const suffix = stableHint ? String(stableHint).replace(/[^a-zA-Z0-9_.:-]/g, '_') : state.lifecycleToolSequence;
  return `codex_lifecycle_${toolName}_${prefix}_${suffix}`;
}

function rememberPendingFunctionCall(state, toolUseId) {
  if (!toolUseId || state.emittedToolResultIds.has(toolUseId)) return;
  if (!Array.isArray(state.pendingFunctionCallToolUseIds)) {
    state.pendingFunctionCallToolUseIds = [];
  }
  if (!state.pendingFunctionCallToolUseIds.includes(toolUseId)) {
    state.pendingFunctionCallToolUseIds.push(toolUseId);
  }
}

function resolveFunctionCallOutputToolUseId(payload, state) {
  const rawCallId = typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : '';
  if (rawCallId) return rawCallId;
  const rawPayloadId = typeof payload.id === 'string' && payload.id ? payload.id : '';
  if (rawPayloadId && state.emittedToolUseIds.has(rawPayloadId)) {
    return state.emittedToolResultIds.has(rawPayloadId) ? '' : rawPayloadId;
  }

  const pending = (Array.isArray(state.pendingFunctionCallToolUseIds) ? state.pendingFunctionCallToolUseIds : [])
    .filter((toolUseId) => state.emittedToolUseIds.has(toolUseId) && !state.emittedToolResultIds.has(toolUseId));
  state.pendingFunctionCallToolUseIds = pending;
  return pending.length > 0 ? pending[0] : '';
}

function markFunctionCallOutputCompleted(state, toolUseId) {
  if (!Array.isArray(state.pendingFunctionCallToolUseIds)) return;
  state.pendingFunctionCallToolUseIds = state.pendingFunctionCallToolUseIds.filter((pendingId) => pendingId !== toolUseId);
}

function sanitizeIdPart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function generatedFunctionToolUseId(state, stableHint = '') {
  if (stableHint) {
    return `codex_function_${state.eventStateId || 'state'}_${sanitizeIdPart(stableHint)}`;
  }
  return randomUUID();
}

function rememberPendingMcpToolUseId(state, signature, toolUseId) {
  if (!signature || !toolUseId) return;
  if (!(state.pendingMcpToolUseIdsBySignature instanceof Map)) {
    state.pendingMcpToolUseIdsBySignature = new Map();
  }
  const queue = state.pendingMcpToolUseIdsBySignature.get(signature) ?? [];
  queue.push(toolUseId);
  state.pendingMcpToolUseIdsBySignature.set(signature, queue);
}

function consumePendingMcpToolUseId(state, signature) {
  if (!signature || !(state.pendingMcpToolUseIdsBySignature instanceof Map)) return null;
  const queue = state.pendingMcpToolUseIdsBySignature.get(signature);
  if (!Array.isArray(queue) || queue.length === 0) return null;
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (candidate && state.emittedToolUseIds.has(candidate) && !state.emittedToolResultIds.has(candidate)) {
      if (queue.length === 0) state.pendingMcpToolUseIdsBySignature.delete(signature);
      return candidate;
    }
  }
  state.pendingMcpToolUseIdsBySignature.delete(signature);
  return null;
}

function syntheticPatchSafeToRollback(operation, rollbackResult = null, deniedByUser = false) {
  if (!operation || typeof operation.newString !== 'string' || operation.newString.length === 0) return false;
  if (deniedByUser && rollbackResult?.success === false) return false;
  return true;
}

function toolUseMsg(id, name, input) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResultMsg(toolUseId, isError, content) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }] } };
}

function textMsg(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

export function handleFunctionCallPayload(payload, state, options = {}) {
  if (!payload || payload.type !== 'function_call') return false;

  const rawToolName = typeof payload.name === 'string' ? payload.name : '';
  if (!rawToolName) return false;

  const parsedArguments = parseFunctionCallArguments(payload);
  const normalizedTool = normalizeFunctionCallTool(rawToolName, parsedArguments);
  const toolName = normalizedTool.name;
  const toolInput = normalizedTool.input;
  const rawCallId = typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : null;
  const rawPayloadId = typeof payload.id === 'string' && payload.id ? payload.id : null;
  const stableHint = options.stableHint || rawPayloadId || '';
  const lifecycleTool = isLifecycleTool(toolName);
  const toolUseId = rawCallId || rawPayloadId || (lifecycleTool
    ? nextLifecycleToolUseId(state, toolName, stableHint)
    : generatedFunctionToolUseId(state, stableHint));

  if (!state.emittedToolUseIds.has(toolUseId)) {
    state.emitMessage(toolUseMsg(toolUseId, toolName, toolInput));
    state.emittedToolUseIds.add(toolUseId);
  }
  rememberToolInvocation(state, toolUseId, toolName, toolInput);
  rememberPendingFunctionCall(state, toolUseId);
  return true;
}

export function handleFunctionCallOutputPayload(payload, state) {
  if (!payload || payload.type !== 'function_call_output') return false;
  const toolUseId = resolveFunctionCallOutputToolUseId(payload, state);
  if (!toolUseId || state.emittedToolResultIds.has(toolUseId) || !state.emittedToolUseIds.has(toolUseId)) return false;

  const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '(no output)');
  const isError = payload.status === 'error' ||
    (typeof output === 'string' && /^error:|failed to parse|permission denied|command denied/i.test(output));
  const truncatedResult = truncateForDisplay(output, MAX_TOOL_RESULT_CHARS);
  state.emitMessage(toolResultMsg(toolUseId, isError, truncatedResult && truncatedResult.trim() ? truncatedResult : '(no output)'));
  state.emittedToolResultIds.add(toolUseId);
  markFunctionCallOutputCompleted(state, toolUseId);
  return true;
}


/** Creates the initial mutable state bag consumed by processCodexEventStream. */
export function createInitialEventState(emitMessage) {
  return {
    pendingToolUseIds: new Map(),
    emittedToolUseIds: new Set(),
    emittedToolResultIds: new Set(),
    toolCallSignatureById: new Map(),
    toolUseIdBySignature: new Map(),
    pendingFunctionCallToolUseIds: [],
    pendingMcpToolUseIdsBySignature: new Map(),
    lifecycleToolSequence: 0,
    eventStateId: randomUUID(),
    syntheticEditSequence: 0,
    turnWorkspaceSnapshot: null,
    emittedFileChangePaths: new Set(),
    deniedCommandToolUseIds: new Set(),
    emittedDeniedCommandToolResultIds: new Set(),
    sessionFilePath: null,
    sessionLineCursor: 0,
    sessionFunctionCursor: 0,
    sessionTurnStartCursor: 0,
    processedPatchCallIds: new Set(),
    processedSessionFunctionCallIds: new Set(),
    processedSessionFunctionOutputIds: new Set(),
    reasoningTextCache: new Map(),
    assistantTextCache: new Map(),
    reasoningObserved: false,
    commandApprovalAbortRequested: false,
    runtimePolicyLogged: false,
    suppressNoResponseFallback: false,
    currentThreadId: null,
    finalResponse: '',
    assistantText: '',
    emitMessage
  };
}

function rememberPendingToolUseId(state, command, toolUseId) {
  if (!command) return;
  const list = state.pendingToolUseIds.get(command) ?? [];
  list.push(toolUseId);
  state.pendingToolUseIds.set(command, list);
}

function consumePendingToolUseId(state, command) {
  if (!command) return null;
  const list = state.pendingToolUseIds.get(command);
  if (!Array.isArray(list) || list.length === 0) return null;
  const id = list.shift() ?? null;
  if (list.length === 0) state.pendingToolUseIds.delete(command);
  return id;
}

function ensureToolUseId(state, phase, item) {
  const stableId = getStableItemId(item);
  if (stableId) return stableId;
  const command = extractCommand(item);
  if (phase === 'completed') {
    return consumePendingToolUseId(state, command) ?? randomUUID();
  }
  const id = randomUUID();
  rememberPendingToolUseId(state, command, id);
  return id;
}

function ensureSessionFilePath(state, threadId) {
  if (state.sessionFilePath && existsSync(state.sessionFilePath)) return state.sessionFilePath;
  const effectiveThreadId = threadId || state.currentThreadId;
  if (!effectiveThreadId) return null;
  state.sessionFilePath = findSessionFileByThreadId(effectiveThreadId);
  return state.sessionFilePath;
}

function splitSessionJsonlEntries(content) {
  if (typeof content !== 'string' || !content.length) return [];
  return content.split('\n').filter((line) => line.trim());
}

function countSessionJsonlLines(content) {
  return splitSessionJsonlEntries(content).length;
}

async function readLatestTurnContextFromSession(state, threadId) {
  const sessionPath = ensureSessionFilePath(state, threadId);
  if (!sessionPath) return null;
  let content = '';
  try { content = await readFile(sessionPath, 'utf8'); } catch (error) {
    logDebug('PERM_DEBUG', 'Failed to read session for turn_context:', error?.message || error);
    return null;
  }
  if (!content.trim()) return null;
  const lines = splitSessionJsonlEntries(content);
  const startIndex = Math.max(0, lines.length - SESSION_CONTEXT_SCAN_MAX_LINES);
  for (let i = lines.length - 1; i >= startIndex; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type === 'turn_context' && parsed?.payload && typeof parsed.payload === 'object') {
      return parsed.payload;
    }
  }
  return null;
}

async function replayMissingFunctionCallsFromSession(state, config) {
  const sessionPath = ensureSessionFilePath(state, config.threadId);
  if (!sessionPath) return { toolUses: 0, toolResults: 0 };

  let content = '';
  try { content = await readFile(sessionPath, 'utf8'); } catch (error) {
    logDebug('SESSION_REPLAY', 'Failed to read session file for function replay:', error?.message || error);
    return { toolUses: 0, toolResults: 0 };
  }
  if (!content.trim()) return { toolUses: 0, toolResults: 0 };

  const lines = splitSessionJsonlEntries(content);
  const candidateStartIndexes = [
    state.sessionFunctionCursor > 0 ? state.sessionFunctionCursor : null,
    state.sessionTurnStartCursor > 0 ? state.sessionTurnStartCursor : null,
    Math.max(0, lines.length - SESSION_PATCH_SCAN_MAX_LINES),
  ].filter((value) => Number.isInteger(value) && value >= 0);
  const startIndex = candidateStartIndexes.length > 0
    ? Math.max(...candidateStartIndexes)
    : Math.max(0, lines.length - SESSION_PATCH_SCAN_MAX_LINES);

  let toolUses = 0;
  let toolResults = 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type !== 'response_item' || !parsed.payload || typeof parsed.payload !== 'object') continue;

    const payload = parsed.payload;
    const payloadType = payload.type;
    if (payloadType === 'function_call') {
      const callId = typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : (typeof payload.id === 'string' && payload.id ? payload.id : `line_${i}`);
      if (state.processedSessionFunctionCallIds.has(callId)) continue;
      state.processedSessionFunctionCallIds.add(callId);
      if (handleFunctionCallPayload(payload, state, { stableHint: callId })) {
        toolUses += 1;
      }
      continue;
    }

    if (payloadType === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : (typeof payload.id === 'string' && payload.id ? payload.id : `line_${i}`);
      if (state.processedSessionFunctionOutputIds.has(callId)) continue;
      state.processedSessionFunctionOutputIds.add(callId);
      if (handleFunctionCallOutputPayload(payload, state)) {
        toolResults += 1;
      }
    }
  }

  state.sessionFunctionCursor = lines.length;
  return { toolUses, toolResults };
}

async function replayMissingFunctionCallsDuringStream(state, config) {
  await replayMissingFunctionCallsFromSession(state, config);
}

function emitDeniedCommandToolResultOnce(state, toolUseId, messageText = 'Command denied by user') {
  if (!toolUseId || state.emittedDeniedCommandToolResultIds.has(toolUseId)) return;
  state.emitMessage(toolResultMsg(toolUseId, true, messageText));
  state.emittedToolResultIds.add(toolUseId);
  state.emittedDeniedCommandToolResultIds.add(toolUseId);
}

async function maybeRequestCommandApprovalViaBridge(state, config, { toolUseId, command, smartTool, description }) {
  const shouldBridgeApproval = config.threadOptions.approvalPolicy && config.threadOptions.approvalPolicy !== 'never';
  if (!shouldBridgeApproval) return true;
  const permissionToolName = mapCommandToolNameToPermissionToolName(smartTool);
  const requestInput = { command, description, source: 'codex_command_execution' };
  try {
    logInfo('PERM_DEBUG', `Command approval request: toolUseId=${toolUseId}, tool=${permissionToolName}, command=${command}`);
    const allowed = await requestPermissionFromJava(permissionToolName, requestInput);
    logInfo('PERM_DEBUG', `Command approval decision: toolUseId=${toolUseId}, allowed=${allowed ? 'true' : 'false'}`);
    if (allowed) return true;
  } catch (error) {
    logWarn('PERM_DEBUG', `Command approval bridge failed, deny by default: toolUseId=${toolUseId}, error=${error?.message || error}`);
  }
  state.deniedCommandToolUseIds.add(toolUseId);
  state.suppressNoResponseFallback = true;
  emitDeniedCommandToolResultOnce(state, toolUseId, 'Command denied by user and turn aborted');
  state.emitMessage({ type: 'status', message: 'Approval denied: abort requested (command may have already started)' });
  state.commandApprovalAbortRequested = true;
  try { config.turnAbortController.abort(); }
  catch (error) { logDebug('PERM_DEBUG', `Abort turn failed after command denial: ${error?.message || error}`); }
  return false;
}

function emitThinkingDelta(text) {
  process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(text)}\n`);
}

function emitContentDelta(text) {
  process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(text)}\n`);
}

function extractAppendedDelta(previousText, nextText) {
  const previous = typeof previousText === 'string' ? previousText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next.trim()) return '';
  if (!previous) return next;
  if (next === previous) return '';
  if (!next.startsWith(previous)) return '';
  return next.slice(previous.length);
}

function emitThinkingBlock(state, text) {
  logDebug('CODEX_EVENT', `Thinking: ${text}`);
  state.emitMessage({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: text, text }] }
  });
}

function maybeEmitReasoning(state, item) {
  if (!item || item.type !== 'reasoning') return;
  const raw = typeof item.text === 'string' ? item.text : '';
  const text = raw.trim();
  if (!text) return;
  const stableId = getStableItemId(item) ?? randomUUID();
  const previousText = state.reasoningTextCache.get(stableId) ?? '';
  const delta = extractAppendedDelta(previousText, text);
  if (!delta && previousText === text) return;
  state.reasoningTextCache.set(stableId, text);
  state.reasoningObserved = true;
  if (delta) {
    emitThinkingDelta(delta);
  }
  emitThinkingBlock(state, text);
}

async function maybeLogRuntimePolicy(state, config) {
  if (state.runtimePolicyLogged) return;
  const turnContext = await readLatestTurnContextFromSession(state, config.threadId);
  if (!turnContext) return;
  const actualApproval = typeof turnContext.approval_policy === 'string' ? turnContext.approval_policy : '';
  const actualSandbox = turnContext?.sandbox_policy?.type || '';
  const writableRoots = Array.isArray(turnContext?.sandbox_policy?.writable_roots) ? turnContext.sandbox_policy.writable_roots : [];
  state.runtimePolicyLogged = true;
  logDebug('PERM_DEBUG', 'Runtime turn_context policy:', JSON.stringify({
    expectedApprovalPolicy: config.threadOptions.approvalPolicy || '',
    expectedSandboxMode: config.threadOptions.sandboxMode || '',
    actualApprovalPolicy: actualApproval, actualSandboxMode: actualSandbox, writableRoots
  }));
  const expectedApproval = config.threadOptions.approvalPolicy || '';
  if (expectedApproval && actualApproval && expectedApproval !== actualApproval) {
    logWarn('PERM_DEBUG', `approvalPolicy mismatch: expected=${expectedApproval}, runtime=${actualApproval}`);
  }
}

/**
 * Handle a completed item from the Codex event stream.
 * Dispatches to type-specific handlers for agent_message, command_execution,
 * file_change, and mcp_tool_call.
 */
async function handleItemCompleted(item, state, config) {
  logDebug('CODEX_EVENT', `item.completed type=${item.type}`);
  logDebug('CODEX_EVENT', `item.completed hasText=${!!item.text}`);
  logDebug('CODEX_EVENT', `item.completed hasAgentMessage=${!!item.agent_message}`);
  maybeEmitReasoning(state, item);

  if (item.type === 'agent_message') {
    handleAgentMessage(item, state);
  } else if (item.type === 'command_execution') {
    handleCommandExecution(item, state);
  } else if (item.type === 'file_change') {
    await handleFileChange(item, state, config);
  } else if (item.type === 'mcp_tool_call') {
    handleMcpToolCall(item, state);
  } else {
    logDebug('CODEX_EVENT', `Unhandled item.completed item type=${item.type}`);
  }
}

function handleAgentMessage(item, state, { emitSnapshot = true } = {}) {
  const text = item.text || '';
  logDebug('CODEX_EVENT', `agent_message text length=${text.length}`);
  logDebug('CODEX_EVENT', `agent_message text=${text.substring(0, 100)}`);
  const stableId = getStableItemId(item) ?? 'agent_message';
  const previousText = state.assistantTextCache.get(stableId) ?? '';
  const delta = extractAppendedDelta(previousText, text);
  state.finalResponse = text;
  state.assistantTextCache.set(stableId, text);
  if (delta) {
    state.assistantText += delta;
    emitContentDelta(delta);
  }
  if (emitSnapshot && text && text.trim()) {
    state.emitMessage(textMsg(text));
  }
}

function handleCommandExecution(item, state) {
  const toolUseId = ensureToolUseId(state, 'completed', item);
  const command = extractCommand(item);
  if (state.deniedCommandToolUseIds.has(toolUseId)) {
    emitDeniedCommandToolResultOnce(state, toolUseId);
    logDebug('CODEX_EVENT', `Skip command output because approval denied: ${command}`);
    return;
  }
  const output = item.aggregated_output ?? item.output ?? item.stdout ?? item.result ?? '';
  const outputStrRaw = typeof output === 'string' ? output : JSON.stringify(output);
  const outputStr = truncateForDisplay(outputStrRaw, MAX_TOOL_RESULT_CHARS);
  const isError = (typeof item.exit_code === 'number' && item.exit_code !== 0) || item.is_error === true;
  const toolName = smartToolName(command);
  const description = smartDescription(command);
  if (!state.emittedToolUseIds.has(toolUseId)) {
    state.emitMessage(toolUseMsg(toolUseId, toolName, { command, description }));
    state.emittedToolUseIds.add(toolUseId);
  }
  state.emitMessage(toolResultMsg(toolUseId, isError, outputStr && outputStr.trim() ? outputStr : '(no output)'));
  state.emittedToolResultIds.add(toolUseId);
}

async function handleFileChange(item, state, config) {
  const status = item.status || 'completed';
  const isError = status !== 'completed';
  try { logDebug('CODEX_EVENT', `file_change raw item: ${JSON.stringify(item)}`); }
  catch (error) { logDebug('CODEX_EVENT', `file_change raw item stringify failed: ${error?.message || error}`); }

  const patchBatches = await collectPatchOperationsFromSession(
    state,
    config,
    ensureSessionFilePath,
    splitSessionJsonlEntries
  );
  let deniedCallIds = new Set();
  let rollbackByCallId = new Map();

  const shouldBridgeApproval = !isError &&
    !isAutoEditPermissionMode(config.normalizedPermissionMode) &&
    (config.threadOptions.approvalPolicy && config.threadOptions.approvalPolicy !== 'never');
  if (shouldBridgeApproval && patchBatches.length > 0) {
    deniedCallIds = await requestPatchApprovalsViaBridge(patchBatches);
    if (deniedCallIds.size > 0) {
      rollbackByCallId = await rollbackDeniedPatchBatches(patchBatches, deniedCallIds);
      const failedRollbackCount = Array.from(rollbackByCallId.values())
        .filter((entry) => entry && entry.success === false).length;
      state.emitMessage({
        type: 'status',
        message: failedRollbackCount > 0
          ? `Approval denied: attempted to rollback ${deniedCallIds.size} change(s), ${failedRollbackCount} rollback(s) failed`
          : `Approval denied: rolled back ${deniedCallIds.size} change(s)`
      });
    }
  }
  const emitted = emitSyntheticPatchOperations(state, patchBatches, isError, deniedCallIds, rollbackByCallId);
  if (emitted > 0) logDebug('CODEX_EVENT', `file_change synthesized operations=${emitted}`);
  else logDebug('CODEX_EVENT', 'file_change: no patch operations found in session log');
}

function handleMcpToolCall(item, state) {
  const toolName = normalizeMcpToolName(item.server, item.tool);
  const toolInput = normalizeMcpToolInput(item.server, item.tool, item.arguments || {});
  const rawItemId = typeof item.id === 'string' && item.id ? item.id : null;
  const signature = buildToolInvocationSignature(toolName, toolInput);
  const toolUseId = rawItemId || consumePendingMcpToolUseId(state, signature) || randomUUID();
  const isError = item.status === 'failed' || !!item.error;
  logDebug('CODEX_EVENT', `MCP tool call completed tool=${toolName} id=${toolUseId} error=${isError}`);
  if (!state.emittedToolUseIds.has(toolUseId)) {
    state.emitMessage(toolUseMsg(toolUseId, toolName, toolInput));
    state.emittedToolUseIds.add(toolUseId);
  }
  rememberToolInvocation(state, toolUseId, toolName, toolInput);
  let resultContent = '(no output)';
  if (item.error) {
    resultContent = item.error.message || 'MCP tool call failed';
  } else if (item.result) {
    if (item.result.content && Array.isArray(item.result.content)) {
      const textParts = item.result.content.filter(block => block.type === 'text').map(block => block.text);
      resultContent = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(item.result);
    } else if (item.result.structured_content) {
      resultContent = JSON.stringify(item.result.structured_content);
    } else {
      resultContent = JSON.stringify(item.result);
    }
  }
  if (state.emittedToolResultIds.has(toolUseId)) return;
  const truncatedResult = truncateForDisplay(resultContent, MAX_TOOL_RESULT_CHARS);
  state.emitMessage(toolResultMsg(toolUseId, isError, truncatedResult && truncatedResult.trim() ? truncatedResult : '(no output)'));
  state.emittedToolResultIds.add(toolUseId);
}

/**
 * Process Codex SDK event stream.
 * @param {AsyncIterable} events - The SDK event stream
 * @param {EventProcessingState} state - Mutable state (created via createInitialEventState)
 * @param {Object} config - { cwd, threadId, threadOptions, normalizedPermissionMode, turnAbortController }
 */
export async function processCodexEventStream(events, state, config) {
  let rawEventIndex = 0;
  try {
    for await (const event of events) {
      rawEventIndex += 1;
      const rawEventJson = stringifyRawEvent(event);
      if (rawEventJson && DEBUG_LEVEL >= 5) logDebug('CODEX_RAW_EVENT', `[${rawEventIndex}] ${rawEventJson}`);
      if (rawEventJson && DEBUG_LEVEL >= 4 && isApprovalRelatedRawEvent(rawEventJson)) {
        logDebug('CODEX_RAW_EVENT', `[APPROVAL_HINT][${rawEventIndex}] ${rawEventJson}`);
      }
      await maybeLogRuntimePolicy(state, config);
      logDebug('CODEX_EVENT', `Codex event=${event.type}`);

      switch (event.type) {
      case 'thread.started': {
        state.currentThreadId = event.thread_id;
        if (state.currentThreadId && !config.threadId) {
          config.threadId = state.currentThreadId;
        }
        state.sessionFilePath = null;
        state.sessionLineCursor = 0;
        state.sessionFunctionCursor = 0;
        state.sessionTurnStartCursor = 0;
        state.turnWorkspaceSnapshot = null;
        state.emittedFileChangePaths.clear();
        state.processedPatchCallIds.clear();
        state.processedSessionFunctionCallIds.clear();
        state.processedSessionFunctionOutputIds.clear();
        logInfo('CODEX_EVENT', `Thread id=${state.currentThreadId}`);
        break;
      }

      case 'turn.started': {
        state.turnWorkspaceSnapshot = null;
        state.emittedFileChangePaths.clear();
        const sessionPath = ensureSessionFilePath(state, config.threadId);
        if (sessionPath && existsSync(sessionPath)) {
          try {
            const content = await readFile(sessionPath, 'utf8');
            state.sessionTurnStartCursor = countSessionJsonlLines(content);
          } catch {
            state.sessionTurnStartCursor = state.sessionFunctionCursor;
          }
        } else {
          state.sessionTurnStartCursor = state.sessionFunctionCursor;
        }
        await captureTurnWorkspaceSnapshot(state, config);
        logDebug('CODEX_EVENT', 'Turn started');
        break;
      }

      case 'event_msg': {
        await replayMissingFunctionCallsDuringStream(state, config);
        break;
      }

      case 'item.started': {
        maybeEmitReasoning(state, event.item);
        if (event.item && event.item.type === 'command_execution') {
          await captureTurnWorkspaceSnapshot(state, config);
          const toolUseId = ensureToolUseId(state, 'started', event.item);
          const command = extractCommand(event.item);
          const toolName = smartToolName(command);
          const description = smartDescription(command);
          state.emitMessage(toolUseMsg(toolUseId, toolName, { command, description }));
          state.emittedToolUseIds.add(toolUseId);
          rememberToolInvocation(state, toolUseId, toolName, { command, description });
          const allowed = await maybeRequestCommandApprovalViaBridge(
            state, config, { toolUseId, command, smartTool: toolName, description }
          );
          if (!allowed) {
            logWarn('PERM_DEBUG', `Command denied by approval bridge: ${command}`);
            throw new Error(COMMAND_DENIED_ABORT_ERROR);
          }
        } else if (event.item && event.item.type === 'mcp_tool_call') {
          const toolName = normalizeMcpToolName(event.item.server, event.item.tool);
          const toolInput = normalizeMcpToolInput(event.item.server, event.item.tool, event.item.arguments || {});
          const rawItemId = typeof event.item.id === 'string' && event.item.id ? event.item.id : null;
          const toolUseId = rawItemId || randomUUID();
          logDebug('CODEX_EVENT', `MCP tool call started tool=${toolName} id=${toolUseId}`);
          if (!state.emittedToolUseIds.has(toolUseId)) {
            state.emitMessage(toolUseMsg(toolUseId, toolName, toolInput));
            state.emittedToolUseIds.add(toolUseId);
          }
          rememberToolInvocation(state, toolUseId, toolName, toolInput);
          if (!rawItemId) {
            rememberPendingMcpToolUseId(state, buildToolInvocationSignature(toolName, toolInput), toolUseId);
          }
        }
        await replayMissingFunctionCallsDuringStream(state, config);
        break;
      }

      case 'item.updated':
        maybeEmitReasoning(state, event.item);
        if (event.item && event.item.type === 'agent_message') {
          handleAgentMessage(event.item, state, { emitSnapshot: false });
        }
        await replayMissingFunctionCallsDuringStream(state, config);
        break;

      case 'item.completed': {
        if (!event.item) break;
        await handleItemCompleted(event.item, state, config);
        await replayMissingFunctionCallsDuringStream(state, config);
        break;
      }

      case 'turn.completed': {
        logDebug('CODEX_EVENT', 'Turn completed');
        const replayed = await replayMissingFunctionCallsFromSession(state, config);
        if (replayed.toolUses > 0 || replayed.toolResults > 0) {
          logDebug('CODEX_EVENT', `Replayed session function calls: ${JSON.stringify(replayed)}`);
        }
        await emitTurnWorkspaceDiff(state, config);
        if (event.usage) {
          logDebug('CODEX_EVENT', `Token usage: ${JSON.stringify(event.usage)}`);
          const claudeUsage = {
            input_tokens: event.usage.input_tokens || 0,
            output_tokens: event.usage.output_tokens || 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: event.usage.cached_input_tokens || 0
          };
          state.emitMessage({
            type: 'result', subtype: 'usage', is_error: false,
            usage: claudeUsage, session_id: state.currentThreadId, uuid: randomUUID()
          });
          logDebug('CODEX_EVENT', `Emitted usage statistics: ${JSON.stringify(claudeUsage)}`);
        }
        if (typeof config.onTurnCompleted === 'function') {
          config.onTurnCompleted(event, state);
        }
        break;
      }

      case 'turn.failed': {
        const errorMsg = event.error?.message || 'Turn failed';
        if (isReconnectNotice(errorMsg)) {
          logWarn('CODEX_EVENT', `Codex reconnect notice: ${errorMsg}`);
          emitStatusMessage(state.emitMessage, errorMsg);
          break;
        }
        if (state.commandApprovalAbortRequested && /aborted|abort|cancel|interrupt/i.test(errorMsg)) {
          logInfo('PERM_DEBUG', `Ignore turn.failed after command denial abort: ${errorMsg}`);
          break;
        }
        if (typeof config.onTurnFailed === 'function') {
          config.onTurnFailed(event, state);
        }
        logWarn('CODEX_EVENT', `Turn failed: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      case 'error': {
        const generalError = event.message || 'Unknown error';
        if (isReconnectNotice(generalError)) {
          logWarn('CODEX_EVENT', `Codex reconnect notice: ${generalError}`);
          emitStatusMessage(state.emitMessage, generalError);
          break;
        }
        if (state.commandApprovalAbortRequested && /aborted|abort|cancel|interrupt/i.test(generalError)) {
          logInfo('PERM_DEBUG', `Ignore error event after command denial abort: ${generalError}`);
          break;
        }
        if (typeof config.onTurnFailed === 'function') {
          config.onTurnFailed(event, state);
        }
        logWarn('CODEX_EVENT', `Codex error: ${generalError}`);
        throw new Error(generalError);
      }

      default: {
        const payloadType = event.payload?.type;
        logDebug('CODEX_EVENT', `Unknown event type=${event.type} payload.type=${payloadType}`);

        if (event.type === 'response_item') {
          const payload = event.payload;
          const payloadCallId = typeof payload?.call_id === 'string' && payload.call_id
            ? payload.call_id
            : null;
          const payloadStableId = typeof payload?.id === 'string' && payload.id ? payload.id : null;
          const payloadKey = payloadCallId || payloadStableId;
          if (handleFunctionCallPayload(payload, state, { stableHint: payloadKey || `stream_${rawEventIndex}` })) {
            if (payloadKey) {
              state.processedSessionFunctionCallIds.add(payloadKey);
            }
            break;
          }
          if (handleFunctionCallOutputPayload(payload, state)) {
            if (payloadKey) {
              state.processedSessionFunctionOutputIds.add(payloadKey);
            }
            break;
          }
        }

        if (event.type === 'event_msg' || payloadType === 'function_call' || payloadType === 'function_call_output') {
          logDebug('CODEX_EVENT', `Full event: ${JSON.stringify(event).substring(0, 500)}`);
        }
      }
      }
    }
  } catch (streamError) {
    const streamErrorMessage = streamError?.message || String(streamError);
    if (state.commandApprovalAbortRequested && (
      streamErrorMessage === COMMAND_DENIED_ABORT_ERROR ||
      /aborted|abort|cancel|interrupt/i.test(streamErrorMessage)
    )) {
      logInfo('PERM_DEBUG', `Suppress streamed turn abort after command denial: ${streamErrorMessage}`);
    } else {
      throw streamError;
    }
  }
}
