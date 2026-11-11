/**
 * OMP CLI message service.
 *
 * Runs one chat turn over `omp --mode rpc-ui` and maps OMP's frames onto the
 * shared bridge marker protocol (same markers as Grok/Kimi/OpenCode).
 *
 * CLI:
 *   omp --mode rpc-ui [--model <pattern>] [--resume <id>] [--thinking <level>]
 *       [--approval-mode <mode>]
 *
 * One process per turn:
 *   ready                      -> set_event_filter, get_session_stats (session id, context window)
 *   prompt { message, images } -> session events until `prompt_result`
 *   prompt_result              -> `session_settled` first when background work is still running
 *   close stdin                -> omp drains and exits
 *
 * Frames consumed:
 *   { "type":"message_update", "assistantMessageEvent":{"type":"text_delta"|"thinking_delta","delta":"..."} }
 *   { "type":"tool_execution_start", "toolName":"...", "toolCallId":"...", "args":{...} }
 *   { "type":"tool_execution_end", "toolCallId":"...", "isError":false, "result":{ "content":[...], "details":{...} } }
 *   { "type":"message_end", "message":{"role":"assistant","usage":{...}} }
 *   { "type":"command_output", "text":"..." }            local slash commands
 *   { "type":"extension_ui_request", "method":"select"|"confirm"|"input"|"editor", ... }
 *   { "type":"prompt_result", "id":"...", "status":"completed"|"aborted"|"error", "sessionSettled":true }
 *
 * Auth/config comes from OMP CLI native home (~/.omp).
 */

import { homedir } from 'os';
import { resolveOmpCliPath, enrichPathWithBinDirs, commonCliBinDirs } from '../../utils/cli-path.js';
import {
  beginStream,
  emitJsonStringMarker,
  emitSendError,
  emitSessionId,
  emitToolResultMessage,
  emitToolUseMessage,
  emitUsage,
  endStream,
  isNonEmptySessionId,
} from '../../utils/marker-protocol.js';
import {
  GROK_IMAGE_ONLY_FALLBACK_TEXT as IMAGE_ONLY_PROMPT,
  buildGrokImageBlocks as buildImageBlocks,
} from '../../utils/cli-image-input.js';
import { reformatFileLineReferences } from '../../utils/file-line-references.js';
import { requestAskUserQuestionAnswers, requestPermissionFromJava } from '../../permission-ipc.js';
import { OmpRpcClient } from './rpc-client.js';
import { mapCompletedTool, mapStartedTool } from './tool-mapping.js';
import { createUiBridge } from './ui-bridge.js';
import { normalizeOmpUsage } from './usage.js';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const APPROVAL_MODES = new Set(['always-ask', 'write', 'yolo']);
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

// The prompt's id: its `prompt_result` frame echoes it.
const PROMPT_ID = 'prompt';
// Session events the turn consumes. Everything else (full `agent_end`
// transcripts, `turn_end`, ...) would only add megabytes to the pipe.
const FORWARDED_EVENTS = ['message_update', 'message_end', 'tool_execution_start', 'tool_execution_end'];
// OMP downscales images itself; this only bounds what is pushed through the pipe.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// How long OMP gets to wind a turn down after `abort` before its process tree is killed.
// The plugin force-kills this bridge process 3 s after asking it to stop.
const ABORT_GRACE_MS = 1_500;

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

function resolveApprovalFlag(approvalMode) {
  if (approvalMode == null) return null;
  const normalized = String(approvalMode).trim().toLowerCase();
  return APPROVAL_MODES.has(normalized) ? normalized : null;
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

export function buildOmpArgs({ sessionId, model, reasoningEffort, approvalMode }) {
  const args = ['--mode', 'rpc-ui'];
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
  // Without the flag OMP's own `tools.approvalMode` setting decides.
  const approvalFlag = resolveApprovalFlag(approvalMode);
  if (approvalFlag) {
    args.push('--approval-mode', approvalFlag);
  }
  return args;
}

/**
 * Run one prompt against an OMP RPC process and report what it does through `emit`.
 *
 * @param {object} options
 * @param {(onFrame: (frame: object) => void) => OmpRpcClient} options.createClient
 * @param {string} options.message
 * @param {object[]} [options.images] `{ type: 'image', mimeType, data }` blocks
 * @param {string} options.cwd session working directory
 * @param {object} options.emit `sessionId`, `contentDelta`, `thinkingDelta`, `toolUse`, `toolResult`, `usage`
 * @param {(toolName: string, inputs: object) => Promise<boolean>} options.requestPermission
 * @param {(input: object) => Promise<object|null>} options.requestAnswers
 * @param {AbortSignal} [options.abortSignal] the user stopped the turn
 * @param {(...args: unknown[]) => void} [options.log]
 * @returns {Promise<{ status: 'completed'|'aborted' }>}
 *   rejects when the turn failed
 */
export async function runOmpTurn({
  createClient,
  message,
  images = [],
  cwd,
  emit,
  requestPermission,
  requestAnswers,
  abortSignal,
  log = () => {},
}) {
  // Tool calls that have started and not ended, by toolCallId.
  const calls = new Map();
  let contextWindow = 0;
  let outcome = null;
  let aborted = false;
  let client;

  let settle;
  const settled = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A rejection that arrives while nothing awaits `settled` yet must not crash the process.
  settled.catch(() => {});

  const ui = createUiBridge({
    respond: (frame) => client.send(frame),
    requestPermission,
    requestAnswers,
    // An approval prompt names its tool only; it belongs to the oldest running
    // call of that tool that has not been asked about yet.
    claimToolCall: (toolName) => {
      for (const call of calls.values()) {
        if (call.name === toolName && !call.asked) {
          call.asked = true;
          return call;
        }
      }
      return undefined;
    },
    cwd,
    log,
  });

  const startTool = (frame) => {
    const call = {
      id: String(frame.toolCallId || ''),
      name: String(frame.toolName || ''),
      args: frame.args,
      cwd,
      asked: false,
      shown: false,
    };
    calls.set(call.id, call);
    const uses = mapStartedTool(call);
    if (uses) {
      call.shown = true;
      uses.forEach(emit.toolUse);
    }
  };

  const endTool = (frame) => {
    const id = String(frame.toolCallId || '');
    const call = calls.get(id) ?? { id, name: String(frame.toolName || ''), args: {}, cwd, shown: false };
    calls.delete(id);
    const { uses, results } = mapCompletedTool(call, {
      text: extractToolResultText(frame.result),
      details: frame.result?.details,
      isError: Boolean(frame.isError),
    });
    if (!call.shown) uses.forEach(emit.toolUse);
    results.forEach(emit.toolResult);
  };

  const handleFrame = (frame) => {
    switch (frame.type) {
      case 'message_update': {
        const update = frame.assistantMessageEvent;
        if (!update || typeof update !== 'object' || typeof update.delta !== 'string' || !update.delta) break;
        if (update.type === 'text_delta') {
          emit.contentDelta(update.delta);
        } else if (update.type === 'thinking_delta') {
          emit.thinkingDelta(update.delta);
        }
        break;
      }
      case 'message_end': {
        const msg = frame.message;
        if (msg && msg.role === 'assistant') {
          const usage = normalizeOmpUsage(msg.usage, contextWindow);
          if (usage) emit.usage(usage);
        }
        break;
      }
      case 'tool_execution_start':
        startTool(frame);
        break;
      case 'tool_execution_end':
        endTool(frame);
        break;
      case 'command_output':
        if (typeof frame.text === 'string' && frame.text) emit.contentDelta(`${frame.text}\n`);
        break;
      case 'extension_ui_request':
        ui.handle(frame);
        break;
      case 'prompt_result':
        if (frame.id !== PROMPT_ID) break;
        outcome = { status: frame.status, error: frame.error };
        // Background jobs can still wake the agent; `session_settled` follows once they have.
        if (frame.sessionSettled !== false) settle.resolve();
        break;
      case 'session_settled':
        if (outcome) settle.resolve();
        break;
      case 'response':
        // The prompt was acknowledged and failed afterwards.
        if (frame.id === PROMPT_ID && frame.success === false) {
          settle.reject(new Error(String(frame.error || 'OMP rejected the prompt')));
        }
        break;
      case 'extension_error':
        log('extension error', frame.extensionPath, frame.event, frame.error);
        break;
      default:
        break;
    }
  };

  client = createClient(handleFrame);
  client.exited.then((exit) => {
    settle.reject(new Error(`OMP CLI exited with code ${exit.code} before the turn finished`
      + `${client.stderrTail.trim() ? `\n${client.stderrTail.trim().slice(-800)}` : ''}`));
  });

  const onAbort = () => {
    aborted = true;
    client.send({ type: 'abort' });
    setTimeout(() => client.kill(), ABORT_GRACE_MS).unref();
  };
  if (abortSignal?.aborted) {
    onAbort();
  } else {
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await client.start();
    try {
      await client.request({ type: 'set_event_filter', events: FORWARDED_EVENTS, messageUpdates: 'delta' });
    } catch (error) {
      // Older omp: every event arrives with full snapshots, which still works.
      log('set_event_filter unavailable:', error?.message || error);
    }
    try {
      const stats = await client.request({ type: 'get_session_stats' });
      if (typeof stats?.sessionId === 'string' && stats.sessionId.trim()) emit.sessionId(stats.sessionId.trim());
      contextWindow = Number(stats?.contextUsage?.contextWindow) || 0;
    } catch (error) {
      log('get_session_stats failed:', error?.message || error);
    }

    const prompt = { id: PROMPT_ID, type: 'prompt', message };
    if (images.length > 0) prompt.images = images;
    // No deadline: a builtin such as /compact answers only when it is done.
    const ack = await client.request(prompt, { timeoutMs: 0 });
    // `agentInvoked: false` is a slash command that finished without a turn; no prompt_result follows.
    if (ack?.agentInvoked !== false) await settled;
  } catch (error) {
    if (!aborted) throw error;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    // A call still waiting for its result (the turn was cut short) is shown as it was made.
    for (const call of calls.values()) {
      if (!call.shown) mapCompletedTool(call).uses.forEach(emit.toolUse);
    }
    calls.clear();
    await client.close();
  }

  if (!aborted && outcome?.status === 'error') {
    throw new Error(String(outcome.error?.message || 'OMP turn failed'));
  }
  return { status: aborted || outcome?.status === 'aborted' ? 'aborted' : 'completed' };
}

const markerEmitter = {
  contentDelta: (text) => emitJsonStringMarker('[CONTENT_DELTA]', text),
  thinkingDelta: (text) => emitJsonStringMarker('[THINKING_DELTA]', text),
  toolUse: emitToolUseMessage,
  toolResult: emitToolResultMessage,
  usage: emitUsage,
};

/**
 * @param {object} options
 * @param {string} options.message
 * @param {string} [options.sessionId]
 * @param {string} [options.cwd]
 * @param {string} [options.model]
 * @param {string} [options.reasoningEffort] mapped to OMP `--thinking` level
 * @param {Array} [options.attachments] image attachments (fileName/mediaType/data)
 * @param {string} [options.approvalMode] mapped to OMP `--approval-mode`
 */
export async function sendMessage({
  message,
  sessionId = '',
  cwd = '',
  model = '',
  reasoningEffort = '',
  attachments = [],
  approvalMode = '',
}) {
  beginStream();

  const { blocks: images, errors: imageErrors } = buildImageBlocks(attachments, { maxBytes: MAX_IMAGE_BYTES });
  for (const error of imageErrors) {
    console.error('[OMP] image attachment skipped:', error);
  }
  const promptText = reformatFileLineReferences(message || '') || (images.length > 0 ? IMAGE_ONLY_PROMPT : '');

  const bin = resolveOmpCliPath();
  const args = buildOmpArgs({ sessionId, model, reasoningEffort, approvalMode });
  // The resumed id is announced before OMP starts, so a turn that fails early keeps its session.
  let announcedSessionId = '';
  const announceSession = (id) => {
    if (id === announcedSessionId) return;
    announcedSessionId = id;
    emitSessionId(id);
  };
  if (isNonEmptySessionId(sessionId)) {
    announceSession(sessionId.trim());
  }

  logDebug('spawn', bin, args.join(' '), `promptLen=${promptText.length}`, `images=${images.length}`);

  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, commonCliBinDirs(home));

  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();

  // The plugin stops a turn by signalling this process.
  const stop = new AbortController();
  const onShutdownSignal = () => stop.abort();
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, onShutdownSignal);

  // A dialog poll in permission-ipc.js cannot be cancelled. One that is still
  // open when the turn ends (OMP withdrew the request, or died) would keep
  // this process, and with it the plugin's turn, alive for minutes.
  let openDialogs = 0;
  const tracked = (request) => async (...requestArgs) => {
    openDialogs += 1;
    try {
      return await request(...requestArgs);
    } finally {
      openDialogs -= 1;
    }
  };

  try {
    await runOmpTurn({
      createClient: (onFrame) => new OmpRpcClient({ bin, args, cwd: workCwd, env, onFrame }),
      message: promptText,
      images,
      cwd: workCwd,
      emit: { ...markerEmitter, sessionId: announceSession },
      requestPermission: tracked(requestPermissionFromJava),
      requestAnswers: tracked(requestAskUserQuestionAnswers),
      abortSignal: stop.signal,
      log: logDebug,
    });
  } catch (error) {
    emitSendError(error?.message || String(error), 'OMP');
  } finally {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onShutdownSignal);
    endStream();
  }

  if (openDialogs > 0) {
    process.stdout.write('', () => process.exit(process.exitCode ?? 0));
  }
}
