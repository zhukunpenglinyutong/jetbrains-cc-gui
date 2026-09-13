/**
 * Kimi CLI message service (MVP).
 *
 * Spawns local `kimi` headless mode and maps stream-json NDJSON onto the
 * shared bridge marker protocol (same markers as Grok/Codex).
 *
 * CLI (aligned with desktop-cc-gui):
 *   kimi --output-format stream-json --prompt "<text>"
 *        [--model <alias>] [--session <id>]
 *
 * Stream lines:
 *   { "role":"assistant", "content":"..." }
 *   { "role":"assistant", "tool_calls":[...] }
 *   { "role":"tool", "tool_call_id":"...", "content":"..." }
 *   { "role":"meta", "type":"session.resume_hint", "session_id":"session_..." }
 *
 * Auth/config comes from Kimi CLI native home (KIMI_CODE_HOME / default).
 */

import { homedir } from 'os';
import { resolveKimiCliPath, enrichPathWithBinDirs, commonCliBinDirs } from '../../utils/cli-path.js';
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
  buildKimiPromptWithImages,
  cleanupMaterializedImagePaths,
  materializeImageAttachments,
} from '../../utils/cli-image-input.js';

function logDebug(...args) {
  console.error('[DEBUG][Kimi]', ...args);
}

function extractAssistantText(value) {
  const content = value?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: String(raw) };
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw: trimmed };
  }
}

/**
 * Snapshot-style assistant text merge (Kimi often re-emits growing prefixes).
 * Returns delta to stream, or null when nothing new.
 */
function mergeAssistantTextSnapshot(accumulated, incoming) {
  if (!incoming) return null;
  if (!accumulated) return incoming;
  if (incoming === accumulated) return null;
  if (incoming.startsWith(accumulated)) return incoming.slice(accumulated.length);
  if (accumulated.startsWith(incoming)) return null;
  // Non-prefix replacement: emit a separator + full new block.
  return `\n${incoming}`;
}

function parseKimiStreamLine(line) {
  if (!line || !line.trim()) return { kind: 'other' };
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'other' };
  }
  if (!value || typeof value !== 'object') return { kind: 'other' };

  const role = typeof value.role === 'string' ? value.role : '';
  switch (role) {
    case 'assistant': {
      if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) {
        const calls = value.tool_calls
          .map((call) => {
            if (!call || typeof call !== 'object') return null;
            const id = typeof call.id === 'string' ? call.id : '';
            const fn = call.function && typeof call.function === 'object' ? call.function : null;
            const name = (fn && typeof fn.name === 'string' && fn.name)
              || (typeof call.name === 'string' && call.name)
              || 'tool';
            const argsRaw = fn?.arguments ?? call.arguments;
            return { id: id || `kimi-tool-${name}`, name, input: parseToolArguments(argsRaw) };
          })
          .filter(Boolean);
        if (calls.length > 0) return { kind: 'tool_calls', calls };
      }
      const text = extractAssistantText(value);
      return text ? { kind: 'text', data: text } : { kind: 'other' };
    }
    case 'tool': {
      const toolCallId = typeof value.tool_call_id === 'string' ? value.tool_call_id.trim() : '';
      const content = value.content == null
        ? ''
        : (typeof value.content === 'string' ? value.content : JSON.stringify(value.content));
      return toolCallId ? { kind: 'tool_result', toolCallId, content } : { kind: 'other' };
    }
    case 'meta': {
      const metaType = typeof value.type === 'string' ? value.type : '';
      if (metaType === 'session.resume_hint') {
        const sessionId = typeof value.session_id === 'string' ? value.session_id.trim() : '';
        return sessionId ? { kind: 'session', sessionId } : { kind: 'other' };
      }
      return { kind: 'other' };
    }
    default:
      return { kind: 'other' };
  }
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
  ) {
    return null;
  }
  return trimmed;
}

function buildKimiArgs({ message, sessionId, model }) {
  const args = [
    '--output-format', 'stream-json',
    '--prompt', safePromptArg(message),
  ];
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) {
    args.push('--model', modelFlag);
  }
  if (isNonEmptySessionId(sessionId)) {
    args.push('--session', sessionId.trim());
  }
  return args;
}

/**
 * @param {string} message
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} model
 * @param {string} [_reasoningEffort] unused (Kimi CLI has no effort flag in headless)
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

  // Headless Kimi has no multimodal -p payload; inject absolute paths +
  // ReadMediaFile instructions (same approach as desktop-cc-gui).
  let promptText = message || '';
  let imagePaths = [];
  try {
    imagePaths = await materializeImageAttachments(attachments);
    if (imagePaths.length > 0) {
      promptText = buildKimiPromptWithImages(promptText, imagePaths);
      logDebug('image attachments', imagePaths.length, imagePaths);
    }
  } catch (err) {
    console.error('[Kimi] failed to materialize image attachments:', err?.message || err);
  }

  const bin = resolveKimiCliPath();
  const args = buildKimiArgs({ message: promptText, sessionId, model });
  let resolvedSessionId = isNonEmptySessionId(sessionId) ? sessionId.trim() : null;
  if (resolvedSessionId) {
    emitSessionId(resolvedSessionId);
  }

  logDebug('spawn', bin, args.filter((_, i) => args[i - 1] !== '--prompt').join(' '),
    `promptLen=${String(promptText || '').length}`);

  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, commonCliBinDirs(home));

  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();
  let accumulatedText = '';
  // Kimi may re-emit growing assistant snapshots including prior tool_calls;
  // skip calls already emitted (stable key: id + args, since id may be absent).
  const seenToolCallKeys = new Set();

  try {
  await runCliStreaming({
    bin,
    args,
    cwd: workCwd,
    env,
    label: 'Kimi',
    onLine: (line) => {
      const event = parseKimiStreamLine(line);
      switch (event.kind) {
        case 'text': {
          const delta = mergeAssistantTextSnapshot(accumulatedText, event.data);
          if (delta) {
            if (!accumulatedText) {
              accumulatedText = event.data;
            } else if (event.data.startsWith(accumulatedText)) {
              accumulatedText = event.data;
            } else if (!accumulatedText.startsWith(event.data)) {
              accumulatedText = `${accumulatedText}${delta}`;
            }
            emitJsonStringMarker('[CONTENT_DELTA]', delta);
          }
          break;
        }
        case 'tool_calls':
          for (const call of event.calls) {
            const key = `${call.id}|${JSON.stringify(call.input ?? {})}`;
            if (seenToolCallKeys.has(key)) continue;
            seenToolCallKeys.add(key);
            emitToolUseMessage(call);
          }
          break;
        case 'tool_result':
          emitToolResultMessage({ toolUseId: event.toolCallId, content: event.content });
          break;
        case 'session':
          resolvedSessionId = event.sessionId;
          emitSessionId(event.sessionId);
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
