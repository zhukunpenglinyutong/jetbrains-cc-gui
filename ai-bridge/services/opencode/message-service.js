/**
 * OpenCode CLI message service (MVP).
 *
 * Spawns local `opencode run --format json` and maps JSON events onto the
 * shared bridge marker protocol (same markers as Grok/Codex/Kimi).
 *
 * CLI (aligned with desktop-cc-gui):
 *   opencode run --format json [--model <id>] [--session <id>|--continue] <prompt>
 *
 * Auth/config comes from OpenCode native config (~/.config/opencode or OPENCODE_HOME).
 */

import { homedir } from 'os';
import { resolveOpenCodeCliPath, enrichPathWithBinDirs, commonCliBinDirs } from '../../utils/cli-path.js';
import { runCliStreaming } from '../../utils/cli-spawn.js';
import {
  beginStream,
  emitJsonStringMarker,
  emitSessionId,
  emitToolResultMessage,
  emitToolUseMessage,
  isNonEmptySessionId,
  safePromptArg,
} from '../../utils/marker-protocol.js';
import {
  GROK_IMAGE_ONLY_FALLBACK_TEXT,
  cleanupMaterializedImagePaths,
  materializeImageAttachments,
} from '../../utils/cli-image-input.js';

function logDebug(...args) {
  console.error('[DEBUG][OpenCode]', ...args);
}

function firstNonEmptyStr(candidates) {
  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function findSessionId(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findSessionId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of ['session_id', 'sessionId', 'sessionID']) {
    const value = node[key];
    if (typeof value === 'string' && isNonEmptySessionId(value)) {
      return value.trim();
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findSessionId(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractTextDelta(event) {
  const direct = firstNonEmptyStr([
    event?.text,
    event?.delta,
    event?.content,
    event?.data,
    event?.part?.text,
    event?.part?.delta,
    event?.output_text,
  ]);
  if (direct) return direct;

  const message = event?.message;
  if (message && typeof message === 'object') {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const joined = message.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
          return '';
        })
        .join('');
      if (joined) return joined;
    }
    if (typeof message.text === 'string') return message.text;
  }
  return null;
}

function extractErrorMessage(event) {
  // OpenCode 1.x: { type: 'error', error: { name, data: { message } } }
  return firstNonEmptyStr([
    event?.error?.message,
    event?.error?.data?.message,
    typeof event?.error?.data === 'string' ? event.error.data : null,
    typeof event?.error === 'string' ? event.error : null,
    event?.message,
    event?.data?.message,
    typeof event?.error?.name === 'string' ? event.error.name : null,
  ]);
}

function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: String(raw) };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

// Unique fallback ids for tool events that carry no id (otherwise all
// id-less calls collapse onto a single 'tool-1' and dedup drops them).
let syntheticToolCounter = 0;
function nextSyntheticToolId() {
  syntheticToolCounter += 1;
  return `opencode-tool-${syntheticToolCounter}`;
}

/**
 * Parse a 1.x structured tool part ({type:"tool", tool, callID,
 * state:{status,input,output,...}}). OpenCode pushes the tool part ONCE with
 * terminal state, so the dispatcher must synthesize the tool_use/tool_result
 * pair from this single event.
 */
function parseToolPart(part, sessionId) {
  const state = part.state && typeof part.state === 'object' ? part.state : null;
  const status = firstNonEmptyStr([
    state?.status,
    part?.status,
  ])?.toLowerCase() || 'started';

  // callID is the model-side tool-call id; part.id is the storage part id.
  // Prefer callID so tool_use/tool_result always pair on one id.
  const toolId = firstNonEmptyStr([
    part?.callID,
    part?.callId,
    part?.call_id,
    part?.toolCallID,
    part?.id,
  ]) || nextSyntheticToolId();

  const toolName = firstNonEmptyStr([
    part?.tool,
    part?.name,
    part?.tool_name,
    state?.name,
  ]) || 'tool';

  const input = state?.input ?? part?.input ?? {};
  const rawOutput = state?.output ?? part?.output;
  const error = firstNonEmptyStr([
    typeof state?.error === 'string' ? state.error : null,
    state?.error?.message,
    typeof part?.error === 'string' ? part.error : null,
    part?.error?.message,
  ]);

  const content = error
    || (typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput ?? ''));

  return {
    kind: 'tool',
    id: toolId,
    name: toolName,
    input: parseToolArguments(input),
    status,
    content,
    isError: status === 'error' || status === 'failed' || Boolean(error),
    sessionId,
  };
}

export function parseOpenCodeEvent(line) {
  if (!line || !line.trim()) return { kind: 'other' };
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return { kind: 'other' };
  }
  if (!event || typeof event !== 'object') return { kind: 'other' };

  const sessionId = findSessionId(event);
  const type = typeof event.type === 'string' ? event.type : '';
  const lower = type.toLowerCase();

  if (lower === 'error' || lower.endsWith('.error')) {
    const message = extractErrorMessage(event);
    return message ? { kind: 'error', message, sessionId } : { kind: 'other', sessionId };
  }

  // OpenCode 1.x wraps content in event.part and types it there (text /
  // reasoning / tool). part.type is authoritative when present; the legacy
  // top-level matching further down stays as a fallback for older shapes.
  const part = event.part && typeof event.part === 'object' ? event.part : null;
  const partType = typeof part?.type === 'string' ? part.type.toLowerCase() : '';

  if (partType === 'text') {
    const text = typeof part.text === 'string' ? part.text : '';
    return text ? { kind: 'text', data: text, partId: part.id, sessionId } : { kind: 'other', sessionId };
  }
  if (partType === 'reasoning') {
    const text = typeof part.text === 'string' ? part.text : '';
    return text ? { kind: 'thought', data: text, partId: part.id, sessionId } : { kind: 'other', sessionId };
  }
  if (partType === 'tool') {
    return parseToolPart(part, sessionId);
  }

  if (
    lower === 'text'
    || lower === 'content_delta'
    || lower === 'text_delta'
    || lower === 'output_text_delta'
    || lower === 'assistant_message_delta'
    || lower === 'message_delta'
    || lower === 'assistant_message'
    || lower === 'message'
    || ((lower.includes('delta') || lower.includes('message') || lower.includes('text'))
      && extractTextDelta(event))
  ) {
    const text = extractTextDelta(event);
    if (text) return { kind: 'text', data: text, sessionId };
  }

  if (lower === 'reasoning_delta' || lower.includes('reasoning') || lower.includes('think')) {
    const text = extractTextDelta(event);
    if (text) return { kind: 'thought', data: text, sessionId };
  }

  if (lower === 'tool_use' || lower === 'tool_call' || lower.includes('tool')) {
    const legacyPart = part;
    const state = legacyPart?.state && typeof legacyPart.state === 'object' ? legacyPart.state : null;
    const status = firstNonEmptyStr([
      event.status,
      state?.status,
      legacyPart?.status,
    ])?.toLowerCase() || 'started';

    const toolId = firstNonEmptyStr([
      event.tool_id,
      legacyPart?.callID,
      legacyPart?.callId,
      legacyPart?.call_id,
      legacyPart?.toolCallID,
      event.id,
      legacyPart?.id,
      state?.id,
    ]) || nextSyntheticToolId();

    const toolName = firstNonEmptyStr([
      event.name,
      event.tool_name,
      legacyPart?.name,
      legacyPart?.tool_name,
      legacyPart?.tool,
      state?.name,
    ]) || 'tool';

    const input = event.input ?? legacyPart?.input ?? state?.input ?? {};
    const rawOutput = event.output ?? event.result ?? legacyPart?.output ?? state?.output;
    const error = firstNonEmptyStr([
      typeof event.error === 'string' ? event.error : null,
      event.error?.message,
      typeof legacyPart?.error === 'string' ? legacyPart.error : null,
      typeof state?.error === 'string' ? state.error : null,
    ]);

    if (status === 'completed' || status === 'error' || status === 'failed' || rawOutput != null || error) {
      const content = error
        || (typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput ?? ''));
      const isError = status === 'error' || status === 'failed' || Boolean(error);
      return { kind: 'tool_result', toolCallId: toolId, content, isError, sessionId };
    }
    return {
      kind: 'tool_use',
      id: toolId,
      name: toolName,
      input: parseToolArguments(input),
      sessionId,
    };
  }

  if (sessionId) {
    return { kind: 'session', sessionId };
  }
  return { kind: 'other' };
}

// OpenCode 1.x pushes each text/reasoning part exactly once, but future
// versions may re-push a part with cumulative text. Emit only the novel
// suffix so text never doubles in the UI. Also tolerates true incremental
// deltas: a follow-up that is not a prefix extension is emitted as-is.
function novelDelta(stateMap, partId, fullText) {
  if (!partId) return fullText;
  const prev = stateMap.get(partId);
  const novel = typeof prev === 'string' && fullText.startsWith(prev)
    ? fullText.slice(prev.length)
    : fullText;
  stateMap.set(partId, fullText);
  return novel;
}

/**
 * Map parsed OpenCode events onto marker emissions.
 *
 * The 1.x "tool" kind carries terminal state in a single event: emit the
 * tool_use card first, then pair the tool_result on the same callID. Legacy
 * two-phase kinds (tool_use / tool_result) keep their old behavior; the
 * started-dedup makes both shapes converge on one tool_use per id.
 *
 * @param {object} sink marker emitters: contentDelta/thinkingDelta/toolUse/toolResult/sendError
 * @returns {(event: object) => void} dispatcher over parseOpenCodeEvent output
 */
export function createOpenCodeEventDispatcher(sink) {
  const seenToolStarts = new Set();
  const seenToolResults = new Set();
  const partTextState = new Map();

  return function dispatch(event) {
    switch (event.kind) {
      case 'text': {
        const novel = novelDelta(partTextState, event.partId, event.data);
        if (novel) sink.contentDelta(novel);
        break;
      }
      case 'thought': {
        const novel = novelDelta(partTextState, event.partId, event.data);
        if (novel) sink.thinkingDelta(novel);
        break;
      }
      case 'tool': {
        if (!seenToolStarts.has(event.id)) {
          seenToolStarts.add(event.id);
          sink.toolUse({ id: event.id, name: event.name, input: event.input });
        }
        if (
          (event.status === 'completed' || event.status === 'error')
          && !seenToolResults.has(event.id)
        ) {
          seenToolResults.add(event.id);
          sink.toolResult({ toolUseId: event.id, content: event.content, isError: event.isError });
        }
        break;
      }
      case 'tool_use':
        if (!seenToolStarts.has(event.id)) {
          seenToolStarts.add(event.id);
          sink.toolUse(event);
        }
        break;
      case 'tool_result':
        sink.toolResult({ toolUseId: event.toolCallId, content: event.content, isError: event.isError });
        break;
      case 'error':
        sink.sendError(event.message);
        break;
      default:
        break;
    }
  };
}

function resolveModelFlag(model) {
  if (model == null) return null;
  const trimmed = String(model).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower === '__config_default__'
    || lower === 'auto'
    || lower === 'default'
    || lower === '(default)'
    || lower === 'config-default'
    || lower === 'config_default'
    || lower === 'opencode default'
    || lower === 'opencode-default'
  ) {
    return null;
  }
  return trimmed;
}

/**
 * Build `opencode run` argv.
 *
 * IMPORTANT: prompt must come BEFORE `-f/--file`. OpenCode's yargs defines
 * `--file` as an array option, so trailing positionals after `-f <path>` are
 * greedily consumed as extra file paths → `File not found: <prompt>`.
 * Avoid `run -- <msg>` (broken on some OpenCode versions).
 *
 * `thinking` maps the plugin's "always thinking" toggle to OpenCode's
 * `--thinking` flag — without it non-interactive `run` suppresses reasoning
 * parts entirely (upstream default: false).
 *
 * @param {{ message?: string, sessionId?: string, model?: string, imagePaths?: string[], thinking?: boolean, autoApprove?: boolean }} opts
 * @returns {string[]}
 */
export function buildOpenCodeArgs({ message, sessionId, model, imagePaths = [], thinking = true, autoApprove = false }) {
  const args = ['run', '--format', 'json'];
  if (thinking) {
    args.push('--thinking');
  }
  if (autoApprove) {
    // Auto-approve permissions that are not explicitly denied; without it a
    // headless run can stall on permission prompts.
    args.push('--auto');
  }
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) {
    args.push('--model', modelFlag);
  }
  if (isNonEmptySessionId(sessionId)) {
    args.push('--session', sessionId.trim());
  }
  // Prompt before file flags so yargs does not treat it as another --file value.
  args.push(safePromptArg(message));
  // Multimodal: `opencode run <prompt> -f <path>`
  for (const imagePath of imagePaths) {
    if (imagePath) {
      args.push('-f', imagePath);
    }
  }
  return args;
}

/**
 * @param {string} message
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} model
 * @param {string} [_reasoningEffort]
 * @param {Array} [attachments] image attachments (fileName/mediaType/data)
 * @param {boolean} [thinking] plugin "always thinking" toggle; adds --thinking (default true)
 * @param {string} [permissionMode] 'bypassPermissions' maps to OpenCode's --auto
 */
export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  _reasoningEffort = '',
  attachments = [],
  thinking = true,
  permissionMode = ''
) {
  beginStream();

  let imagePaths = [];
  try {
    imagePaths = await materializeImageAttachments(attachments);
  } catch (err) {
    console.error('[OpenCode] failed to materialize image attachments:', err?.message || err);
  }

  // OpenCode requires a non-empty prompt even for image-only turns.
  let promptText = message || '';
  if (!String(promptText).trim() && imagePaths.length > 0) {
    promptText = GROK_IMAGE_ONLY_FALLBACK_TEXT;
  }

  const autoApprove = String(permissionMode || '').trim().toLowerCase() === 'bypasspermissions';
  const bin = resolveOpenCodeCliPath();
  const args = buildOpenCodeArgs({
    message: promptText,
    sessionId,
    model,
    imagePaths,
    thinking: thinking !== false,
    autoApprove,
  });
  let resolvedSessionId = isNonEmptySessionId(sessionId) ? sessionId.trim() : null;
  if (resolvedSessionId) {
    emitSessionId(resolvedSessionId);
  }

  logDebug(
    'spawn',
    bin,
    `format=json model=${model || '-'} session=${resolvedSessionId || '-'}`,
    `promptLen=${String(promptText || '').length}`,
    `images=${imagePaths.length}`
  );

  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, commonCliBinDirs(home));

  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();
  const dispatch = createOpenCodeEventDispatcher({
    contentDelta: (text) => emitJsonStringMarker('[CONTENT_DELTA]', text),
    thinkingDelta: (text) => emitJsonStringMarker('[THINKING_DELTA]', text),
    toolUse: emitToolUseMessage,
    toolResult: emitToolResultMessage,
    sendError: (errorMessage) =>
      console.log(`[SEND_ERROR] ${JSON.stringify({ error: errorMessage })}`),
  });

  try {
  await runCliStreaming({
    bin,
    args,
    cwd: workCwd,
    env,
    label: 'OpenCode',
    onLine: (line) => {
      const event = parseOpenCodeEvent(line);
      if (event.sessionId && event.sessionId !== resolvedSessionId) {
        resolvedSessionId = event.sessionId;
        emitSessionId(event.sessionId);
      }
      dispatch(event);
    },
  });
  } finally {
    await cleanupMaterializedImagePaths(imagePaths);
  }
}
