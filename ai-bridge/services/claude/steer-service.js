/**
 * Claude live-turn steer: inject a user message with priority 'next' into the
 * in-flight query, then fold/undeliver it from the turn stream.
 *
 * Capability is gated at runtime (CLI >= 2.1.220 and cancelAsyncMessage).
 * Folded rows are inserted by Java from [STEER_FOLDED], not from CLI replay.
 */

import { randomUUID } from 'node:crypto';
import { getActiveTurnRuntime, getRuntimeForSession } from './runtime-registry.js';

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

/** A steerId is echoed to stderr and host logs: only an inert charset is safe. */
const STEER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Cap on remembered fold records. Replay de-duplication only needs the folds
 * observed while the current turn stream is being read, so a small ring is
 * enough; without a cap a long turn with many steers would grow unbounded.
 */
export const MAX_FOLDED_STEERS = 32;

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
 * Forget every folded steer record. Called at the start of each turn.
 *
 * Folded records exist only to recognise a `--replay-user-messages` echo of a
 * row this host already inserted. Keeping them past the turn that produced
 * them is wrong twice over: matching falls back to prompt text, so a later
 * genuine user message that repeats a steered sentence (a plain "continue")
 * would be swallowed as a replay and never reach the transcript; and the map
 * would grow for the lifetime of the runtime.
 *
 * @param {object} runtime
 */
export function resetFoldedSteers(runtime) {
  if (!runtime || !(runtime.foldedSteers instanceof Map)) {
    return;
  }
  runtime.foldedSteers.clear();
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
  // A blank id on either side is never a match: several tool windows share
  // this daemon, and a loose match could inject the message into another
  // session's live turn running in another project directory.
  if (!a || !b) {
    return false;
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
  while (runtime.foldedSteers.size > MAX_FOLDED_STEERS) {
    const oldest = runtime.foldedSteers.keys().next().value;
    runtime.foldedSteers.delete(oldest);
  }
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
    // Prefer the carrier's uuid: several steers can be outstanding at once, and
    // commandMode 'prompt' is shared with the CLI's own queue.
    const carrierUuid = typeof attachment.uuid === 'string' ? attachment.uuid.trim() : '';
    if (carrierUuid && runtime.pendingSteers.has(carrierUuid)) {
      return foldSteerRecord(
        runtime,
        carrierUuid,
        runtime.pendingSteers.get(carrierUuid),
        attachment.prompt,
      );
    }
    if (runtime.pendingSteers.size > 0) {
      return foldOldestPendingSteer(runtime, attachment.prompt);
    }
    // Nothing pending: commandMode 'prompt' is not ours alone — the CLI's own
    // queue (peer/channel injects, SendMessage, TUI input) uses it too. Only
    // swallow a carrier whose uuid proves it is a replay of a steer we already
    // folded; anything else must flow to [MESSAGE]. Matching on prompt text
    // here would also swallow an unrelated message that repeats the sentence.
    const attachmentUuid = typeof attachment.uuid === 'string' ? attachment.uuid.trim() : '';
    if (attachmentUuid && runtime.foldedSteers.has(attachmentUuid)) {
      return true;
    }
    return false;
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
  // Prompt matching against pendingSteers claims a fold whose uuid the CLI
  // rewrote; it is bounded to the injection this turn and never reaches a
  // message the host did not send. Folded records are matched by uuid only:
  // a prompt hit there would silently drop an unrelated message that happens
  // to repeat a steered sentence.
  for (const [pendingUuid, record] of runtime.pendingSteers.entries()) {
    if (normalizePromptText(record.prompt) === promptText) {
      return foldSteerRecord(runtime, pendingUuid, record, prompt);
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

  // queued_turn_count is optional on the SDK result: treat "unknown" as "no
  // queued turn" so a missing field can never park this request on
  // turnSink.take() forever.
  if (keepReading && (resultMsg?.queued_turn_count ?? 0) !== 0) {
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
  // Several tool windows share this daemon and activeTurnRuntime is a
  // process-wide pointer overwritten by every executeTurn. Locate the runtime
  // by the caller's sessionId first; only an anonymous request (no sessionId
  // yet) falls back to the active pointer.
  const requestedSessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  const runtime = requestedSessionId
    ? (getRuntimeForSession(requestedSessionId) || getActiveTurnRuntime())
    : getActiveTurnRuntime();
  if (!runtime) {
    return { delivered: false, reason: STEER_REJECT.NO_ACTIVE_TURN };
  }
  if (runtime.closed) {
    return { delivered: false, reason: STEER_REJECT.RUNTIME_CLOSED };
  }
  if (!runtime.turnSink) {
    return { delivered: false, reason: STEER_REJECT.NO_ACTIVE_TURN };
  }
  // sessionId is the primary key when the caller knows it; the exact epoch
  // must always match and carries the anonymous case (new session before
  // [SESSION_ID] lands). Blank ids never count as a match.
  if ((requestedSessionId && !idsMatch(requestedSessionId, runtime.sessionId))
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
  const userMessage = await buildUserMessage(params, hasAttachments, requestedSessionId || runtime.sessionId || '');
  const uuid = randomUUID();
  userMessage.priority = 'next';
  userMessage.uuid = uuid;

  const rawSteerId = typeof params.steerId === 'string' ? params.steerId.trim() : '';
  // Drop a steerId that could forge a log line; the steer itself still works,
  // it just loses its frontend correlation handle.
  const steerId = STEER_ID_PATTERN.test(rawSteerId) ? rawSteerId : '';
  runtime.pendingSteers.set(uuid, {
    steerId,
    enqueuedAt: Date.now(),
    prompt: extractSteerPrompt(userMessage),
  });
  runtime.inputStream.enqueue(userMessage);
  return { delivered: true };
}
