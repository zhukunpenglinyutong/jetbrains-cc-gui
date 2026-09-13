/**
 * OMP CLI message service.
 *
 * Spawns local `omp` headless print mode with JSON event output and maps the
 * NDJSON event stream onto the shared bridge marker protocol (same markers
 * as Grok/Kimi/OpenCode).
 *
 * CLI:
 *   omp --print --mode json "<text>"
 *      [--model <pattern>] [--resume <id>] [--thinking <level>]
 *
 * Stream events (NDJSON):
 *   { "type":"session", "id":"..." }
 *   { "type":"message_update", "assistantMessageEvent":{"type":"text_delta","delta":"..."} }
 *   { "type":"message_update", "assistantMessageEvent":{"type":"thinking_delta","delta":"..."} }
 *   { "type":"tool_execution_start", "toolName":"...", "toolCallId":"...", "args":{...} }
 *   { "type":"tool_execution_end", "toolCallId":"...", "isError":false, "result":{...} }
 *   { "type":"message_end", "message":{"role":"assistant","usage":{...}} }
 *
 * Auth/config comes from OMP CLI native home (~/.omp).
 */

import { homedir } from 'os';
import { resolveOmpCliPath, enrichPathWithBinDirs, commonCliBinDirs } from '../../utils/cli-path.js';
import { runCliStreaming } from '../../utils/cli-spawn.js';
import {
  beginStream,
  emitJsonStringMarker,
  emitSessionId,
  emitToolResultMessage,
  emitToolUseMessage,
  emitUsage,
  isNonEmptySessionId,
  safePromptArg,
} from '../../utils/marker-protocol.js';
import {
  buildReadPathPromptWithImages,
  cleanupMaterializedImagePaths,
  materializeImageAttachments,
} from '../../utils/cli-image-input.js';
import { reformatFileLineReferences } from '../../utils/file-line-references.js';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function logDebug(...args) {
  console.error('[DEBUG][OMP]', ...args);
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
    || lower === 'omp-default'
    || lower === 'omp default'
  ) {
    return null;
  }
  return trimmed;
}

function resolveThinkingFlag(reasoningEffort) {
  if (reasoningEffort == null) return null;
  const normalized = String(reasoningEffort).trim().toLowerCase();
  return THINKING_LEVELS.has(normalized) ? normalized : null;
}

function extractToolResultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function buildOmpArgs({ message, sessionId, model, reasoningEffort }) {
  const args = ['--print', '--mode', 'json'];
  // The webview maps omp modes (smol/slow/plan) onto the model value itself —
  // omp resolves role names passed to --model, so no separate mode handling.
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) {
    args.push('--model', modelFlag);
  }
  if (isNonEmptySessionId(sessionId)) {
    args.push('--resume', sessionId.trim());
  }
  const thinkingFlag = resolveThinkingFlag(reasoningEffort);
  if (thinkingFlag) {
    args.push('--thinking', thinkingFlag);
  }
  // Prompt is a positional message argument (omp has no --prompt flag).
  args.push(safePromptArg(message));
  return args;
}

/**
 * @param {string} message
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} model
 * @param {string} [reasoningEffort] mapped to OMP `--thinking` level
 * @param {Array} [attachments] image attachments (fileName/mediaType/data)
 */
export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  reasoningEffort = '',
  attachments = []
) {
  beginStream();

  // OMP headless has no dedicated multimodal flag; inject absolute paths and
  // ask the agent to Read the images (best-effort, same as non-vision Claude path).
  let promptText = message || '';
  let imagePaths = [];
  try {
    imagePaths = await materializeImageAttachments(attachments);
    if (imagePaths.length > 0) {
      promptText = buildReadPathPromptWithImages(promptText, imagePaths);
      logDebug('image attachments', imagePaths.length, imagePaths);
    }
  } catch (err) {
    console.error('[OMP] failed to materialize image attachments:', err?.message || err);
  }
  promptText = reformatFileLineReferences(promptText);

  const bin = resolveOmpCliPath();
  const args = buildOmpArgs({ message: promptText, sessionId, model, reasoningEffort });
  if (isNonEmptySessionId(sessionId)) {
    emitSessionId(sessionId.trim());
  }

  logDebug('spawn', bin, args.slice(0, -1).join(' '),
    `promptLen=${String(promptText || '').length}`);

  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, commonCliBinDirs(home));

  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();

  try {
  await runCliStreaming({
    bin,
    args,
    cwd: workCwd,
    env,
    label: 'OMP',
    onLine: (line) => {
      if (!line || !line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== 'object') return;

      switch (event.type) {
        case 'session': {
          const id = typeof event.id === 'string' ? event.id.trim() : '';
          if (id) emitSessionId(id);
          break;
        }
        case 'message_update': {
          const update = event.assistantMessageEvent;
          if (!update || typeof update !== 'object') break;
          if (update.type === 'text_delta' && typeof update.delta === 'string' && update.delta) {
            emitJsonStringMarker('[CONTENT_DELTA]', update.delta);
          } else if (update.type === 'thinking_delta' && typeof update.delta === 'string' && update.delta) {
            emitJsonStringMarker('[THINKING_DELTA]', update.delta);
          }
          break;
        }
        case 'tool_execution_start': {
          emitToolUseMessage({
            id: typeof event.toolCallId === 'string' ? event.toolCallId : '',
            name: typeof event.toolName === 'string' ? event.toolName : '',
            input: event.args && typeof event.args === 'object' ? event.args : {},
          });
          break;
        }
        case 'tool_execution_end': {
          emitToolResultMessage({
            toolUseId: typeof event.toolCallId === 'string' ? event.toolCallId : '',
            content: extractToolResultText(event.result),
            isError: Boolean(event.isError),
          });
          break;
        }
        case 'message_end': {
          const msg = event.message;
          if (msg && msg.role === 'assistant' && msg.usage && typeof msg.usage === 'object') {
            emitUsage(msg.usage);
          }
          break;
        }
        default:
          break;
      }
    },
  });
  } finally {
    await cleanupMaterializedImagePaths(imagePaths);
  }
}
