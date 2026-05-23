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
import { basename, join } from 'path';
import { pathToFileURL } from 'url';

import { requestPermissionFromJava } from '../../permission-ipc.js';
import { ensureOpenCodeSdk, normalizeOpenCodeSdkError } from './opencode-utils.js';
import {
  buildOpenCodePermissionDialogRequest,
  shouldAutoAllowOpenCodePermission,
  shouldAutoRejectOpenCodePermission
} from './opencode-permissions.js';

const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_START_TIMEOUT_MS = 10000;
const MAX_TOOL_RESULT_CHARS = 20000;
const PLAN_MODE_PERMISSION_DENIED =
  'opencode permission denied because the chat is in plan mode.';

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

function toolUseMsg(id, name, input) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }]
    }
  };
}

function toolResultMsg(toolUseId, isError, content) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }]
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function directoryQuery(cwd) {
  return cwd && cwd.trim() ? { directory: cwd.trim() } : undefined;
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
  if (!error) {
    return fallback;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error.data && typeof error.data.message === 'string' && error.data.message) {
    return error.data.message;
  }
  if (typeof error.message === 'string' && error.message) {
    return error.message;
  }
  if (typeof error.name === 'string' && error.name) {
    return error.name;
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

function normalizeOpenCodeToolInput(part) {
  const state = asRecord(part?.state);
  const metadata = { ...asRecord(state.metadata), ...asRecord(part?.metadata) };
  const filediff = asRecord(metadata.filediff);
  const input = { ...asRecord(state.input) };

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
    input.file_path = filePath;
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

function emitOpenCodeToolUse(ctx, part) {
  if (!part || part.type !== 'tool') {
    return '';
  }
  const toolUseId = openCodeToolUseId(part);
  if (!toolUseId) {
    return '';
  }
  const toolName = normalizeOpenCodeToolName(part.tool);
  const input = normalizeOpenCodeToolInput(part);
  const signature = JSON.stringify({ toolName, input });
  if (!ctx.emittedToolUseIds.has(toolUseId) || ctx.toolUseSignatures.get(toolUseId) !== signature) {
    emitMessage(toolUseMsg(toolUseId, toolName, input));
    ctx.emittedToolUseIds.add(toolUseId);
    ctx.toolUseSignatures.set(toolUseId, signature);
  }
  return toolUseId;
}

function emitOpenCodeToolResult(ctx, part) {
  const toolUseId = emitOpenCodeToolUse(ctx, part);
  if (!toolUseId || ctx.emittedToolResultIds.has(toolUseId)) {
    return;
  }
  const status = part?.state?.status;
  if (status !== 'completed' && status !== 'error') {
    return;
  }
  emitMessage(toolResultMsg(
    toolUseId,
    status === 'error',
    openCodeToolResultContent(part)
  ));
  ctx.emittedToolResultIds.add(toolUseId);
}

function normalizeOpenCodeDiff(diff) {
  const candidate = asRecord(diff);
  const filePath = pickString(candidate.file, candidate.filePath, candidate.relativePath, candidate.path);
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
    const diff = normalizeOpenCodeDiff(rawDiff);
    if (!diff) {
      return;
    }
    const signature = `${source}:${diff.filePath}:${diff.patch || diff.oldString}:${diff.newString}`;
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

function normalizeOpenCodeModels(providerPayload = {}, configPayload = {}) {
  const configuredDefault = typeof configPayload?.model === 'string'
    ? configPayload.model.trim()
    : '';
  const models = [{
    id: 'opencode-default',
    label: 'opencode default',
    description: configuredDefault
      ? `Uses ${configuredDefault} from opencode config.`
      : 'Uses the provider and model configured in opencode.',
    isDefault: true
  }];
  const seen = new Set(models.map((model) => model.id));
  const providers = Array.isArray(providerPayload?.providers) ? providerPayload.providers : [];
  const defaults = providerPayload?.default && typeof providerPayload.default === 'object'
    ? providerPayload.default
    : {};

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

async function rejectQuestion(runtime, cwd, question) {
  const requestId = question?.id || question?.requestID || question?.questionID;
  if (!requestId) {
    return;
  }

  await postJson(
    runtime.baseUrl,
    `/question/${encodeURIComponent(requestId)}/reject`,
    cwd
  );
  emitStatus('Rejected opencode question request; question UI is not implemented yet.');
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
  const content = [];

  for (const part of item?.parts || []) {
    const kind = partKind(part);
    const text = partText(part);
    if (kind === 'tool') {
      const toolUseId = openCodeToolUseId(part);
      if (!toolUseId) {
        continue;
      }
      content.push({
        type: 'tool_use',
        id: toolUseId,
        name: normalizeOpenCodeToolName(part.tool),
        input: normalizeOpenCodeToolInput(part)
      });

      const status = part?.state?.status;
      if (status === 'completed' || status === 'error') {
        content.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: status === 'error',
          content: openCodeToolResultContent(part)
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

  return {
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
}

function emitAssistantMessageFromResponse(response) {
  if (!response || !Array.isArray(response.parts)) {
    return;
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

  if (textParts.length === 0) {
    return;
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
    sawContentDelta: false
  };
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

  switch (type) {
    case 'message.part.updated': {
      const part = props.part || {};
      if (part.id) {
        ctx.partTypes.set(part.id, partKind(part));
      }

      if (part.type === 'tool' && part.tool) {
        emitOpenCodeToolUse(ctx, part);
        emitOpenCodeToolResult(ctx, part);
        if (part.state?.status === 'completed' || part.state?.status === 'error') {
          const metadata = { ...asRecord(part.state?.metadata), ...asRecord(part.metadata) };
          const fileDiffs = [];
          if (metadata.filediff) {
            fileDiffs.push(metadata.filediff);
          }
          if (Array.isArray(metadata.files)) {
            fileDiffs.push(...metadata.files);
          }
          emitOpenCodeDiffMessages(ctx, fileDiffs, `tool:${openCodeToolUseId(part) || part.id || part.tool}`);
        }

        const status = part.state?.status ? ` (${part.state.status})` : '';
        emitStatus(`opencode tool: ${part.tool}${status}`);
      }
      break;
    }

    case 'message.part.delta': {
      if (props.field && props.field !== 'text') {
        return;
      }
      const delta = typeof props.delta === 'string' ? props.delta : '';
      if (!delta) {
        return;
      }

      const partType = ctx.partTypes.get(props.partID);
      if (isReasoningPart(partType)) {
        emitThinkingDelta(delta);
      } else {
        ctx.sawContentDelta = true;
        emitContentDelta(delta);
      }
      break;
    }

    case 'message.updated': {
      const info = props.info || props.message || {};
      if (info.role === 'assistant' && info.error) {
        emitSendError({
          code: 'OPENCODE_SESSION_ERROR',
          error: formatOpenCodeError(info.error, 'opencode assistant message failed')
        });
      }
      break;
    }

    case 'session.error': {
      emitSendError({
        code: 'OPENCODE_SESSION_ERROR',
        error: formatOpenCodeError(props.error, 'opencode session error')
      });
      break;
    }

    case 'session.diff': {
      emitOpenCodeDiffMessages(ctx, props.diff, 'session.diff');
      break;
    }

    case 'permission.asked': {
      const requestId = props.id || props.requestID || props.permissionID;
      if (!requestId || ctx.repliedPermissions.has(requestId)) {
        return;
      }
      ctx.repliedPermissions.add(requestId);
      await replyToPermission(ctx.runtime, ctx.cwd, props, ctx.permissionMode);
      break;
    }

    case 'question.asked': {
      const requestId = props.id || props.requestID || props.questionID;
      if (!requestId || ctx.rejectedQuestions.has(requestId)) {
        return;
      }
      ctx.rejectedQuestions.add(requestId);
      await rejectQuestion(ctx.runtime, ctx.cwd, props);
      break;
    }

    default:
      break;
  }
}

async function consumeEvents(client, ctx, signal, onReady) {
  let subscription;
  try {
    subscription = await client.event.subscribe({
      query: directoryQuery(ctx.cwd),
      signal,
      sseMaxRetryAttempts: 1,
      onSseEvent: () => onReady()
    });

    onReady();
    for await (const event of subscription.stream) {
      if (signal.aborted) {
        return;
      }
      await handleOpenCodeEvent(event, ctx);
    }
  } catch (error) {
    if (!signal.aborted) {
      emitStatus(`opencode event stream ended: ${error.message || String(error)}`);
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
  attachments = []
) {
  let runtime = null;
  let cleanupAttachments = async () => {};
  let eventAbortController = null;
  let eventTask = null;

  try {
    runtime = await createOpenCodeRuntime(cwd);

    const sessionRef = { id: sessionId && sessionId.trim() ? sessionId.trim() : '' };
    const eventContext = createEventContext(runtime, cwd, permissionMode, sessionRef);
    eventAbortController = new AbortController();

    let readyEvents;
    const eventReady = new Promise((resolve) => {
      readyEvents = resolve;
    });
    eventTask = consumeEvents(
      runtime.client,
      eventContext,
      eventAbortController.signal,
      readyEvents
    );
    await Promise.race([eventReady, delay(1500)]);

    sessionRef.id = await createOrResolveSession(runtime.client, sessionRef.id, cwd);
    if (!sessionRef.id) {
      throw new Error('opencode did not return a session id');
    }

    emitMarker('[THREAD_ID]', sessionRef.id);
    emitMarker('[MESSAGE_START]');
    emitMarker('[STREAM_START]');

    const promptParts = await buildPromptParts(message, attachments);
    cleanupAttachments = promptParts.cleanup;

    const body = { parts: promptParts.parts };
    const parsedModel = parseOpenCodeModel(model);
    if (parsedModel) {
      body.model = parsedModel;
    }
    if (agent && agent.trim()) {
      body.system = agent.trim();
    }

    const response = await unwrapSdkResult(
      runtime.client.session.prompt({
        path: { id: sessionRef.id },
        query: directoryQuery(cwd),
        body
      }),
      'send opencode prompt'
    );

    if (!eventContext.sawContentDelta) {
      emitAssistantMessageFromResponse(response);
    }

    await delay(100);
    emitMarker('[STREAM_END]');
    emitMarker('[MESSAGE_END]');
  } catch (error) {
    emitSendError(normalizeOpenCodeSdkError(error));
  } finally {
    if (eventAbortController) {
      eventAbortController.abort();
    }
    if (eventTask) {
      await eventTask.catch(() => {});
    }
    await cleanupAttachments().catch(() => {});
    if (runtime) {
      await runtime.close().catch(() => {});
    }
  }
}

export async function abortSession(sessionId = '', cwd = '') {
  let runtime = null;
  try {
    const normalizedSessionId = sessionId && sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error('sessionId is required to abort an opencode session');
    }

    runtime = await createOpenCodeRuntime(cwd);
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
    if (runtime) {
      await runtime.close().catch(() => {});
    }
  }
}

export async function getSessionMessages(sessionId = '', cwd = '') {
  let runtime = null;
  try {
    const normalizedSessionId = sessionId && sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error('sessionId is required to get opencode session messages');
    }

    runtime = await createOpenCodeRuntime(cwd);
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
    if (runtime) {
      await runtime.close().catch(() => {});
    }
  }
}

export async function listModels(cwd = '') {
  let runtime = null;
  try {
    runtime = await createOpenCodeRuntime(cwd);
    const query = directoryQuery(cwd);
    const config = await unwrapSdkResult(
      runtime.client.config.get({ query }),
      'get opencode config'
    );
    const providers = await unwrapSdkResult(
      runtime.client.config.providers({ query }),
      'list opencode providers'
    );

    console.log(JSON.stringify({
      success: true,
      cwd,
      defaultModel: typeof config?.model === 'string' ? config.model : '',
      models: normalizeOpenCodeModels(providers, config)
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: normalizeOpenCodeSdkError(error).error,
      models: normalizeOpenCodeModels()
    }));
  } finally {
    if (runtime) {
      await runtime.close().catch(() => {});
    }
  }
}

export {
  createEventContext,
  handleOpenCodeEvent,
  normalizeOpenCodeMessage,
  normalizeOpenCodeModels
};
