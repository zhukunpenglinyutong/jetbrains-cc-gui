/**
 * Claude live-turn steer: inject a user message with priority 'next' into the
 * in-flight query, then fold/undeliver it from the turn stream.
 *
 * Capability is gated at runtime (CLI >= 2.1.220 and cancelAsyncMessage).
 * Folded rows are inserted by Java from [STEER_FOLDED], not from CLI replay.
 */

import { randomUUID } from 'node:crypto';
import { getActiveTurnRuntime } from './runtime-registry.js';

/** Minimum Claude Code CLI version that supports async-message steer. */
export const STEER_MIN_CLI_VERSION = '2.1.220';

/** Reject reasons returned on the steer request (not the in-flight send). */
export const STEER_REJECT = {
  NO_ACTIVE_TURN: 'no_active_turn',
  SESSION_MISMATCH: 'session_mismatch',
  UNSUPPORTED_CLI_VERSION: 'unsupported_cli_version',
  RUNTIME_CLOSED: 'runtime_closed',
  UNSUPPORTED_PROVIDER: 'unsupported_provider',
};

const FOLD_COMMAND_MODES = new Set(['prompt', 'user-prompt']);

/**
 * Parse a dotted CLI version into numeric parts (strips pre-release suffix).
 * @param {string|null|undefined} version
 * @returns {number[]}
 */
export function parseClaudeCodeVersionParts(version) {
  if (typeof version !== 'string' || !version.trim()) {
    return [];
  }
  const core = version.trim().split(/[-+]/)[0];
  return core.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * Compare two dotted versions. Returns true when `version` >= `minimum`.
 * @param {string|null|undefined} version
 * @param {string} minimum
 * @returns {boolean}
 */
export function isClaudeCodeVersionAtLeast(version, minimum) {
  const left = parseClaudeCodeVersionParts(version);
  const right = parseClaudeCodeVersionParts(minimum);
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/**
 * Ensure pending/folded maps exist on a runtime (tests may pass partial objects).
 * @param {object} runtime
 */
export function ensureSteerMaps(runtime) {
  if (!runtime) return;
  if (!(runtime.pendingSteers instanceof Map)) {
    runtime.pendingSteers = new Map();
  }
  if (!(runtime.foldedSteers instanceof Map)) {
    runtime.foldedSteers = new Map();
  }
}

/**
 * True when this runtime can accept a steer into the live turn.
 * @param {object|null} runtime
 * @returns {boolean}
 */
export function isSteerCapable(runtime) {
  if (!runtime) return false;
  return isClaudeCodeVersionAtLeast(runtime.claudeCodeVersion, STEER_MIN_CLI_VERSION)
    && typeof runtime.query?.cancelAsyncMessage === 'function';
}

/**
 * Write a turn-stream tag on the current request stdout (must stay ordered).
 * @param {string} tag
 * @param {object} payload
 */
export function emitTurnTag(tag, payload) {
  process.stdout.write(`${tag} ${JSON.stringify(payload)}\n`);
}

/**
 * Emit [CAPABILITIES] {"steer":boolean} on the current request stream.
 * @param {object} runtime
 */
export function emitCapabilities(runtime) {
  emitTurnTag('[CAPABILITIES]', { steer: isSteerCapable(runtime) });
}

/**
 * Record claude_code_version from a system/init message.
 * @param {object} runtime
 * @param {object} msg
 * @returns {boolean} true when this message was a version-bearing init
 */
export function recordClaudeCodeVersionFromInit(runtime, msg) {
  if (!runtime || !msg || msg.type !== 'system') {
    return false;
  }
  const isInit = msg.subtype === 'init' || typeof msg.claude_code_version === 'string';
  if (!isInit) {
    return false;
  }
  if (typeof msg.claude_code_version === 'string' && msg.claude_code_version.trim()) {
    runtime.claudeCodeVersion = msg.claude_code_version.trim();
  }
  return true;
}

function idsMatch(left, right) {
  const a = typeof left === 'string' ? left.trim() : '';
  const b = typeof right === 'string' ? right.trim() : '';
  if (!a || !b) {
    return true;
  }
  return a === b;
}

function extractSteerPrompt(msg) {
  const content = msg?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block && block.type === 'text' && typeof block.text === 'string');
    if (textBlock) {
      return textBlock.text;
    }
    return content;
  }
  if (typeof msg?.message === 'string') {
    return msg.message;
  }
  return '';
}

function normalizePromptText(prompt) {
  if (typeof prompt === 'string') {
    return prompt.trim();
  }
  if (Array.isArray(prompt)) {
    return prompt
      .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
      .join('')
      .trim();
  }
  return '';
}

function isToolResultUserMessage(msg) {
  if (!msg || msg.type !== 'user') {
    return false;
  }
  if (msg.tool_use_result != null) {
    return true;
  }
  const content = msg.message?.content ?? msg.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => block && block.type === 'tool_result');
}

function getQueuedCommandAttachment(msg) {
  if (!msg || typeof msg !== 'object') {
    return null;
  }
  const attachment = msg.attachment
    || (msg.type === 'attachment' && msg.commandMode ? msg : null);
  if (!attachment || attachment.type !== 'queued_command') {
    return null;
  }
  return attachment;
}

/**
 * Move a pending steer into foldedSteers and emit [STEER_FOLDED] on this turn stream.
 * @param {object} runtime
 * @param {string} uuid
 * @param {{steerId?: string, prompt?: string}} record
 * @param {*} prompt
 * @returns {boolean}
 */
function foldSteerRecord(runtime, uuid, record, prompt) {
  runtime.pendingSteers.delete(uuid);
  runtime.foldedSteers.set(uuid, record);
  emitTurnTag('[STEER_FOLDED]', {
    steerId: record.steerId,
    uuid,
    prompt: prompt !== undefined && prompt !== null ? prompt : (record.prompt ?? ''),
  });
  return true;
}

function foldOldestPendingSteer(runtime, prompt) {
  const oldest = runtime.pendingSteers.entries().next().value;
  if (!oldest) {
    return false;
  }
  const [uuid, record] = oldest;
  const resolvedPrompt = prompt !== undefined && prompt !== null
    ? prompt
    : (record.prompt ?? '');
  return foldSteerRecord(runtime, uuid, record, resolvedPrompt);
}

/**
 * If this message is the live fold of a pending steer, emit [STEER_FOLDED].
 * JSONL records the fold as queued_command; the SDK stream yields a user
 * message (uuid we assigned, or the same prompt) — often only with
 * --replay-user-messages. Tool-result / task-notification carriers are not folds.
 * @param {object} runtime
 * @param {object} msg
 * @returns {boolean} true when the message was consumed as a fold
 */
export function tryEmitSteerFolded(runtime, msg) {
  ensureSteerMaps(runtime);

  // --replay-user-messages re-echoes fold carriers (queued_command attachment
  // and/or the user row). Consume every fold-shaped carrier so a post-fold
  // replay cannot leak a second row into [MESSAGE].
  const attachment = getQueuedCommandAttachment(msg);
  if (attachment && FOLD_COMMAND_MODES.has(attachment.commandMode)) {
    if (runtime.pendingSteers.size === 0) {
      return true;
    }
    return foldOldestPendingSteer(runtime, attachment.prompt);
  }

  if (msg?.type !== 'user' || isToolResultUserMessage(msg)) {
    return false;
  }

  const prompt = extractSteerPrompt(msg);
  const promptText = normalizePromptText(prompt);
  if (typeof promptText === 'string' && promptText.includes('<task-notification')) {
    return false;
  }

  const uuid = typeof msg.uuid === 'string' ? msg.uuid.trim() : '';
  if (uuid && runtime.pendingSteers.has(uuid)) {
    const record = runtime.pendingSteers.get(uuid);
    return foldSteerRecord(runtime, uuid, record, prompt || record.prompt);
  }

  // Already folded: this is a replay of a steer we already emitted.
  if (uuid && runtime.foldedSteers.has(uuid)) {
    return true;
  }

  // Prompt match is only for the main thread: sidechain user rows can repeat text.
  if (msg.parent_tool_use_id) {
    return false;
  }
  if (!promptText) {
    return false;
  }
  for (const [pendingUuid, record] of runtime.pendingSteers.entries()) {
    if (normalizePromptText(record.prompt) === promptText) {
      return foldSteerRecord(runtime, pendingUuid, record, prompt);
    }
  }
  for (const record of runtime.foldedSteers.values()) {
    if (normalizePromptText(record.prompt) === promptText) {
      return true;
    }
  }
  return false;
}

function emitUndelivered(runtime, uuid, record) {
  runtime.pendingSteers.delete(uuid);
  emitTurnTag('[STEER_UNDELIVERED]', { steerId: record.steerId });
  // Steer plan F4: the tag rides the (possibly already aborted) request
  // stream; this stderr line makes daemon-side emission visible in the host
  // log regardless of whether the request routing survives the abort.
  const writeStderr = process.stderr._originalStderrWrite
    || process.stderr.write.bind(process.stderr);
  writeStderr(`[STEER] undelivered steerId=${record.steerId} uuid=${uuid}\n`, 'utf8');
}

/**
 * On a turn `result`, cancel leftover pending steers or keep reading the extra turn.
 * @param {object} runtime
 * @param {object} resultMsg
 * @returns {Promise<boolean>} true when executeTurn should break as today
 */
export async function handleSteerResultAndMaybeContinue(runtime, resultMsg) {
  ensureSteerMaps(runtime);
  const resultUuids = new Set(
    Array.isArray(resultMsg?.user_message_uuids) ? resultMsg.user_message_uuids : [],
  );

  for (const [uuid, record] of [...runtime.pendingSteers.entries()]) {
    if (!resultUuids.has(uuid)) {
      continue;
    }
    foldSteerRecord(runtime, uuid, record, record.prompt ?? '');
  }

  const undelivered = [...runtime.pendingSteers.entries()];
  let keepReading = false;
  for (const [uuid, record] of undelivered) {
    const cancel = runtime.query?.cancelAsyncMessage;
    if (typeof cancel !== 'function') {
      emitUndelivered(runtime, uuid, record);
      continue;
    }
    let cancelled = false;
    try {
      const result = await cancel.call(runtime.query, uuid);
      cancelled = result === true || result?.cancelled === true;
    } catch {
      cancelled = false;
    }
    if (cancelled) {
      emitUndelivered(runtime, uuid, record);
      continue;
    }
    // CLI already dequeued this uuid for the next top-level turn (documented race).
    keepReading = true;
  }

  if (keepReading && resultMsg?.queued_turn_count !== 0) {
    return false;
  }

  // Breaking this request: leftover pending that cancelAsyncMessage refused were
  // already consumed (often into THIS turn). result.user_message_uuids is not
  // always present on SDKResultMessage, so without this emit the frontend stays
  // stuck in `steering` with no transcript row.
  for (const [uuid, record] of [...runtime.pendingSteers.entries()]) {
    foldSteerRecord(runtime, uuid, record, record.prompt ?? '');
  }
  return true;
}

/**
 * Abort destroys the subprocess, so every pending-not-folded uuid is undelivered.
 * @param {object|null} runtime
 */
export function dumpPendingSteersAsUndelivered(runtime) {
  if (!runtime) return;
  ensureSteerMaps(runtime);
  for (const [uuid, record] of [...runtime.pendingSteers.entries()]) {
    emitUndelivered(runtime, uuid, record);
  }
}

/**
 * Enqueue a steer onto the live turn's input stream (bypasses commandQueue).
 * @param {object} params
 * @param {{ buildUserMessage: Function }} deps
 * @returns {Promise<{delivered: boolean, reason?: string}>}
 */
export async function steerMessagePersistent(params = {}, deps = {}) {
  const buildUserMessage = deps.buildUserMessage;
  const runtime = getActiveTurnRuntime();
  if (!runtime) {
    return { delivered: false, reason: STEER_REJECT.NO_ACTIVE_TURN };
  }
  if (runtime.closed) {
    return { delivered: false, reason: STEER_REJECT.RUNTIME_CLOSED };
  }
  if (!runtime.turnSink) {
    return { delivered: false, reason: STEER_REJECT.NO_ACTIVE_TURN };
  }
  if (!idsMatch(params.sessionId, runtime.sessionId)
      || !idsMatch(params.runtimeSessionEpoch, runtime.runtimeSessionEpoch)) {
    return { delivered: false, reason: STEER_REJECT.SESSION_MISMATCH };
  }
  if (!isSteerCapable(runtime)) {
    return { delivered: false, reason: STEER_REJECT.UNSUPPORTED_CLI_VERSION };
  }
  if (typeof runtime.inputStream?.enqueue !== 'function') {
    return { delivered: false, reason: STEER_REJECT.RUNTIME_CLOSED };
  }
  if (typeof buildUserMessage !== 'function') {
    return { delivered: false, reason: STEER_REJECT.RUNTIME_CLOSED };
  }

  ensureSteerMaps(runtime);
  const hasAttachments = Array.isArray(params.attachments) && params.attachments.length > 0;
  const requestedSessionId = (typeof params.sessionId === 'string' && params.sessionId.trim() !== '')
    ? params.sessionId.trim()
    : (runtime.sessionId || '');
  const userMessage = await buildUserMessage(params, hasAttachments, requestedSessionId);
  const uuid = randomUUID();
  userMessage.priority = 'next';
  userMessage.uuid = uuid;

  const steerId = typeof params.steerId === 'string' ? params.steerId : '';
  runtime.pendingSteers.set(uuid, {
    steerId,
    enqueuedAt: Date.now(),
    prompt: extractSteerPrompt(userMessage),
  });
  runtime.inputStream.enqueue(userMessage);
  return { delivered: true };
}
