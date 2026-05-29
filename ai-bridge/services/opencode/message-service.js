/**
 * opencode message service.
 *
 * The plugin expects the user to install and configure the opencode CLI. This
 * bridge starts the user's CLI in headless HTTP mode through @opencode-ai/sdk,
 * sends prompts with the existing opencode provider/model configuration, and
 * normalizes streamed opencode events to the bridge markers used by Java.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, isAbsolute, join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { requestPermissionFromJava, requestAskUserQuestionAnswers } from '../../permission-ipc.js';
import { getMcpServerTools as getMcpServerToolsImpl } from '../claude/mcp-status/index.js';
import { ensureOpenCodeSdk, normalizeOpenCodeSdkError } from './opencode-utils.js';
import {
  buildOpenCodePermissionDialogRequest,
  shouldAutoAllowOpenCodePermission,
  shouldAutoRejectOpenCodePermission
} from './opencode-permissions.js';

const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_START_TIMEOUT_MS = 10000;
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_HISTORY_COUNT_CONCURRENCY = 4;
const DEFAULT_MCP_STATUS_TIMEOUT_MS = 35000;
const MAX_TOOL_RESULT_CHARS = 20000;
const DEFAULT_EVENT_DRAIN_IDLE_MS = 300;
const DEFAULT_SESSION_STATUS_POLL_MS = 250;
const PLAN_MODE_PERMISSION_DENIED =
  'opencode permission denied because the chat is in plan mode.';
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const NATIVE_FILE_EDIT_TOOLS = new Set(['edit', 'write_file', 'write_to_file']);
const OPENCODE_DEFAULT_AGENT_ID = 'opencode-default';
const OPENCODE_AGENT_PREFIX = 'opencode:';
const OPENCODE_COMMAND_PREFIX = 'opencode-command:';
const persistentRuntimes = new Map();
const activeOpenCodeTurns = new Set();

function emitMarker(marker, payload) {
  if (payload === undefined) {
    console.log(marker);
    return;
  }
  console.log(`${marker} ${payload}`);
}

function emitMessage(message) {
  emitMarker('[MESSAGE]', JSON.stringify(message));
}

function emitStatus(message) {
  if (!message) {
    return;
  }
  emitMessage({ type: 'status', message });
}

function emitContentDelta(delta) {
  if (delta) {
    emitMarker('[CONTENT_DELTA]', JSON.stringify(delta));
  }
}

function emitThinkingDelta(delta) {
  if (delta) {
    emitMarker('[THINKING_DELTA]', JSON.stringify(delta));
  }
}

function emitSendError(errorPayload) {
  emitMarker('[SEND_ERROR]', JSON.stringify(errorPayload));
}

function emitContextSendError(ctx, errorPayload) {
  if (ctx) {
    if (ctx.sawSendError) {
      return;
    }
    ctx.sawSendError = true;
  }
  emitSendError(errorPayload);
}

function toolUseMsg(id, name, input) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [toolUseBlock(id, name, input)]
    }
  };
}

function toolResultMsg(toolUseId, isError, content, metadata = undefined) {
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [toolResultBlock(toolUseId, isError, content)]
    }
  };
  if (metadata && Object.keys(metadata).length > 0) {
    message.toolUseResult = metadata;
  }
  return message;
}

function toolUseBlock(id, name, input) {
  return { type: 'tool_use', id, name, input };
}

function toolResultBlock(toolUseId, isError, content) {
  return { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function directoryQuery(cwd) {
  return cwd && cwd.trim() ? { directory: cwd.trim() } : undefined;
}

function historyListQuery(cwd) {
  return {
    ...(directoryQuery(cwd) || {}),
    scope: 'project',
    roots: true,
    limit: parsePositiveInteger(process.env.OPENCODE_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT)
  };
}

function shouldCountOpenCodeHistoryMessages() {
  const value = (process.env.OPENCODE_HISTORY_MESSAGE_COUNTS || 'true').trim().toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'off';
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildAuthHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD || '';
  if (!password) {
    return undefined;
  }
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

function createOpenCodeFetch(headers) {
  if (!headers || !headers.Authorization) {
    return undefined;
  }

  return (request) => {
    const next = new Request(request);
    next.headers.set('Authorization', headers.Authorization);
    next.timeout = false;
    return fetch(next);
  };
}

async function createOpenCodeRuntime(cwd) {
  const sdk = await ensureOpenCodeSdk();
  const headers = buildAuthHeaders();
  const fetchImpl = createOpenCodeFetch(headers);
  const clientConfig = {
    directory: cwd || undefined,
    headers,
    fetch: fetchImpl
  };

  const baseUrl = (process.env.OPENCODE_BASE_URL || '').trim();
  if (baseUrl) {
    return {
      sdk,
      client: sdk.createOpencodeClient({ ...clientConfig, baseUrl }),
      baseUrl,
      ownedServer: false,
      close: async () => {}
    };
  }

  if (typeof sdk.createOpencodeServer !== 'function') {
    throw new Error('opencode SDK loaded, but createOpencodeServer export was not found');
  }

  const server = await sdk.createOpencodeServer({
    hostname: process.env.OPENCODE_HOSTNAME || DEFAULT_HOSTNAME,
    port: parsePositiveInteger(process.env.OPENCODE_PORT, DEFAULT_PORT),
    timeout: parsePositiveInteger(
      process.env.OPENCODE_SERVER_START_TIMEOUT_MS,
      DEFAULT_START_TIMEOUT_MS
    )
  });

  return {
    sdk,
    client: sdk.createOpencodeClient({ ...clientConfig, baseUrl: server.url }),
    baseUrl: server.url,
    ownedServer: true,
    close: async () => server.close()
  };
}

function shouldUsePersistentRuntime(options = {}) {
  if (options?.persistentRuntime === true) {
    return true;
  }
  const value = (process.env.OPENCODE_PERSISTENT_RUNTIME || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'on';
}

function persistentRuntimeKey(cwd) {
  const baseUrl = (process.env.OPENCODE_BASE_URL || '').trim();
  return JSON.stringify({
    cwd: cwd || '',
    baseUrl,
    hostname: process.env.OPENCODE_HOSTNAME || DEFAULT_HOSTNAME,
    port: parsePositiveInteger(process.env.OPENCODE_PORT, DEFAULT_PORT),
    username: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
    password: process.env.OPENCODE_SERVER_PASSWORD || '',
    startTimeout: parsePositiveInteger(
      process.env.OPENCODE_SERVER_START_TIMEOUT_MS,
      DEFAULT_START_TIMEOUT_MS
    )
  });
}

async function getPersistentOpenCodeRuntime(cwd) {
  const key = persistentRuntimeKey(cwd);
  const existing = persistentRuntimes.get(key);
  if (existing) {
    return existing;
  }

  const runtimePromise = createOpenCodeRuntime(cwd).catch((error) => {
    persistentRuntimes.delete(key);
    throw error;
  });
  persistentRuntimes.set(key, runtimePromise);
  return runtimePromise;
}

async function acquireOpenCodeRuntime(cwd, options = {}) {
  if (shouldUsePersistentRuntime(options)) {
    return getPersistentOpenCodeRuntime(cwd);
  }
  return createOpenCodeRuntime(cwd);
}

async function releaseOpenCodeRuntime(runtime, options = {}) {
  if (!runtime || shouldUsePersistentRuntime(options)) {
    return;
  }
  await runtime.close().catch(() => {});
}

export async function shutdownPersistentOpenCodeRuntimes() {
  const runtimes = Array.from(persistentRuntimes.values());
  persistentRuntimes.clear();
  await Promise.all(runtimes.map(async (runtimePromise) => {
    try {
      const runtime = await runtimePromise;
      await runtime.close().catch(() => {});
    } catch {
      // Ignore runtimes that failed while starting.
    }
  }));
}

export async function abortCurrentOpenCodeTurn() {
  const aborts = [];
  for (const turn of Array.from(activeOpenCodeTurns)) {
    turn.aborted = true;
    if (turn.eventAbortController) {
      turn.eventAbortController.abort();
    }
    if (turn.runtime && turn.sessionId) {
      aborts.push(
        unwrapSdkResult(
          turn.runtime.client.session.abort({
            path: { id: turn.sessionId },
            query: directoryQuery(turn.cwd)
          }),
          'abort active opencode session'
        ).catch(() => {})
      );
    }
  }
  await Promise.all(aborts);
}

async function unwrapSdkResult(result, operation) {
  const resolved = await result;
  if (resolved && resolved.error) {
    const error = new Error(formatOpenCodeError(resolved.error, `${operation} failed`));
    error.details = resolved.error;
    error.response = resolved.response;
    throw error;
  }
  return resolved ? resolved.data : undefined;
}

function formatOpenCodeError(error, fallback = 'opencode request failed') {
  const seen = new Set();

  function fromValue(value) {
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value !== 'object') {
      return '';
    }
    if (seen.has(value)) {
      return '';
    }
    seen.add(value);

    const candidates = [
      value.data?.message,
      value.error?.data?.message,
      value.error?.message,
      value.message,
      value.reason,
      value.statusText,
      value.name,
      value.data?.error,
      value.error,
      value.cause,
      value.responseBody,
      value.data?.responseBody
    ];

    for (const candidate of candidates) {
      const message = fromValue(candidate);
      if (message) {
        return message;
      }
    }

    if (Array.isArray(value.issues)) {
      const issues = value.issues.map(fromValue).filter(Boolean);
      if (issues.length > 0) {
        return issues.join('\n');
      }
    }
    if (Array.isArray(value.details)) {
      const details = value.details.map(fromValue).filter(Boolean);
      if (details.length > 0) {
        return details.join('\n');
      }
    }

    return '';
  }

  if (!error) {
    return fallback;
  }
  const formatted = fromValue(error);
  if (formatted) {
    return formatted;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return fallback;
  }
}

function truncateForDisplay(value, maxChars = MAX_TOOL_RESULT_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[opencode tool output truncated: omitted ${omitted} chars]`;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseJsonRecord(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

function normalizeOpenCodeToolName(tool) {
  const name = typeof tool === 'string' ? tool.trim() : '';
  if (name === 'write') {
    return 'write_file';
  }
  if (name === 'websearch') {
    return 'search';
  }
  return name || 'opencode_tool';
}

function isAbsoluteProjectPath(filePath) {
  return isAbsolute(filePath) || WINDOWS_ABSOLUTE_PATH.test(filePath);
}

function resolveProjectPath(filePath, cwd) {
  const path = typeof filePath === 'string' ? filePath.trim() : '';
  if (!path || !cwd || isAbsoluteProjectPath(path)) {
    return path;
  }
  return resolve(cwd, path);
}

function normalizePathForSignature(filePath, cwd) {
  const resolvedPath = resolveProjectPath(filePath, cwd);
  return resolvedPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function parseUnifiedPatchToStrings(patch) {
  if (typeof patch !== 'string' || !patch.trim()) {
    return { oldString: '', newString: '' };
  }

  const oldLines = [];
  const newLines = [];
  for (const line of patch.split(/\r?\n/)) {
    if (
      !line ||
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('@@') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('\\ No newline')
    ) {
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const text = line.slice(1);
      oldLines.push(text);
      newLines.push(text);
    }
  }

  return {
    oldString: oldLines.join('\n'),
    newString: newLines.join('\n')
  };
}

function normalizeOpenCodeToolInput(part, cwd = '') {
  const state = asRecord(part?.state);
  const metadata = { ...asRecord(state.metadata), ...asRecord(part?.metadata) };
  const filediff = asRecord(metadata.filediff);
  const raw = parseJsonRecord(state.raw);
  const rawDirectInput = { ...raw };
  delete rawDirectInput.args;
  delete rawDirectInput.input;
  delete rawDirectInput.parameters;
  const rawInput = {
    ...rawDirectInput,
    ...asRecord(raw.args),
    ...asRecord(raw.input),
    ...asRecord(raw.parameters)
  };
  const input = {
    ...rawInput,
    ...asRecord(metadata.args),
    ...asRecord(metadata.input),
    ...asRecord(part?.args),
    ...asRecord(part?.input),
    ...asRecord(state.input)
  };
  const toolName = normalizeOpenCodeToolName(part?.tool);

  if (toolName === 'task' || toolName === 'agent' || toolName === 'spawn_agent') {
    const subagentType = pickString(
      input.subagent_type,
      input.subagentType,
      input.agent,
      input.agent_type,
      input.agentType,
      metadata.subagent_type,
      metadata.subagentType
    );
    if (subagentType) {
      input.subagent_type = subagentType;
    }

    const description = pickString(
      input.description,
      input.title,
      metadata.description,
      metadata.title,
      state.title
    );
    if (description) {
      input.description = description;
    }

    const prompt = pickString(input.prompt, input.message, input.text, metadata.prompt);
    if (prompt) {
      input.prompt = prompt;
    }

    const subagentSessionId = pickString(
      input.subagent_session_id,
      input.subagentSessionId,
      input.sessionId,
      input.sessionID,
      metadata.sessionId,
      metadata.sessionID
    );
    if (subagentSessionId) {
      input.subagent_session_id = subagentSessionId;
      input.agentId = input.agentId || subagentSessionId;
    }
  }

  const filePath = pickString(
    input.file_path,
    input.filePath,
    input.path,
    input.target_file,
    input.targetFile,
    filediff.file,
    filediff.filePath
  );
  if (filePath) {
    input.file_path = resolveProjectPath(filePath, cwd);
    if (cwd && !input.workdir) {
      input.workdir = cwd;
    }
  }

  const patch = pickString(metadata.diff, filediff.patch, input.patch, input.patchText);
  if (patch && !input.patch) {
    input.patch = patch;
  }

  const parsedPatch = parseUnifiedPatchToStrings(patch);
  const oldString = pickString(
    input.old_string,
    input.oldString,
    filediff.before,
    parsedPatch.oldString
  );
  const newString = pickString(
    input.new_string,
    input.newString,
    input.content,
    filediff.after,
    parsedPatch.newString
  );
  if (oldString) {
    input.old_string = oldString;
  }
  if (newString) {
    input.new_string = newString;
  }

  return input;
}

function hasNativeFileEditInput(input) {
  return Boolean(
    input.file_path &&
      (
        typeof input.old_string === 'string' ||
        typeof input.new_string === 'string' ||
        typeof input.patch === 'string' ||
        typeof input.content === 'string'
      )
  );
}

function shouldEmitSyntheticDiffForTool(part, normalizedInput) {
  const toolName = normalizeOpenCodeToolName(part?.tool);
  return !NATIVE_FILE_EDIT_TOOLS.has(toolName) || !hasNativeFileEditInput(normalizedInput);
}

function openCodeToolUseId(part) {
  return pickString(part?.callID, part?.callId, part?.id);
}

function openCodeToolResultContent(part) {
  const state = asRecord(part?.state);
  const output = state.status === 'error' ? state.error : state.output;
  const fallback = pickString(state.title, part?.tool) || '(no output)';
  const content = pickString(output) || fallback;
  return truncateForDisplay(content);
}

function openCodeToolExitCode(part) {
  const metadata = openCodeToolMetadata(part);
  const candidates = [metadata.exit, metadata.exitCode, metadata.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim() && /^-?\d+$/.test(candidate.trim())) {
      return Number.parseInt(candidate.trim(), 10);
    }
  }
  return undefined;
}

function isOpenCodeToolResultError(part) {
  const status = part?.state?.status;
  if (status === 'error') {
    return true;
  }
  if (status !== 'completed') {
    return false;
  }

  const metadata = openCodeToolMetadata(part);
  if (metadata.error === true) {
    return true;
  }

  const toolName = normalizeOpenCodeToolName(part?.tool);
  const exitCode = openCodeToolExitCode(part);
  return toolName === 'bash' && typeof exitCode === 'number' && exitCode !== 0;
}

function taskSessionIdFromOutput(output) {
  const text = typeof output === 'string' ? output : '';
  const match = text.match(/^task_id:\s*([A-Za-z0-9_-]+)/m);
  return match?.[1] || '';
}

function openCodeToolResultMetadata(part, normalizedInput = undefined) {
  const toolName = normalizeOpenCodeToolName(part?.tool);
  if (toolName !== 'task' && toolName !== 'agent' && toolName !== 'spawn_agent') {
    return undefined;
  }

  const state = asRecord(part?.state);
  const metadata = { ...asRecord(state.metadata), ...asRecord(part?.metadata) };
  const input = normalizedInput || normalizeOpenCodeToolInput(part);
  const agentId = pickString(
    metadata.agentId,
    metadata.agentID,
    metadata.sessionId,
    metadata.sessionID,
    taskSessionIdFromOutput(state.output)
  );
  const result = {};
  if (agentId) {
    result.agentId = agentId;
    result.subagentSessionId = agentId;
  }
  const agentType = pickString(input.subagent_type, input.subagentType, metadata.subagent_type);
  if (agentType) {
    result.agentType = agentType;
  }
  const description = pickString(input.description, metadata.description, state.title);
  if (description) {
    result.description = description;
  }
  const totalToolUseCount = metadata.toolcalls ?? metadata.toolCalls ?? metadata.calls;
  if (typeof totalToolUseCount === 'number' && Number.isFinite(totalToolUseCount)) {
    result.totalToolUseCount = totalToolUseCount;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function emitOpenCodeToolUse(ctx, part, normalizedInput = undefined) {
  if (!part || part.type !== 'tool') {
    return '';
  }
  const toolUseId = openCodeToolUseId(part);
  if (!toolUseId) {
    return '';
  }
  const toolName = normalizeOpenCodeToolName(part.tool);
  const input = normalizedInput || normalizeOpenCodeToolInput(part, ctx.cwd);
  const signature = JSON.stringify({ toolName, input });
  if (!ctx.emittedToolUseIds.has(toolUseId) || ctx.toolUseSignatures.get(toolUseId) !== signature) {
    emitMessage(toolUseMsg(toolUseId, toolName, input));
    ctx.emittedToolUseIds.add(toolUseId);
    ctx.toolUseSignatures.set(toolUseId, signature);
  }
  return toolUseId;
}

function emitOpenCodeToolResult(ctx, part, normalizedInput = undefined) {
  const toolUseId = emitOpenCodeToolUse(ctx, part, normalizedInput);
  if (!toolUseId || ctx.emittedToolResultIds.has(toolUseId)) {
    return;
  }
  const status = part?.state?.status;
  if (status !== 'completed' && status !== 'error') {
    return;
  }
  const isError = isOpenCodeToolResultError(part);
  emitMessage(toolResultMsg(
    toolUseId,
    isError,
    openCodeToolResultContent(part),
    openCodeToolResultMetadata(part, normalizedInput)
  ));
  if (isError) {
    const exitCode = openCodeToolExitCode(part);
    const suffix = typeof exitCode === 'number' ? ` (exit ${exitCode})` : '';
    ctx.lastToolError = `${normalizeOpenCodeToolName(part?.tool)}${suffix}: ${openCodeToolResultContent(part)}`;
  }
  ctx.emittedToolResultIds.add(toolUseId);
}

function normalizeOpenCodeDiff(diff, cwd = '') {
  const candidate = asRecord(diff);
  const filePath = resolveProjectPath(
    pickString(candidate.file, candidate.filePath, candidate.relativePath, candidate.path),
    cwd
  );
  const patch = pickString(candidate.patch, candidate.diff);
  const parsedPatch = parseUnifiedPatchToStrings(patch);
  const oldString = pickString(candidate.before, parsedPatch.oldString);
  const newString = pickString(candidate.after, parsedPatch.newString);
  if (!filePath || (!oldString && !newString && !patch)) {
    return null;
  }
  return {
    filePath,
    patch,
    oldString,
    newString,
    status: typeof candidate.status === 'string' ? candidate.status : undefined,
    additions: typeof candidate.additions === 'number' ? candidate.additions : undefined,
    deletions: typeof candidate.deletions === 'number' ? candidate.deletions : undefined
  };
}

function stableHash(text) {
  const value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function emitOpenCodeDiffMessages(ctx, diffs, source = 'opencode') {
  if (!Array.isArray(diffs)) {
    return 0;
  }

  let emitted = 0;
  diffs.forEach((rawDiff, index) => {
    const diff = normalizeOpenCodeDiff(rawDiff, ctx.cwd);
    if (!diff) {
      return;
    }
    const fileSignature = normalizePathForSignature(diff.filePath, ctx.cwd);
    const signature = `${fileSignature}:${diff.patch || diff.oldString}:${diff.newString}`;
    if (ctx.emittedDiffIds.has(signature)) {
      return;
    }
    ctx.emittedDiffIds.add(signature);

    const safeFile = diff.filePath.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const toolUseId = `opencode_diff_${ctx.sessionRef.id || 'session'}_${index}_${stableHash(signature)}_${safeFile}`;
    emitMessage(toolUseMsg(toolUseId, 'edit', {
      file_path: diff.filePath,
      old_string: diff.oldString,
      new_string: diff.newString,
      patch: diff.patch,
      workdir: ctx.cwd || undefined,
      source,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions
    }));
    emitMessage(toolResultMsg(toolUseId, false, 'File change recorded'));
    emitted += 1;
  });

  return emitted;
}

function openCodeToolMetadata(part) {
  const state = asRecord(part?.state);
  return { ...asRecord(state.metadata), ...asRecord(part?.metadata) };
}

function openCodeToolDiffs(part) {
  const metadata = openCodeToolMetadata(part);
  const fileDiffs = [];
  if (metadata.filediff) {
    fileDiffs.push(metadata.filediff);
  }
  if (Array.isArray(metadata.files)) {
    fileDiffs.push(...metadata.files);
  }
  return fileDiffs;
}

function syntheticDiffBlocksForTool(part, cwd) {
  const status = part?.state?.status;
  if (status !== 'completed' && status !== 'error') {
    return [];
  }

  const normalizedInput = normalizeOpenCodeToolInput(part, cwd);
  if (!shouldEmitSyntheticDiffForTool(part, normalizedInput)) {
    return [];
  }

  const fileDiffs = openCodeToolDiffs(part);
  if (fileDiffs.length === 0) {
    return [];
  }

  const blocks = [];
  const seen = new Set();
  const source = `tool:${openCodeToolUseId(part) || part?.id || part?.tool || 'opencode_tool'}`;
  fileDiffs.forEach((rawDiff, index) => {
    const diff = normalizeOpenCodeDiff(rawDiff, cwd);
    if (!diff) {
      return;
    }
    const fileSignature = normalizePathForSignature(diff.filePath, cwd);
    const signature = `${fileSignature}:${diff.patch || diff.oldString}:${diff.newString}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);

    const safeFile = diff.filePath.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const toolUseId = `opencode_diff_${openCodeToolUseId(part) || part?.id || 'history'}_${index}_${stableHash(signature)}_${safeFile}`;
    blocks.push(toolUseBlock(toolUseId, 'edit', {
      file_path: diff.filePath,
      old_string: diff.oldString,
      new_string: diff.newString,
      patch: diff.patch,
      workdir: cwd || undefined,
      source,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions
    }));
    blocks.push(toolResultBlock(toolUseId, false, 'File change recorded'));
  });

  return blocks;
}

function extractSessionId(session) {
  if (!session || typeof session !== 'object') {
    return '';
  }
  return session.id || session.sessionID || '';
}

function parseOpenCodeModel(model) {
  if (typeof model !== 'string') {
    return undefined;
  }

  const trimmed = model.trim();
  if (!trimmed || trimmed.startsWith('claude-')) {
    return undefined;
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.providerID && parsed.modelID) {
        return {
          providerID: String(parsed.providerID),
          modelID: String(parsed.modelID)
        };
      }
    } catch {
      return undefined;
    }
  }

  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }

  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1)
  };
}

function isSafeOpenCodeAgentName(value) {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function isSafeOpenCodeCommandName(value) {
  return /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value);
}

function normalizeOpenCodeAgentMarker(agent) {
  if (typeof agent !== 'string') {
    return '';
  }

  const trimmed = agent.trim();
  if (!trimmed.startsWith(OPENCODE_AGENT_PREFIX)) {
    return '';
  }

  const agentName = trimmed.slice(OPENCODE_AGENT_PREFIX.length).trim();
  if (
    !agentName ||
    agentName === OPENCODE_DEFAULT_AGENT_ID ||
    agentName === '__default__'
  ) {
    return '';
  }
  return isSafeOpenCodeAgentName(agentName) ? agentName : '';
}

function resolveOpenCodePromptOptions(permissionMode = '', agent = '') {
  if (permissionMode === 'plan') {
    return { agent: 'plan' };
  }

  const markedAgent = normalizeOpenCodeAgentMarker(agent);
  if (markedAgent) {
    return { agent: markedAgent };
  }

  const trimmed = typeof agent === 'string' ? agent.trim() : '';
  if (!trimmed) {
    return {};
  }
  if (trimmed === OPENCODE_DEFAULT_AGENT_ID) {
    return {};
  }

  return { system: trimmed };
}

function normalizeOpenCodeCommand(rawCommand) {
  const candidate = asRecord(rawCommand);
  const name = pickString(candidate.name, candidate.id);
  if (!name || !isSafeOpenCodeCommandName(name)) {
    return null;
  }
  if (candidate.source === 'skill') {
    return null;
  }

  const source = pickString(candidate.source) || 'command';
  const description = pickString(candidate.description);
  const label = `/${name}`;
  const sourceSuffix = source === 'mcp' ? ' [mcp]' : '';

  return {
    id: `${OPENCODE_COMMAND_PREFIX}${name}`,
    name,
    label,
    description: description ? `${description}${sourceSuffix}` : sourceSuffix.trim(),
    category: source === 'mcp' ? 'mcp' : 'opencode',
    source,
    provider: 'opencode',
    native: true,
    hints: Array.isArray(candidate.hints)
      ? candidate.hints.filter((hint) => typeof hint === 'string')
      : []
  };
}

function normalizeOpenCodeCommands(commandPayload = []) {
  const seen = new Set();
  const commands = [];
  for (const rawCommand of Array.isArray(commandPayload) ? commandPayload : []) {
    const command = normalizeOpenCodeCommand(rawCommand);
    if (!command || seen.has(command.name)) {
      continue;
    }
    seen.add(command.name);
    commands.push(command);
  }
  commands.sort((a, b) => a.label.localeCompare(b.label));
  return commands;
}

function parseOpenCodeSlashCommand(message) {
  const text = typeof message === 'string' ? message : '';
  if (!text.startsWith('/')) {
    return null;
  }

  const firstLineEnd = text.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const match = firstLine.match(/^\/(\S+)(?:\s+(.*))?$/);
  if (!match) {
    return null;
  }

  const command = match[1];
  if (!isSafeOpenCodeCommandName(command)) {
    return null;
  }

  const firstLineArguments = match[2] || '';
  const restOfInput = firstLineEnd === -1 ? '' : text.slice(firstLineEnd + 1);
  return {
    command,
    arguments: firstLineArguments + (restOfInput ? `\n${restOfInput}` : '')
  };
}

async function resolveOpenCodeSlashCommand(client, cwd, message) {
  const parsed = parseOpenCodeSlashCommand(message);
  if (!parsed) {
    return null;
  }

  try {
    const commands = normalizeOpenCodeCommands(await unwrapSdkResult(
      client.command.list({ query: directoryQuery(cwd) }),
      'list opencode commands'
    ));
    return commands.some((command) => command.name === parsed.command) ? parsed : null;
  } catch {
    return null;
  }
}

function formatOpenCodeCommandModel(parsedModel) {
  if (!parsedModel?.providerID || !parsedModel?.modelID) {
    return '';
  }
  return `${parsedModel.providerID}/${parsedModel.modelID}`;
}

function normalizeOpenCodeAgent(rawAgent, configPayload = {}) {
  const candidate = asRecord(rawAgent);
  const name = pickString(candidate.name, candidate.id);
  if (!name || !isSafeOpenCodeAgentName(name)) {
    return null;
  }

  const mode = pickString(candidate.mode) || 'all';
  if (mode === 'subagent' || candidate.hidden === true) {
    return null;
  }

  const configuredDefault = typeof configPayload?.default_agent === 'string'
    ? configPayload.default_agent.trim()
    : '';
  const isDefault = configuredDefault ? name === configuredDefault : name === 'build';
  const description = pickString(candidate.description) || `${mode} opencode agent`;

  return {
    id: `${OPENCODE_AGENT_PREFIX}${name}`,
    name,
    label: name,
    description,
    provider: 'opencode',
    agentID: name,
    mode,
    prompt: `${OPENCODE_AGENT_PREFIX}${name}`,
    isDefault,
    native: candidate.native === true || candidate.builtIn === true
  };
}

function normalizeOpenCodeAgents(agentPayload = [], configPayload = {}) {
  const configuredDefault = typeof configPayload?.default_agent === 'string'
    ? configPayload.default_agent.trim()
    : '';
  const agents = [{
    id: OPENCODE_DEFAULT_AGENT_ID,
    name: 'opencode default',
    label: 'opencode default',
    description: configuredDefault
      ? `Uses ${configuredDefault} from opencode config.`
      : 'Uses the default agent configured in opencode.',
    provider: 'opencode',
    agentID: '',
    mode: 'primary',
    isDefault: true,
    native: true
  }];
  const seen = new Set(agents.map((agent) => agent.id));

  for (const rawAgent of Array.isArray(agentPayload) ? agentPayload : []) {
    const agent = normalizeOpenCodeAgent(rawAgent, configPayload);
    if (!agent || seen.has(agent.id)) {
      continue;
    }
    seen.add(agent.id);
    agents.push(agent);
  }

  for (const fallback of [
    {
      name: 'build',
      description: 'The default agent. Executes tools based on configured permissions.',
      mode: 'primary',
      native: true
    },
    {
      name: 'plan',
      description: 'Plan mode. Disallows all edit tools.',
      mode: 'primary',
      native: true
    }
  ]) {
    const agent = normalizeOpenCodeAgent(fallback, configPayload);
    if (!agent || seen.has(agent.id)) {
      continue;
    }
    seen.add(agent.id);
    agents.push(agent);
  }

  return agents;
}

function normalizeOpenCodeModels(providerPayload = {}, configPayload = {}) {
  const providers = getOpenCodeProviderList(providerPayload);
  const defaults = getOpenCodeProviderDefaults(providerPayload);
  const resolvedDefault = resolveOpenCodeDefaultModelId(providerPayload, configPayload);
  const models = [{
    id: 'opencode-default',
    label: 'opencode default',
    description: resolvedDefault.id
      ? `Uses ${resolvedDefault.id} ${resolvedDefault.source === 'config'
        ? 'from opencode config'
        : resolvedDefault.source === 'first-available'
          ? 'as first available model'
          : 'provider default'}.`
      : 'Uses the provider and model configured in opencode.',
    isDefault: true
  }];
  const seen = new Set(models.map((model) => model.id));

  for (const provider of providers) {
    if (!provider || typeof provider !== 'object' || !provider.id) {
      continue;
    }
    const providerID = String(provider.id);
    const providerName = provider.name ? String(provider.name) : providerID;
    const providerModels = provider.models && typeof provider.models === 'object'
      ? provider.models
      : {};

    for (const [modelKey, rawModel] of Object.entries(providerModels)) {
      const model = rawModel && typeof rawModel === 'object' ? rawModel : {};
      if (model.enabled === false) {
        continue;
      }
      const modelID = String(model.id || modelKey);
      if (!modelID) {
        continue;
      }
      const id = `${providerID}/${modelID}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      const label = model.name ? String(model.name) : modelID;
      const status = model.status && model.status !== 'active' ? ` · ${model.status}` : '';
      const defaultForProvider = defaults[providerID] === modelID;
      models.push({
        id,
        label,
        description: `${providerName}${defaultForProvider ? ' · provider default' : ''}${status}`,
        providerID,
        modelID,
        providerName,
        isDefault: false,
        isProviderDefault: defaultForProvider
      });
    }
  }

  return models;
}

function getOpenCodeProviderList(providerPayload = {}) {
  return Array.isArray(providerPayload?.providers)
    ? providerPayload.providers
    : Array.isArray(providerPayload?.all)
      ? providerPayload.all
      : [];
}

function getOpenCodeProviderDefaults(providerPayload = {}) {
  return providerPayload?.default && typeof providerPayload.default === 'object'
    ? providerPayload.default
    : {};
}

function resolveOpenCodeDefaultModelId(providerPayload = {}, configPayload = {}) {
  const providers = getOpenCodeProviderList(providerPayload);
  const configuredDefault = typeof configPayload?.model === 'string'
    ? configPayload.model.trim()
    : '';
  if (configuredDefault && modelPayloadContains(providers, configuredDefault)) {
    return { id: configuredDefault, source: 'config' };
  }

  const defaultModel = firstProviderDefault(getOpenCodeProviderDefaults(providerPayload), providers);
  if (defaultModel) {
    return { id: defaultModel, source: 'provider-default' };
  }

  const availableModel = firstAvailableProviderModel(providers);
  return availableModel
    ? { id: availableModel, source: 'first-available' }
    : { id: '', source: '' };
}

function modelPayloadContains(providers, fullModelId) {
  const slash = fullModelId.indexOf('/');
  if (slash <= 0 || slash === fullModelId.length - 1) {
    return false;
  }
  const providerID = fullModelId.slice(0, slash);
  const modelID = fullModelId.slice(slash + 1);
  return providers.some((provider) => {
    if (!provider || String(provider.id) !== providerID) {
      return false;
    }
    const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
    return Object.entries(models).some(([modelKey, rawModel]) => {
      const model = rawModel && typeof rawModel === 'object' ? rawModel : {};
      return String(model.id || modelKey) === modelID && model.enabled !== false;
    });
  });
}

function firstProviderDefault(defaults, providers = []) {
  const entries = Object.entries(defaults)
    .map(([providerID, modelID]) => [String(providerID || '').trim(), String(modelID || '').trim()])
    .filter(([providerID, modelID]) => providerID && modelID);

  const providerOrder = providers.length > 0
    ? providers.map((p) => String(p?.id))
    : [];
  const orderMap = new Map(providerOrder.map((id, i) => [id, i]));

  entries.sort(([left], [right]) => {
    const li = orderMap.get(left) ?? orderMap.size;
    const ri = orderMap.get(right) ?? orderMap.size;
    if (li !== ri) return li - ri;
    return left.localeCompare(right);
  });

  for (const [providerID, modelID] of entries) {
    const fullModelId = `${providerID}/${modelID}`;
    if (!providers.length || modelPayloadContains(providers, fullModelId)) {
      return fullModelId;
    }
  }
  return '';
}

function firstAvailableProviderModel(providers = []) {
  const listedProviders = providers
    .filter((provider) => provider && typeof provider === 'object' && provider.id);

  for (const provider of listedProviders) {
    const providerID = String(provider.id);
    const providerModels = provider.models && typeof provider.models === 'object'
      ? provider.models
      : {};
    const [modelID] = Object.entries(providerModels)
      .map(([modelKey, rawModel]) => {
        const model = rawModel && typeof rawModel === 'object' ? rawModel : {};
        if (model.enabled === false) {
          return '';
        }
        return String(model.id || modelKey || '').trim();
      })
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    if (modelID) {
      return `${providerID}/${modelID}`;
    }
  }
  return '';
}

function connectedOpenCodeProviderPayload(providerPayload = {}) {
  const allProviders = Array.isArray(providerPayload?.all)
    ? providerPayload.all
    : getOpenCodeProviderList(providerPayload);
  const connected = Array.isArray(providerPayload?.connected)
    ? new Set(providerPayload.connected.map((providerID) => String(providerID)))
    : null;
  return {
    providers: connected
      ? allProviders.filter((provider) => provider?.id && connected.has(String(provider.id)))
      : allProviders,
    default: getOpenCodeProviderDefaults(providerPayload)
  };
}

function mergeOpenCodeProviderInfo(existing, incoming) {
  const existingModels = existing?.models && typeof existing.models === 'object' ? existing.models : {};
  const incomingModels = incoming?.models && typeof incoming.models === 'object' ? incoming.models : {};
  return {
    ...incoming,
    ...existing,
    models: {
      ...existingModels,
      ...incomingModels
    }
  };
}

function mergeOpenCodeProviderPayloads(...payloads) {
  const providers = new Map();
  const defaults = {};

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    Object.assign(defaults, getOpenCodeProviderDefaults(payload));
    for (const provider of getOpenCodeProviderList(payload)) {
      if (!provider || typeof provider !== 'object' || !provider.id) {
        continue;
      }
      const providerID = String(provider.id);
      providers.set(
        providerID,
        providers.has(providerID)
          ? mergeOpenCodeProviderInfo(providers.get(providerID), provider)
          : provider
      );
    }
  }

  return {
    providers: Array.from(providers.values()),
    default: defaults
  };
}

async function listOpenCodeModelProviders(client, query) {
  let configuredProviders;
  let configProvidersError;
  try {
    configuredProviders = await unwrapSdkResult(
      client.config.providers({ query }),
      'list opencode config providers'
    );
  } catch (error) {
    configProvidersError = error;
  }

  if (typeof client?.provider?.list === 'function') {
    try {
      const payload = await unwrapSdkResult(
        client.provider.list({ query }),
        'list opencode providers'
      );
      const connectedProviders = connectedOpenCodeProviderPayload(payload);
      if (getOpenCodeProviderList(connectedProviders).length > 0) {
        return mergeOpenCodeProviderPayloads(connectedProviders, configuredProviders);
      }
    } catch {
      // Older opencode servers may not expose provider.list.
    }
  }

  if (configuredProviders) {
    return configuredProviders;
  }
  throw configProvidersError || new Error('opencode provider discovery returned no providers');
}

async function resolveOpenCodeDefaultModel(client, cwd) {
  const query = directoryQuery(cwd);
  const [config, providers] = await Promise.all([
    unwrapSdkResult(
      client.config.get({ query }),
      'get opencode config'
    ).catch(() => ({})),
    listOpenCodeModelProviders(client, query).catch(() => ({}))
  ]);
  const configured = typeof config?.model === 'string' ? config.model.trim() : '';
  const providerList = Array.isArray(providers?.providers)
    ? providers.providers
    : Array.isArray(providers?.all)
      ? providers.all
      : [];
  if (configured && modelPayloadContains(providerList, configured)) {
    return parseOpenCodeModel(configured);
  }
  const defaults = providers?.default && typeof providers.default === 'object' ? providers.default : {};
  return parseOpenCodeModel(firstProviderDefault(defaults, providerList) || firstAvailableProviderModel(providerList));
}

async function resolveOpenCodePromptModel(client, cwd, selectedModel) {
  const parsedModel = parseOpenCodeModel(selectedModel);
  if (parsedModel) {
    return parsedModel;
  }
  return resolveOpenCodeDefaultModel(client, cwd);
}

function normalizeOpenCodeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function normalizeOpenCodeMessageCount(session, sessionId, messageCounts) {
  const directCount = Number.parseInt(session?.messageCount, 10);
  if (Number.isFinite(directCount) && directCount >= 0) {
    return directCount;
  }

  if (messageCounts instanceof Map && messageCounts.has(sessionId)) {
    const mappedCount = Number.parseInt(messageCounts.get(sessionId), 10);
    return Number.isFinite(mappedCount) && mappedCount >= 0 ? mappedCount : 0;
  }

  return 0;
}

function normalizeOpenCodeSession(rawSession, messageCounts) {
  const session = asRecord(rawSession);
  const sessionId = pickString(session.id, session.sessionID, session.sessionId);
  if (!sessionId) {
    return null;
  }

  const time = asRecord(session.time);
  const model = asRecord(session.model);
  const summary = asRecord(session.summary);
  const lastTimestamp = normalizeOpenCodeTimestamp(
    time.updated ?? session.updated ?? time.created ?? session.created
  );
  const firstTimestamp = normalizeOpenCodeTimestamp(
    time.created ?? session.created ?? time.updated ?? session.updated
  );
  const messageCount = normalizeOpenCodeMessageCount(session, sessionId, messageCounts);

  const normalized = {
    sessionId,
    title: pickString(session.title, session.slug, sessionId),
    messageCount,
    lastTimestamp,
    firstTimestamp,
    fileSize: 0,
    provider: 'opencode',
    cwd: pickString(session.directory, session.cwd)
  };

  if (model.id || model.providerID || session.agent || session.path || summary.files) {
    normalized.opencode = {
      model,
      agent: pickString(session.agent),
      path: pickString(session.path),
      summary
    };
  }

  return normalized;
}

function normalizeOpenCodeSessions(sessionPayload = [], messageCounts = new Map()) {
  const sessionsById = new Map();

  for (const rawSession of Array.isArray(sessionPayload) ? sessionPayload : []) {
    const candidate = asRecord(rawSession);
    if (candidate.parentID || candidate.parentId) {
      continue;
    }

    const session = normalizeOpenCodeSession(candidate, messageCounts);
    if (!session) {
      continue;
    }

    const existing = sessionsById.get(session.sessionId);
    if (!existing || (session.lastTimestamp || 0) > (existing.lastTimestamp || 0)) {
      sessionsById.set(session.sessionId, session);
    }
  }

  return Array.from(sessionsById.values()).sort((left, right) => (
    (right.lastTimestamp || 0) - (left.lastTimestamp || 0)
  ));
}

function redactRecordValues(record) {
  const source = asRecord(record);
  return Object.fromEntries(Object.keys(source).map((key) => [key, '***']));
}

function normalizeOpenCodeMcpServerSpec(config) {
  const serverConfig = asRecord(config);
  const type = typeof serverConfig.type === 'string' ? serverConfig.type : '';

  if (type === 'local') {
    const commandParts = Array.isArray(serverConfig.command)
      ? serverConfig.command.map((part) => String(part)).filter(Boolean)
      : [];
    const spec = {
      type: 'stdio',
      command: commandParts[0] || '',
      args: commandParts.slice(1)
    };
    if (serverConfig.environment) {
      spec.env = redactRecordValues(serverConfig.environment);
    }
    if (serverConfig.timeout !== undefined) {
      spec.timeout = serverConfig.timeout;
    }
    return spec;
  }

  if (type === 'remote') {
    const spec = {
      type: 'http',
      url: typeof serverConfig.url === 'string' ? serverConfig.url : ''
    };
    if (serverConfig.headers) {
      spec.headers = redactRecordValues(serverConfig.headers);
    }
    if (serverConfig.timeout !== undefined) {
      spec.timeout = serverConfig.timeout;
    }
    return spec;
  }

  return {};
}

function normalizeOpenCodeMcpStatus(statusValue, configValue = {}) {
  const status = asRecord(statusValue);
  const config = asRecord(configValue);
  const rawStatus = typeof status.status === 'string'
    ? status.status
    : config.enabled === false
      ? 'disabled'
      : 'unknown';

  switch (rawStatus) {
    case 'connected':
      return 'connected';
    case 'failed':
      return 'failed';
    case 'needs_auth':
    case 'needs_client_registration':
      return 'needs-auth';
    case 'disabled':
    default:
      return 'pending';
  }
}

function normalizeOpenCodeMcpError(statusValue) {
  const status = asRecord(statusValue);
  return pickString(status.error, status.message);
}

function sanitizeOpenCodeMcpConfig(config) {
  const serverConfig = asRecord(config);
  const sanitized = {};
  if (typeof serverConfig.type === 'string') {
    sanitized.type = serverConfig.type;
  }
  if (serverConfig.enabled !== undefined) {
    sanitized.enabled = serverConfig.enabled;
  }
  if (serverConfig.timeout !== undefined) {
    sanitized.timeout = serverConfig.timeout;
  }
  return sanitized;
}

function sanitizeOpenCodeMcpIdentifier(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeOpenCodeToolSchema(tool) {
  const candidate = tool?.inputSchema || tool?.parameters || tool?.jsonSchema;
  const schema = asRecord(candidate);
  return Object.keys(schema).length > 0 ? schema : undefined;
}

function normalizeOpenCodeMcpTools(serverId, toolPayload = []) {
  const prefix = `${sanitizeOpenCodeMcpIdentifier(serverId)}_`;
  return (Array.isArray(toolPayload) ? toolPayload : [])
    .map((rawTool) => {
      const tool = asRecord(rawTool);
      const id = pickString(tool.id, tool.name);
      if (!id || !id.startsWith(prefix)) {
        return null;
      }

      const name = id.slice(prefix.length) || id;
      const normalized = {
        name,
        description: pickString(tool.description)
      };
      const inputSchema = normalizeOpenCodeToolSchema(tool);
      if (inputSchema) {
        normalized.inputSchema = inputSchema;
      }
      return normalized;
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeOpenCodeMcpToolIds(serverId, idsPayload = []) {
  const prefix = `${sanitizeOpenCodeMcpIdentifier(serverId)}_`;
  return (Array.isArray(idsPayload) ? idsPayload : [])
    .map((id) => String(id || ''))
    .filter((id) => id.startsWith(prefix))
    .map((id) => ({ name: id.slice(prefix.length) || id }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeOpenCodeMcpProbeConfig(config) {
  const serverConfig = asRecord(config);
  if (serverConfig.type === 'local') {
    const commandParts = Array.isArray(serverConfig.command)
      ? serverConfig.command.map((part) => String(part)).filter(Boolean)
      : [];
    return {
      type: 'stdio',
      command: commandParts[0] || '',
      args: commandParts.slice(1),
      env: asRecord(serverConfig.environment),
      timeout: serverConfig.timeout
    };
  }

  if (serverConfig.type === 'remote') {
    return {
      type: 'http',
      url: typeof serverConfig.url === 'string' ? serverConfig.url : '',
      headers: asRecord(serverConfig.headers),
      timeout: serverConfig.timeout
    };
  }

  return {};
}

function normalizeOpenCodeMcpServers(configPayload = {}, statusPayload = {}) {
  const mcpConfig = asRecord(configPayload?.mcp);
  const statuses = asRecord(statusPayload);
  const ids = Array.from(new Set([
    ...Object.keys(mcpConfig),
    ...Object.keys(statuses)
  ])).sort((left, right) => left.localeCompare(right));

  return ids.map((id) => {
    const config = asRecord(mcpConfig[id]);
    const status = asRecord(statuses[id]);
    const enabled = config.enabled !== false && status.status !== 'disabled';
    return {
      id,
      name: id,
      server: normalizeOpenCodeMcpServerSpec(config),
      apps: {
        claude: false,
        codex: false,
        gemini: false,
        opencode: true
      },
      enabled,
      readOnly: true,
      provider: 'opencode',
      opencode: {
        status,
        config: sanitizeOpenCodeMcpConfig(config)
      }
    };
  });
}

function normalizeOpenCodeMcpStatusList(configPayload = {}, statusPayload = {}) {
  const mcpConfig = asRecord(configPayload?.mcp);
  const statuses = asRecord(statusPayload);
  const ids = Array.from(new Set([
    ...Object.keys(mcpConfig),
    ...Object.keys(statuses)
  ])).sort((left, right) => left.localeCompare(right));

  return ids.map((id) => {
    const status = asRecord(statuses[id]);
    const normalized = {
      name: id,
      status: normalizeOpenCodeMcpStatus(status, mcpConfig[id]),
      opencode: status
    };
    const error = normalizeOpenCodeMcpError(status);
    if (error) {
      normalized.error = error;
    }
    return normalized;
  });
}

async function countOpenCodeSessionMessages(client, cwd, sessionId) {
  try {
    const messages = await unwrapSdkResult(
      client.session.messages({
        path: { id: sessionId },
        query: directoryQuery(cwd)
      }),
      'count opencode session messages'
    );
    return Array.isArray(messages) ? messages.length : 0;
  } catch {
    return 0;
  }
}

async function countOpenCodeHistoryMessages(client, cwd, sessions) {
  if (!shouldCountOpenCodeHistoryMessages() || !Array.isArray(sessions) || sessions.length === 0) {
    return new Map();
  }

  const sessionIds = Array.from(new Set(
    sessions
      .map((session) => pickString(session?.id, session?.sessionID, session?.sessionId))
      .filter(Boolean)
  ));
  const concurrency = parsePositiveInteger(
    process.env.OPENCODE_HISTORY_COUNT_CONCURRENCY,
    DEFAULT_HISTORY_COUNT_CONCURRENCY
  );
  const counts = await mapWithConcurrency(sessionIds, concurrency, async (sessionId) => [
    sessionId,
    await countOpenCodeSessionMessages(client, cwd, sessionId)
  ]);

  return new Map(counts);
}

function sanitizeAttachmentName(name, index) {
  const candidate = typeof name === 'string' && name.trim()
    ? basename(name.trim()).replace(/[\\/:*?"<>|]/g, '_')
    : `attachment-${index + 1}`;
  return candidate || `attachment-${index + 1}`;
}

async function buildPromptParts(message, attachments) {
  const parts = [];
  const text = typeof message === 'string' ? message : '';
  const validAttachments = Array.isArray(attachments) ? attachments : [];
  let attachmentDir = null;

  if (text || validAttachments.length === 0) {
    parts.push({ type: 'text', text });
  }

  for (let i = 0; i < validAttachments.length; i++) {
    const attachment = validAttachments[i];
    if (!attachment || !attachment.data) {
      continue;
    }

    if (!attachmentDir) {
      attachmentDir = await mkdtemp(join(tmpdir(), 'opencode-attachments-'));
    }

    const filename = sanitizeAttachmentName(attachment.fileName, i);
    const path = join(attachmentDir, filename);
    await writeFile(path, Buffer.from(String(attachment.data), 'base64'));
    parts.push({
      type: 'file',
      mime: attachment.mediaType || 'application/octet-stream',
      filename,
      url: pathToFileURL(path).href
    });
  }

  return {
    parts,
    cleanup: async () => {
      if (attachmentDir) {
        await rm(attachmentDir, { recursive: true, force: true });
      }
    }
  };
}

function withDirectory(url, cwd) {
  if (cwd && cwd.trim()) {
    url.searchParams.set('directory', cwd.trim());
  }
  return url;
}

async function postJson(baseUrl, path, cwd, body = undefined) {
  const url = withDirectory(new URL(path, baseUrl), cwd);
  const headers = {
    'Content-Type': 'application/json',
    ...(buildAuthHeaders() || {})
  };
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    throw new Error(`${path} failed with HTTP ${response.status}: ${responseText || response.statusText}`);
  }
}

async function getJsonWithTimeout(baseUrl, path, cwd, timeoutMs, query = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = withDirectory(new URL(path, baseUrl), cwd);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && String(value).trim()) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: buildAuthHeaders() || {},
      signal: controller.signal
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new Error(`${path} failed with HTTP ${response.status}: ${responseText || response.statusText}`);
    }

    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${path} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function replyToPermission(runtime, cwd, permission, permissionMode) {
  const requestId = permission?.id || permission?.requestID || permission?.permissionID;
  if (!requestId) {
    return;
  }

  const label = permission.permission || permission.patterns?.join(', ') || requestId;
  let body;
  if (shouldAutoAllowOpenCodePermission(permission.permission, permissionMode)) {
    body = { reply: 'once' };
  } else if (shouldAutoRejectOpenCodePermission(permission.permission, permissionMode)) {
    body = { reply: 'reject', message: PLAN_MODE_PERMISSION_DENIED };
  } else {
    const dialogRequest = buildOpenCodePermissionDialogRequest(permission, cwd);
    const allowed = await requestPermissionFromJava(dialogRequest.toolName, dialogRequest.inputs);
    body = allowed
      ? { reply: 'once' }
      : { reply: 'reject', message: `User denied permission for ${dialogRequest.toolName} tool` };
  }

  await postJson(
    runtime.baseUrl,
    `/permission/${encodeURIComponent(requestId)}/reply`,
    cwd,
    body
  );

  emitStatus(body.reply === 'once'
    ? `Allowed opencode permission once: ${label}`
    : `Rejected opencode permission: ${label}`);
}

async function replyToQuestion(runtime, cwd, questionEvent) {
  const requestId = questionEvent?.id || questionEvent?.requestID || questionEvent?.questionID;
  if (!requestId) {
    return;
  }

  const questions = questionEvent?.questions || [];
  const header = typeof questionEvent?.header === 'string' ? questionEvent.header : '';

  const normalizedQuestions = questions
    .map((q) => {
      if (!q || typeof q !== 'object') return null;
      const questionText = typeof q.question === 'string' ? q.question : '';
      const questionHeader = typeof q.header === 'string' ? q.header : (header || '');
      const multiSelect = q.multiple === true || q.multiSelect === true;
      const options = Array.isArray(q.options) ? q.options.map((opt) => {
        if (typeof opt === 'string') return { label: opt, description: '' };
        return {
          label: typeof opt?.label === 'string' ? opt.label : '',
          description: typeof opt?.description === 'string' ? opt.description : ''
        };
      }).filter((opt) => opt.label) : [];
      if (!questionText) return null;
      return { question: questionText, header: questionHeader, options, multiSelect };
    })
    .filter(Boolean);

  if (normalizedQuestions.length === 0) {
    await postJson(
      runtime.baseUrl,
      `/question/${encodeURIComponent(requestId)}/reject`,
      cwd
    );
    emitStatus('Rejected opencode question request: no valid questions found.');
    return;
  }

  const input = {
    questions: normalizedQuestions
  };

  emitStatus('Showing opencode question dialog...');
  const answers = await requestAskUserQuestionAnswers(input);

  if (answers) {
    const replyBody = {
      answers: Array.isArray(answers) ? answers : []
    };
    await postJson(
      runtime.baseUrl,
      `/question/${encodeURIComponent(requestId)}/reply`,
      cwd,
      replyBody
    );
    emitStatus('Answered opencode question.');
  } else {
    await postJson(
      runtime.baseUrl,
      `/question/${encodeURIComponent(requestId)}/reject`,
      cwd
    );
    emitStatus('User cancelled opencode question dialog.');
  }
}

function partText(part) {
  if (!part || typeof part !== 'object') {
    return '';
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part.content === 'string') {
    return part.content;
  }
  if (typeof part.output === 'string') {
    return part.output;
  }
  return '';
}

function partKind(part) {
  const type = part?.type || part?.kind || '';
  return typeof type === 'string' ? type : '';
}

function isReasoningPart(kind) {
  return kind === 'reasoning' || kind === 'thinking';
}

function normalizeOpenCodeMessage(item) {
  const info = item?.info || item?.message || item;
  const role = info?.role === 'user' ? 'user' : 'assistant';
  const cwd = pickString(info?.path?.cwd, info?.path?.root, info?.cwd);
  const content = [];
  let toolUseResult;

  for (const part of item?.parts || []) {
    const kind = partKind(part);
    const text = partText(part);
    if (kind === 'tool') {
      const toolUseId = openCodeToolUseId(part);
      if (!toolUseId) {
        continue;
      }
      const syntheticDiffBlocks = syntheticDiffBlocksForTool(part, cwd);
      if (syntheticDiffBlocks.length > 0) {
        content.push(...syntheticDiffBlocks);
        continue;
      }
      const normalizedInput = normalizeOpenCodeToolInput(part, cwd);
      content.push({
        type: 'tool_use',
        id: toolUseId,
        name: normalizeOpenCodeToolName(part.tool),
        input: normalizedInput
      });

      const status = part?.state?.status;
      if (status === 'completed' || status === 'error') {
        const resultMetadata = openCodeToolResultMetadata(part, normalizedInput);
        if (resultMetadata && !toolUseResult) {
          toolUseResult = resultMetadata;
        }
        content.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: isOpenCodeToolResultError(part),
          content: openCodeToolResultContent(part)
        });
      }
      continue;
    }

    if (kind === 'file') {
      const url = pickString(part.url);
      const mime = pickString(part.mime, part.mimeType) || 'application/octet-stream';
      const filename = pickString(part.filename, part.name) || 'file';
      if (mime.startsWith('image/') && url) {
        content.push({
          type: 'image',
          source: {
            type: 'url',
            url,
            media_type: mime
          }
        });
      } else {
        content.push({
          type: 'attachment',
          fileName: filename,
          mediaType: mime
        });
      }
      continue;
    }

    if (!text || (kind !== 'text' && !isReasoningPart(kind))) {
      continue;
    }
    content.push({
      type: isReasoningPart(kind) ? 'thinking' : 'text',
      text
    });
  }

  const normalized = {
    type: role,
    message: {
      id: info?.id || info?.messageID || '',
      role,
      content
    },
    opencode: {
      info,
      parts: item?.parts || []
    }
  };
  if (toolUseResult) {
    normalized.toolUseResult = toolUseResult;
  }
  return normalized;
}

function emitAssistantMessageFromResponse(response) {
  const textParts = extractOpenCodeAssistantTextParts(response);
  if (textParts.length === 0) {
    return false;
  }

  emitMessage({
    type: 'assistant',
    message: {
      id: response.info?.id || '',
      role: 'assistant',
      content: textParts
    },
    opencode: response
  });
  return true;
}

function extractOpenCodeAssistantTextParts(response) {
  if (!response || !Array.isArray(response.parts)) {
    return [];
  }

  const textParts = [];
  for (const part of response.parts) {
    const kind = partKind(part);
    const text = partText(part);
    if (!text || (kind !== 'text' && !isReasoningPart(kind))) {
      continue;
    }
    textParts.push({
      type: isReasoningPart(kind) ? 'thinking' : 'text',
      text
    });
  }

  return textParts;
}

function extractOpenCodeAssistantText(response) {
  return extractOpenCodeAssistantTextParts(response)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function createEventContext(runtime, cwd, permissionMode, sessionRef) {
  return {
    runtime,
    cwd,
    permissionMode,
    sessionRef,
    partTypes: new Map(),
    emittedToolUseIds: new Set(),
    emittedToolResultIds: new Set(),
    toolUseSignatures: new Map(),
    emittedDiffIds: new Set(),
    repliedPermissions: new Set(),
    rejectedQuestions: new Set(),
    repliedQuestions: new Set(),
    streamedTextByPartId: new Map(),
    suppressedTextByPartId: new Map(),
    sawContentDelta: false,
    sawAssistantOutput: false,
    sawSendError: false,
    sawSessionIdle: false,
    sawTurnLive: false,
    eventStreamClosed: false,
    lastActivityAt: Date.now(),
    lastToolError: '',
    lastTextPartEndedWithoutWhitespace: false
  };
}

function markOpenCodeActivity(ctx) {
  ctx.lastActivityAt = Date.now();
}

function responseHasOpenCodeError(response) {
  return Boolean(response?.info?.error || response?.error);
}

function responseOpenCodeError(response) {
  return response?.info?.error || response?.error;
}

function responseHasAssistantText(response) {
  return extractOpenCodeAssistantTextParts(response).some((part) => (
    part.type === 'text' && typeof part.text === 'string' && part.text.trim()
  ));
}

function emitOpenCodePartTextTail(ctx, part) {
  const kind = partKind(part);
  if (kind !== 'text' && !isReasoningPart(kind)) {
    return false;
  }
  if (!part?.time?.end) {
    return false;
  }

  const text = partText(part);
  if (!text) {
    return false;
  }

  const partId = pickString(part.id, part.partID);
  if (partId) {
    const suppressed = ctx.suppressedTextByPartId.get(partId);
    if (suppressed) {
      ctx.suppressedTextByPartId.delete(partId);
      if (isReasoningPart(kind)) {
        emitThinkingDelta(suppressed);
      } else {
        let flushText = suppressed;
        if (ctx.lastTextPartEndedWithoutWhitespace && !suppressed.startsWith(' ')) {
          ctx.lastTextPartEndedWithoutWhitespace = false;
          flushText = ' ' + suppressed;
        }
        ctx.sawContentDelta = true;
        ctx.sawAssistantOutput = true;
        emitContentDelta(flushText);
        ctx.lastTextPartEndedWithoutWhitespace = !/\s$/.test(flushText);
      }
    }
  }

  const previous = partId ? ctx.streamedTextByPartId.get(partId) || '' : '';
  let delta = '';
  if (!previous) {
    delta = text;
  } else if (text.startsWith(previous)) {
    delta = text.slice(previous.length);
  }

  if (!delta) {
    if (partId) {
      ctx.streamedTextByPartId.set(partId, text);
    }
    if (!isReasoningPart(kind) && text) {
      ctx.lastTextPartEndedWithoutWhitespace = !/\s$/.test(text);
    }
    return false;
  }

  if (isReasoningPart(kind)) {
    emitThinkingDelta(delta);
  } else {
    ctx.sawContentDelta = true;
    ctx.sawAssistantOutput = true;
    emitContentDelta(delta);
    ctx.lastTextPartEndedWithoutWhitespace = !/\s$/.test(delta);
  }
  if (partId) {
    ctx.streamedTextByPartId.set(partId, text);
  }
  return true;
}

function emitOpenCodeEmptyResponseFallback(ctx) {
  const detail = ctx.lastToolError
    ? `Last failed tool: ${truncateForDisplay(ctx.lastToolError, 1000)}`
    : '';
  const text = [
    '[WARNING] OpenCode completed the turn without an assistant text response.',
    'Check the tool results above for the last visible output.',
    detail
  ].filter(Boolean).join('\n');

  emitMessage({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }]
    }
  });
  ctx.sawAssistantOutput = true;
}

async function waitForOpenCodeEventDrain(ctx, activeTurn) {
  const idleMs = parsePositiveInteger(
    process.env.OPENCODE_EVENT_DRAIN_IDLE_MS,
    DEFAULT_EVENT_DRAIN_IDLE_MS
  );
  while (!activeTurn.aborted && !ctx.sawSendError) {
    const idleFor = Date.now() - ctx.lastActivityAt;
    if (idleFor >= idleMs) {
      return;
    }
    await delay(Math.max(10, Math.min(50, idleMs - idleFor)));
  }
}

function isOpenCodeIdleStatus(status) {
  if (!status) {
    return false;
  }
  if (typeof status === 'string') {
    return status === 'idle';
  }
  return status?.type === 'idle';
}

async function pollOpenCodeSessionIdle(ctx) {
  const sessionId = ctx?.sessionRef?.id;
  const statusApi = ctx?.runtime?.client?.session?.status;
  if (!sessionId || typeof statusApi !== 'function') {
    return undefined;
  }

  try {
    const statuses = await unwrapSdkResult(
      statusApi.call(ctx.runtime.client.session, { query: directoryQuery(ctx.cwd) }),
      'get opencode session status'
    );
    const status = statuses?.[sessionId];
    if (!status) {
      return undefined;
    }
    if (!isOpenCodeIdleStatus(status)) {
      ctx.sawTurnLive = true;
      return false;
    }
    return true;
  } catch {
    return undefined;
  }
}

async function waitForOpenCodeTurnIdle(ctx, activeTurn) {
  const pollMs = parsePositiveInteger(
    process.env.OPENCODE_SESSION_STATUS_POLL_MS,
    DEFAULT_SESSION_STATUS_POLL_MS
  );

  while (!activeTurn.aborted && !ctx.sawSendError) {
    if (ctx.sawSessionIdle && ctx.sawTurnLive) {
      await waitForOpenCodeEventDrain(ctx, activeTurn);
      return;
    }

    const idle = await pollOpenCodeSessionIdle(ctx);
    if (idle === true && ctx.sawTurnLive) {
      await waitForOpenCodeEventDrain(ctx, activeTurn);
      return;
    }

    if (idle === undefined && ctx.eventStreamClosed && ctx.sawTurnLive) {
      await waitForOpenCodeEventDrain(ctx, activeTurn);
      return;
    }

    await delay(Math.max(10, pollMs));
  }
}

function eventProperties(event) {
  return event?.properties || event?.payload?.properties || {};
}

function eventType(event) {
  return event?.type || event?.payload?.type || '';
}

function eventSessionId(props) {
  return props.sessionID || props.sessionId || props.session?.id || props.part?.sessionID || '';
}

function shouldHandleSessionEvent(ctx, props) {
  const sessionId = eventSessionId(props);
  if (!sessionId || !ctx.sessionRef.id) {
    return true;
  }
  return sessionId === ctx.sessionRef.id;
}

function setSessionIfMissing(ctx, props) {
  const sessionId = eventSessionId(props);
  if (sessionId && !ctx.sessionRef.id) {
    ctx.sessionRef.id = sessionId;
    emitMarker('[THREAD_ID]', sessionId);
  }
}

async function handleOpenCodeEvent(event, ctx) {
  const type = eventType(event);
  const props = eventProperties(event);
  if (!type) {
    return;
  }

  if (type === 'server.connected' || type === 'server.heartbeat') {
    return;
  }

  setSessionIfMissing(ctx, props);
  if (!shouldHandleSessionEvent(ctx, props)) {
    return;
  }
  markOpenCodeActivity(ctx);

  switch (type) {
    case 'session.status': {
      if (isOpenCodeIdleStatus(props.status)) {
        ctx.sawSessionIdle = true;
      } else {
        ctx.sawTurnLive = true;
        ctx.sawSessionIdle = false;
      }
      break;
    }

    case 'session.idle': {
      ctx.sawSessionIdle = true;
      break;
    }

    case 'message.part.updated': {
      ctx.sawTurnLive = true;
      const part = props.part || {};
      if (part.id) {
        ctx.partTypes.set(part.id, partKind(part));
      }

      if (part.type === 'tool' && part.tool) {
        const normalizedInput = normalizeOpenCodeToolInput(part, ctx.cwd);
        emitOpenCodeToolUse(ctx, part, normalizedInput);
        emitOpenCodeToolResult(ctx, part, normalizedInput);
        if (part.state?.status === 'completed' || part.state?.status === 'error') {
          const fileDiffs = openCodeToolDiffs(part);
          if (shouldEmitSyntheticDiffForTool(part, normalizedInput)) {
            emitOpenCodeDiffMessages(ctx, fileDiffs, `tool:${openCodeToolUseId(part) || part.id || part.tool}`);
          }
        }

        const resultStatus = isOpenCodeToolResultError(part) ? 'error' : part.state?.status;
        const status = resultStatus ? ` (${resultStatus})` : '';
        emitStatus(`opencode tool: ${part.tool}${status}`);
      } else {
        emitOpenCodePartTextTail(ctx, part);
      }
      break;
    }

    case 'message.part.delta': {
      const isReasoningField = props.field === 'reasoning_content' || props.field === 'reasoning_details';
      if (props.field && props.field !== 'text' && !isReasoningField) {
        return;
      }
      const delta = typeof props.delta === 'string' ? props.delta : '';
      if (!delta) {
        return;
      }
      ctx.sawTurnLive = true;

      if (props.partID && isReasoningField && !ctx.partTypes.has(props.partID)) {
        ctx.partTypes.set(props.partID, 'reasoning');
      }

      const partType = ctx.partTypes.get(props.partID);
      const isReasoning = isReasoningField || isReasoningPart(partType);

      if (props.partID) {
        const previous = ctx.streamedTextByPartId.get(props.partID) || '';
        ctx.streamedTextByPartId.set(props.partID, previous + delta);

        if (partType === undefined) {
          const suppressed = ctx.suppressedTextByPartId.get(props.partID) || '';
          ctx.suppressedTextByPartId.set(props.partID, suppressed + delta);
          break;
        }

        const isNewTextPart = !previous && !isReasoning;
        if (isNewTextPart && ctx.lastTextPartEndedWithoutWhitespace && !delta.startsWith(' ')) {
          ctx.lastTextPartEndedWithoutWhitespace = false;
          ctx.sawContentDelta = true;
          ctx.sawAssistantOutput = true;
          emitContentDelta(' ');
        }

        const suppressed = ctx.suppressedTextByPartId.get(props.partID);
        if (suppressed) {
          ctx.suppressedTextByPartId.delete(props.partID);
          let flushText = suppressed;
          if (!isReasoning && ctx.lastTextPartEndedWithoutWhitespace && !suppressed.startsWith(' ')) {
            ctx.lastTextPartEndedWithoutWhitespace = false;
            flushText = ' ' + suppressed;
          }
          if (isReasoning) {
            emitThinkingDelta(flushText);
          } else {
            ctx.sawContentDelta = true;
            ctx.sawAssistantOutput = true;
            emitContentDelta(flushText);
            ctx.lastTextPartEndedWithoutWhitespace = !/\s$/.test(flushText);
          }
        }
      }
      if (isReasoning) {
        emitThinkingDelta(delta);
      } else {
        ctx.sawContentDelta = true;
        ctx.sawAssistantOutput = true;
        emitContentDelta(delta);
        ctx.lastTextPartEndedWithoutWhitespace = !/\s$/.test(delta);
      }
      break;
    }

    case 'message.updated': {
      const info = props.info || props.message || {};
      if (info.role === 'assistant') {
        ctx.sawTurnLive = true;
      }
      if (info.role === 'assistant' && info.error) {
        emitContextSendError(ctx, {
          code: 'OPENCODE_SESSION_ERROR',
          error: formatOpenCodeError(info.error, 'opencode assistant message failed')
        });
      }
      break;
    }

    case 'session.error': {
      ctx.sawTurnLive = true;
      emitContextSendError(ctx, {
        code: 'OPENCODE_SESSION_ERROR',
        error: formatOpenCodeError(props.error, 'opencode session error')
      });
      break;
    }

    case 'session.diff': {
      ctx.sawTurnLive = true;
      emitOpenCodeDiffMessages(ctx, props.diff, 'session.diff');
      break;
    }

    case 'permission.asked': {
      ctx.sawTurnLive = true;
      const requestId = props.id || props.requestID || props.permissionID;
      if (!requestId || ctx.repliedPermissions.has(requestId)) {
        return;
      }
      ctx.repliedPermissions.add(requestId);
      await replyToPermission(ctx.runtime, ctx.cwd, props, ctx.permissionMode);
      break;
    }

    case 'question.asked': {
      ctx.sawTurnLive = true;
      const questionRequestId = props.id || props.requestID || props.questionID;
      if (!questionRequestId || ctx.repliedQuestions.has(questionRequestId)) {
        return;
      }
      ctx.repliedQuestions.add(questionRequestId);
      await replyToQuestion(ctx.runtime, ctx.cwd, props);
      break;
    }

    default:
      break;
  }
}

async function consumeEvents(client, ctx, signal, onReady, onSubscribeError = undefined) {
  let subscription;
  let ready = false;
  try {
    subscription = await client.event.subscribe({
      query: directoryQuery(ctx.cwd),
      signal,
      sseMaxRetryAttempts: 1,
      onSseEvent: () => onReady()
    });

    ready = true;
    onReady();
    for await (const event of subscription.stream) {
      if (signal.aborted) {
        return;
      }
      await handleOpenCodeEvent(event, ctx);
    }
    ctx.eventStreamClosed = true;
  } catch (error) {
    ctx.eventStreamClosed = true;
    if (!signal.aborted) {
      const message = formatOpenCodeError(error, 'opencode event stream ended');
      emitStatus(`opencode event stream ended: ${message}`);
      if (!ready && typeof onSubscribeError === 'function') {
        onSubscribeError(error);
      }
    }
  }
}

async function createOrResolveSession(client, sessionId, cwd) {
  if (sessionId && sessionId.trim()) {
    return sessionId.trim();
  }

  const session = await unwrapSdkResult(
    client.session.create({
      query: directoryQuery(cwd),
      body: {}
    }),
    'create opencode session'
  );
  return extractSessionId(session);
}

export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  permissionMode = '',
  model = '',
  agent = '',
  attachments = [],
  options = {}
) {
  let runtime = null;
  let cleanupAttachments = async () => {};
  let eventAbortController = null;
  let eventTask = null;
  let eventContext = null;
  const activeTurn = {
    runtime: null,
    cwd,
    sessionId: sessionId && sessionId.trim() ? sessionId.trim() : '',
    eventAbortController: null,
    aborted: false
  };
  activeOpenCodeTurns.add(activeTurn);

  try {
    runtime = await acquireOpenCodeRuntime(cwd, options);
    activeTurn.runtime = runtime;

    const sessionRef = { id: sessionId && sessionId.trim() ? sessionId.trim() : '' };
    eventContext = createEventContext(runtime, cwd, permissionMode, sessionRef);
    eventAbortController = new AbortController();
    activeTurn.eventAbortController = eventAbortController;

    let readyEvents;
    let rejectEventReady;
    const eventReady = new Promise((resolve, reject) => {
      readyEvents = resolve;
      rejectEventReady = reject;
    });
    eventTask = consumeEvents(
      runtime.client,
      eventContext,
      eventAbortController.signal,
      readyEvents,
      rejectEventReady
    );
    await eventReady;

    sessionRef.id = await createOrResolveSession(runtime.client, sessionRef.id, cwd);
    activeTurn.sessionId = sessionRef.id;
    if (!sessionRef.id) {
      throw new Error('opencode did not return a session id');
    }
    if (activeTurn.aborted) {
      throw new Error('User interrupted');
    }

    emitMarker('[THREAD_ID]', sessionRef.id);
    emitMarker('[MESSAGE_START]');
    emitMarker('[STREAM_START]');

    const parsedModel = await resolveOpenCodePromptModel(runtime.client, cwd, model);
    const slashCommand = await resolveOpenCodeSlashCommand(runtime.client, cwd, message);
    const promptParts = await buildPromptParts(slashCommand ? '' : message, attachments);
    cleanupAttachments = promptParts.cleanup;

    let response;
    eventContext.sawSessionIdle = false;
    eventContext.sawTurnLive = false;
    if (slashCommand) {
      const promptOptions = resolveOpenCodePromptOptions(permissionMode, agent);
      const fileParts = promptParts.parts.filter((part) => part.type === 'file');
      const commandBody = {
        command: slashCommand.command,
        arguments: slashCommand.arguments
      };
      const commandModel = formatOpenCodeCommandModel(parsedModel);
      if (commandModel) {
        commandBody.model = commandModel;
      }
      if (promptOptions.agent) {
        commandBody.agent = promptOptions.agent;
      }
      if (fileParts.length > 0) {
        commandBody.parts = fileParts;
      }

      response = await unwrapSdkResult(
        runtime.client.session.command({
          path: { id: sessionRef.id },
          query: directoryQuery(cwd),
          body: commandBody
        }),
        'send opencode command'
      );
      // session.command is a synchronous HTTP operation; if it returned, the
      // turn was definitely live even when the status entry has already cleared.
      eventContext.sawTurnLive = true;
    } else {
      const body = { parts: promptParts.parts };
      if (parsedModel) {
        body.model = parsedModel;
      }
      Object.assign(body, resolveOpenCodePromptOptions(permissionMode, agent));

      const useAsyncPrompt = typeof runtime.client.session.promptAsync === 'function';
      const promptApi = useAsyncPrompt
        ? runtime.client.session.promptAsync
        : runtime.client.session.prompt;
      response = await unwrapSdkResult(
        promptApi.call(runtime.client.session, {
          path: { id: sessionRef.id },
          query: directoryQuery(cwd),
          body
        }),
        useAsyncPrompt
          ? 'start opencode async prompt'
          : 'send opencode prompt'
      );
      if (!useAsyncPrompt) {
        // Older SDK fallback: the synchronous prompt call only returns after
        // the turn has run, so a missing status entry can be considered done.
        eventContext.sawTurnLive = true;
      }
    }

    if (responseHasOpenCodeError(response)) {
      emitContextSendError(eventContext, {
        code: 'OPENCODE_SESSION_ERROR',
        error: formatOpenCodeError(responseOpenCodeError(response), 'opencode assistant message failed')
      });
    }

    if (!eventContext.sawContentDelta) {
      eventContext.sawAssistantOutput = emitAssistantMessageFromResponse(response)
        || eventContext.sawAssistantOutput;
    } else if (responseHasAssistantText(response)) {
      eventContext.sawAssistantOutput = true;
    }

    await waitForOpenCodeTurnIdle(eventContext, activeTurn);

    if (!eventContext.sawSendError && !eventContext.sawAssistantOutput) {
      emitOpenCodeEmptyResponseFallback(eventContext);
    }

    // Keep UI cleanup markers aligned with Claude/Codex, including error turns.
    emitMarker('[STREAM_END]');
    emitMarker('[MESSAGE_END]');
  } catch (error) {
    if (!activeTurn.aborted) {
      emitContextSendError(eventContext, normalizeOpenCodeSdkError(error));
      emitMarker('[STREAM_END]');
      emitMarker('[MESSAGE_END]');
    }
  } finally {
    activeOpenCodeTurns.delete(activeTurn);
    if (eventAbortController) {
      eventAbortController.abort();
    }
    if (eventTask) {
      await eventTask.catch(() => {});
    }
    await cleanupAttachments().catch(() => {});
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function abortSession(sessionId = '', cwd = '', options = {}) {
  let runtime = null;
  try {
    const normalizedSessionId = sessionId && sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error('sessionId is required to abort an opencode session');
    }

    runtime = await acquireOpenCodeRuntime(cwd, options);
    await unwrapSdkResult(
      runtime.client.session.abort({
        path: { id: normalizedSessionId },
        query: directoryQuery(cwd)
      }),
      'abort opencode session'
    );

    console.log(JSON.stringify({ success: true, sessionId: normalizedSessionId }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      sessionId
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function deleteSession(sessionId = '', cwd = '', options = {}) {
  let runtime = null;
  try {
    const normalizedSessionId = sessionId && sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error('sessionId is required to delete an opencode session');
    }

    runtime = await acquireOpenCodeRuntime(cwd, options);
    await unwrapSdkResult(
      runtime.client.session.delete({
        path: { id: normalizedSessionId },
        query: directoryQuery(cwd)
      }),
      'delete opencode session'
    );

    console.log(JSON.stringify({ success: true, sessionId: normalizedSessionId }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      sessionId
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function getSessionMessages(sessionId = '', cwd = '', options = {}) {
  let runtime = null;
  try {
    const normalizedSessionId = sessionId && sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error('sessionId is required to get opencode session messages');
    }

    runtime = await acquireOpenCodeRuntime(cwd, options);
    const messages = await unwrapSdkResult(
      runtime.client.session.messages({
        path: { id: normalizedSessionId },
        query: directoryQuery(cwd)
      }),
      'get opencode session messages'
    );

    console.log(JSON.stringify({
      success: true,
      sessionId: normalizedSessionId,
      messages: Array.isArray(messages) ? messages.map(normalizeOpenCodeMessage) : []
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      sessionId
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function listSessions(cwd = '', options = {}) {
  let runtime = null;
  try {
    runtime = await acquireOpenCodeRuntime(cwd, options);
    const sessions = await unwrapSdkResult(
      runtime.client.session.list({
        query: historyListQuery(cwd)
      }),
      'list opencode sessions'
    );
    const messageCounts = await countOpenCodeHistoryMessages(runtime.client, cwd, sessions);
    const normalizedSessions = normalizeOpenCodeSessions(sessions, messageCounts);

    console.log(JSON.stringify({
      success: true,
      cwd,
      sessions: normalizedSessions,
      total: normalizedSessions.reduce((sum, session) => sum + (session.messageCount || 0), 0)
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      sessions: [],
      total: 0
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function listModels(cwd = '', options = {}) {
  let runtime = null;
  try {
    runtime = await acquireOpenCodeRuntime(cwd, options);
    const query = directoryQuery(cwd);
    const [config, providers] = await Promise.all([
      unwrapSdkResult(
        runtime.client.config.get({ query }),
        'get opencode config'
      ),
      listOpenCodeModelProviders(runtime.client, query)
    ]);
    const resolvedDefault = resolveOpenCodeDefaultModelId(providers, config);
    const models = normalizeOpenCodeModels(providers, config);

    console.log(JSON.stringify({
      success: true,
      cwd,
      defaultModel: resolvedDefault.id,
      models
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      models: normalizeOpenCodeModels()
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function listAgents(cwd = '', options = {}) {
  let runtime = null;
  try {
    runtime = await acquireOpenCodeRuntime(cwd, options);
    const query = directoryQuery(cwd);
    const [config, agents] = await Promise.all([
      unwrapSdkResult(
        runtime.client.config.get({ query }),
        'get opencode config'
      ),
      unwrapSdkResult(
        runtime.client.app.agents({ query }),
        'list opencode agents'
      )
    ]);

    console.log(JSON.stringify({
      success: true,
      cwd,
      defaultAgent: typeof config?.default_agent === 'string' ? config.default_agent : '',
      agents: normalizeOpenCodeAgents(agents, config)
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      agents: normalizeOpenCodeAgents()
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function listCommands(cwd = '', options = {}) {
  let runtime = null;
  try {
    runtime = await acquireOpenCodeRuntime(cwd, options);
    const commands = await unwrapSdkResult(
      runtime.client.command.list({ query: directoryQuery(cwd) }),
      'list opencode commands'
    );

    console.log(JSON.stringify({
      success: true,
      cwd,
      commands: normalizeOpenCodeCommands(commands)
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      commands: []
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function listMcpServers(cwd = '', options = {}) {
  let runtime = null;
  try {
    runtime = await acquireOpenCodeRuntime(cwd, options);
    const query = directoryQuery(cwd);
    const config = await unwrapSdkResult(
      runtime.client.config.get({ query }),
      'get opencode config'
    );

    console.log(JSON.stringify({
      success: true,
      cwd,
      servers: normalizeOpenCodeMcpServers(config, {}),
      status: normalizeOpenCodeMcpStatusList(config, {})
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      servers: [],
      status: []
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function listMcpServerStatus(cwd = '', options = {}) {
  let runtime = null;
  try {
    runtime = await acquireOpenCodeRuntime(cwd, options);
    const query = directoryQuery(cwd);
    const config = await unwrapSdkResult(
      runtime.client.config.get({ query }),
      'get opencode config'
    ).catch(() => ({}));
    const timeoutMs = parsePositiveInteger(
      process.env.OPENCODE_MCP_STATUS_TIMEOUT_MS,
      DEFAULT_MCP_STATUS_TIMEOUT_MS
    );
    const status = await getJsonWithTimeout(runtime.baseUrl, '/mcp', cwd, timeoutMs);

    console.log(JSON.stringify({
      success: true,
      cwd,
      status: normalizeOpenCodeMcpStatusList(config, status)
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      status: []
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export async function getMcpServerTools(serverId = '', cwd = '', options = {}) {
  const id = typeof serverId === 'string' ? serverId.trim() : '';
  if (!id) {
    console.log(JSON.stringify({
      success: false,
      serverId: '',
      error: 'Missing serverId',
      tools: []
    }));
    return;
  }

  let runtime = null;
  const errors = [];
  try {
    runtime = await acquireOpenCodeRuntime(cwd, options);
    const query = directoryQuery(cwd);
    const [config, providers] = await Promise.all([
      unwrapSdkResult(
        runtime.client.config.get({ query }),
        'get opencode config'
      ),
      listOpenCodeModelProviders(runtime.client, query).catch((error) => {
        errors.push(`provider discovery failed: ${normalizeOpenCodeSdkError(error).error}`);
        return {};
      })
    ]);

    const timeoutMs = parsePositiveInteger(
      process.env.OPENCODE_MCP_TOOLS_TIMEOUT_MS,
      DEFAULT_MCP_STATUS_TIMEOUT_MS
    );
    const resolvedModel = parseOpenCodeModel(resolveOpenCodeDefaultModelId(providers, config).id);

    if (resolvedModel) {
      try {
        const tools = normalizeOpenCodeMcpTools(
          id,
          await getJsonWithTimeout(runtime.baseUrl, '/experimental/tool', cwd, timeoutMs, {
            provider: resolvedModel.providerID,
            model: resolvedModel.modelID
          })
        );
        if (tools.length > 0) {
          const result = {
            success: true,
            serverId: id,
            serverName: id,
            tools,
            source: 'opencode-experimental-tool'
          };
          console.log(JSON.stringify(result));
          return;
        }
      } catch (error) {
        errors.push(`/experimental/tool failed: ${normalizeOpenCodeSdkError(error).error}`);
      }
    } else {
      errors.push('No concrete opencode provider/model available for /experimental/tool');
    }

    try {
      const tools = normalizeOpenCodeMcpToolIds(
        id,
        await getJsonWithTimeout(runtime.baseUrl, '/experimental/tool/ids', cwd, timeoutMs)
      );
      if (tools.length > 0) {
        const result = {
          success: true,
          serverId: id,
          serverName: id,
          tools,
          source: 'opencode-experimental-tool-ids'
        };
        console.log(JSON.stringify(result));
        return;
      }
    } catch (error) {
      errors.push(`/experimental/tool/ids failed: ${normalizeOpenCodeSdkError(error).error}`);
    }

    if (!runtime.ownedServer) {
      throw new Error('OpenCode experimental tool endpoints did not expose MCP tools; direct config probing is disabled for external OpenCode servers');
    }

    const mcpConfig = asRecord(config?.mcp);
    const targetConfig = asRecord(mcpConfig[id]);
    if (!Object.keys(targetConfig).length) {
      throw new Error(`OpenCode MCP server not found: ${id}`);
    }
    if (targetConfig.enabled === false) {
      throw new Error(`OpenCode MCP server is disabled: ${id}`);
    }

    const probeConfig = normalizeOpenCodeMcpProbeConfig(targetConfig);
    const toolsResult = await getMcpServerToolsImpl(id, probeConfig);
    const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
    const hasError = !!toolsResult?.error;
    const result = {
      success: !hasError || tools.length > 0,
      serverId: id,
      serverName: toolsResult?.name || id,
      tools,
      error: toolsResult?.error || null,
      source: 'opencode-config-probe'
    };
    if (errors.length > 0) {
      result.experimentalErrors = errors;
    }

    console.log(JSON.stringify(result));
  } catch (error) {
    const message = normalizeOpenCodeSdkError(error).error;
    console.log(JSON.stringify({
      success: false,
      serverId: id,
      error: errors.length > 0 ? `${message}; ${errors.join('; ')}` : message,
      tools: []
    }));
  } finally {
    await releaseOpenCodeRuntime(runtime, options);
  }
}

export {
  createOpenCodeRuntime,
  directoryQuery,
  createEventContext,
  extractOpenCodeAssistantText,
  extractSessionId,
  handleOpenCodeEvent,
  listOpenCodeModelProviders,
  normalizeOpenCodeMessage,
  normalizeOpenCodeAgents,
  normalizeOpenCodeCommands,
  normalizeOpenCodeMcpServers,
  normalizeOpenCodeMcpStatusList,
  normalizeOpenCodeMcpTools,
  normalizeOpenCodeMcpToolIds,
  parseOpenCodeModel,
  releaseOpenCodeRuntime,
  normalizeOpenCodeModels,
  normalizeOpenCodeSessions,
  parseOpenCodeSlashCommand,
  resolveOpenCodePromptModel,
  unwrapSdkResult,
  waitForOpenCodeTurnIdle,
  resolveOpenCodePromptOptions
};
