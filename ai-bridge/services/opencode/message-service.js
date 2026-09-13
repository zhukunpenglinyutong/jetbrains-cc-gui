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

function parseOpenCodeEvent(line) {
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
    const part = event.part && typeof event.part === 'object' ? event.part : null;
    const state = part?.state && typeof part.state === 'object' ? part.state : null;
    const status = firstNonEmptyStr([
      event.status,
      state?.status,
      part?.status,
    ])?.toLowerCase() || 'started';

    const toolId = firstNonEmptyStr([
      event.tool_id,
      event.id,
      part?.id,
      part?.callID,
      part?.callId,
      part?.call_id,
      part?.toolCallID,
      state?.id,
    ]) || nextSyntheticToolId();

    const toolName = firstNonEmptyStr([
      event.name,
      event.tool_name,
      part?.name,
      part?.tool_name,
      part?.tool,
      state?.name,
    ]) || 'tool';

    const input = event.input ?? part?.input ?? state?.input ?? {};
    const rawOutput = event.output ?? event.result ?? part?.output ?? state?.output;
    const error = firstNonEmptyStr([
      typeof event.error === 'string' ? event.error : null,
      event.error?.message,
      typeof part?.error === 'string' ? part.error : null,
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
 * @param {{ message?: string, sessionId?: string, model?: string, imagePaths?: string[] }} opts
 * @returns {string[]}
 */
export function buildOpenCodeArgs({ message, sessionId, model, imagePaths = [] }) {
  const args = ['run', '--format', 'json'];
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
 */
export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  _reasoningEffort = '',
  attachments = []
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

  const bin = resolveOpenCodeCliPath();
  const args = buildOpenCodeArgs({ message: promptText, sessionId, model, imagePaths });
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
  const seenToolStarts = new Set();

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
      switch (event.kind) {
        case 'text':
          emitJsonStringMarker('[CONTENT_DELTA]', event.data);
          break;
        case 'thought':
          emitJsonStringMarker('[THINKING_DELTA]', event.data);
          break;
        case 'tool_use':
          if (!seenToolStarts.has(event.id)) {
            seenToolStarts.add(event.id);
            emitToolUseMessage(event);
          }
          break;
        case 'tool_result':
          emitToolResultMessage({ toolUseId: event.toolCallId, content: event.content, isError: event.isError });
          break;
        case 'error':
          // runCliStreaming also reports non-zero exits; surface structured error early.
          console.log(`[SEND_ERROR] ${JSON.stringify({ error: event.message })}`);
          break;
        default:
          break;
      }
    },
  });
  } finally {
    await cleanupMaterializedImagePaths(imagePaths);
  }
}
