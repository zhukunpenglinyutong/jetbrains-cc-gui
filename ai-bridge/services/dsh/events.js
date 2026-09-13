/**
 * DSH mux WebSocket → projected turn events (ported from
 * desktop-cc-gui engine/dsh/events.rs), plus the approval / question bridge
 * that settles host-minted requests through the plugin's permission IPC.
 */

import { requestPermissionFromJava, requestAskUserQuestionAnswers } from '../../permission-ipc.js';
import { DshWebSocket } from './ws-client.js';

const FAILURE_TURN_END_KINDS = new Set(['cancelled', 'aborted', 'error', 'failed']);
const GOAL_PHASES = new Set(['active', 'paused', 'blocked', 'complete', 'completed']);

/** Raw mux frames may arrive bare or wrapped in a `server-request` envelope. */
export function unwrapMuxEnvelope(raw) {
  if (!raw || typeof raw !== 'object') {
    return { frame: {}, rpcId: null };
  }
  const rpcId = typeof raw.rpcId === 'string' && raw.rpcId ? raw.rpcId : null;
  if (raw.type === 'server-request') {
    const frame = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
    return { frame, rpcId };
  }
  return { frame: raw, rpcId };
}

export function peekMuxSessionId(raw) {
  if (!raw || typeof raw !== 'object') {
    return '';
  }
  const direct = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  if (direct) {
    return direct;
  }
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : null;
  if (payload && typeof payload.sessionId === 'string') {
    return payload.sessionId;
  }
  return '';
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function intField(value, keys) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.trunc(raw);
    }
  }
  return null;
}

function extractContentText(block) {
  if (!block || typeof block !== 'object') {
    return '';
  }
  const text = asString(block.text).trim();
  if (text) {
    return text;
  }
  const content = block.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const entry of content) {
      if (typeof entry === 'string' && entry.trim()) {
        parts.push(entry);
      } else if (entry && typeof entry === 'object' && asString(entry.text).trim()) {
        parts.push(entry.text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

function extractToolResultOutput(data) {
  const message = data && typeof data === 'object' ? data.message : null;
  const blocks = message && Array.isArray(message.content) ? message.content : null;
  if (blocks && blocks.length > 0) {
    const text = extractContentText(blocks[0]);
    if (text) {
      return text;
    }
    return blocks[0];
  }
  return message ?? null;
}

function parseCompleteJsonObject(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // partial fragment — not projectable
  }
  return null;
}

/** Normalize DSH tool arguments (raw model JSON string) into an object when possible. */
export function normalizeDshToolArguments(value) {
  if (value == null) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  if (typeof value !== 'string') {
    return { value: String(value) };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return { value: parsed };
  } catch {
    return { raw: trimmed };
  }
}

function projectStreamChunk(data) {
  const chunk = data && typeof data === 'object' && data.chunk && typeof data.chunk === 'object'
    ? data.chunk
    : data;
  if (!chunk || typeof chunk !== 'object') {
    return [];
  }
  switch (asString(chunk.type)) {
    case 'text-delta': {
      const text = asString(chunk.text);
      return text ? [{ kind: 'text-delta', text }] : [];
    }
    case 'reasoning-delta': {
      const text = asString(chunk.text);
      return text ? [{ kind: 'reasoning-delta', text }] : [];
    }
    case 'usage': {
      const usage = chunk.usage && typeof chunk.usage === 'object' ? chunk.usage : chunk;
      return [{
        kind: 'usage',
        inputTokens: intField(usage, ['uncachedInputTokens', 'inputTokens', 'input']),
        outputTokens: intField(usage, ['outputTokens', 'output']),
        cachedTokens: intField(usage, ['cacheReadTokens', 'cachedTokens']),
      }];
    }
    default:
      return [];
  }
}

function turnEndFailure(data) {
  const kind = asString(data && data.reason && data.reason.kind) || 'error';
  const failure = data && data.reason && typeof data.reason === 'object' ? data.reason.error : null;
  const code = failure && asString(failure.code).trim() ? asString(failure.code).trim() : null;
  const message = failure && asString(failure.message).trim() ? asString(failure.message).trim() : null;
  return {
    error: message || code || kind,
    code: code || kind,
  };
}

function projectSessionEvent(event) {
  if (!event || typeof event !== 'object') {
    return [];
  }
  const type = asString(event.type);
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  switch (type) {
    case 'turn/start':
      return [{ kind: 'turn-start' }];
    case 'turn/end': {
      const kind = asString(data.reason && data.reason.kind) || 'completed';
      if (FAILURE_TURN_END_KINDS.has(kind)) {
        const failure = turnEndFailure(data);
        return [{ kind: 'turn-error', error: failure.error, code: failure.code }];
      }
      return [{ kind: 'turn-completed', result: data }];
    }
    case 'assistant/chunk':
      return projectStreamChunk(data);
    // `assistant/message` is the complete snapshot; live text already arrived
    // as chunk deltas. Re-emitting would duplicate the bubble.
    case 'assistant/message':
      return [];
    case 'tool/call': {
      const toolId = asString(data.id) || asString(data.callId) || 'tool';
      const toolName = asString(data.name) || 'tool';
      return [{
        kind: 'tool-call',
        toolId,
        toolName,
        input: normalizeDshToolArguments(data.arguments ?? data.args),
      }];
    }
    case 'tool/result': {
      const message = data.message && typeof data.message === 'object' ? data.message : null;
      const source = message && message.source && typeof message.source === 'object' ? message.source : null;
      const firstBlock = message && Array.isArray(message.content) && message.content.length > 0
        ? message.content[0]
        : null;
      const toolId =
        asString(data.id) ||
        asString(data.callId) ||
        asString(data.toolCallId) ||
        (source ? asString(source.callId) : '') ||
        (firstBlock ? asString(firstBlock.toolCallId) : '') ||
        'tool';
      let output = data.result ?? data.output ?? extractToolResultOutput(data);
      let isError = false;
      if (data.error) {
        isError = true;
        if (typeof data.error === 'string') {
          output = data.error;
        } else if (typeof data.error === 'object') {
          output = asString(data.error.message) || asString(data.error.code) || JSON.stringify(data.error);
        }
      } else if (firstBlock && firstBlock.isError === true) {
        isError = true;
        const text = extractContentText(firstBlock);
        if (text) {
          output = text;
        }
      }
      return [{
        kind: 'tool-result',
        toolId,
        toolName: asString(data.name) || null,
        output,
        isError,
      }];
    }
    case 'user/message': {
      const source = data.source && typeof data.source === 'object' ? data.source : null;
      const sourceKind = source ? asString(source.kind).toLowerCase() : '';
      if (sourceKind === 'goal') {
        const text = asString(data.text) ||
          (Array.isArray(data.content)
            ? data.content.map((block) => (block && asString(block.text)) || '').join('')
            : '');
        return text.trim() ? [{ kind: 'goal-injection', text }] : [];
      }
      return [];
    }
    case 'goal/change':
      return [{ kind: 'goal-change', data }];
    default:
      return [];
  }
}

function projectSessionProjection(frame) {
  const key = asString(frame.key);
  const value = frame.value && typeof frame.value === 'object' ? frame.value : {};
  if (key === 'tokenUsage') {
    return [{
      kind: 'usage',
      inputTokens: intField(value, ['uncachedInputTokens', 'inputTokens', 'input']),
      outputTokens: intField(value, ['outputTokens', 'output']),
      cachedTokens: intField(value, ['cacheReadTokens', 'cachedTokens']),
    }];
  }
  return [];
}

/**
 * Project one mux frame into turn events.
 * frameType: frame.type (e.g. "session/event" / "approval/requested").
 */
export function projectMuxFrame(frameType, frame, rpcId) {
  switch (frameType) {
    case 'session/event': {
      const event = frame.event && typeof frame.event === 'object' ? frame.event : frame;
      return projectSessionEvent(event);
    }
    case 'session/projection':
      return projectSessionProjection(frame);
    case 'approval/requested': {
      if (!rpcId) {
        return [];
      }
      const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
      const approvalId = asString(frame.approvalId) || asString(payload.approvalId);
      if (!approvalId) {
        return [];
      }
      return [{
        kind: 'approval-request',
        rpcId,
        approvalId,
        toolName:
          asString(frame.toolName) ||
          asString(frame.tool) ||
          asString(payload.toolName) ||
          asString(payload.tool) ||
          'dsh-tool',
        message:
          asString(frame.reason) ||
          asString(payload.reason) ||
          asString(payload.message) ||
          '',
        input: frame,
      }];
    }
    case 'question/requested': {
      if (!rpcId) {
        return [];
      }
      const questions = Array.isArray(frame.questions)
        ? frame.questions
        : Array.isArray(frame.payload)
          ? frame.payload
          : [];
      return [{ kind: 'question-request', rpcId, questions }];
    }
    default:
      return [];
  }
}

/**
 * Goal-aware turn settlement (desktop-cc-gui `apply_dsh_goal_settlement`).
 * While a Goal is `active`, a hop's `turn/end(completed)` must NOT settle the
 * composer turn — the host drives the next hop. Settle on non-active goal
 * phases, failures, or plain turns.
 */
export class DshGoalSettlement {
  #phase = null;
  #awaitingIdle = false;

  /**
   * @param {'turn-start'|'turn-completed'|'turn-error'|'goal-change'} kind
   * @param {object} [data] goal-change payload
   * @returns {'suppress'|'settle'|'continue'}
   */
  feed(kind, data) {
    if (kind === 'goal-change') {
      this.#applyGoalChange(data || {});
      if (this.#awaitingIdle && this.#phase !== 'active') {
        this.#awaitingIdle = false;
        return 'settle';
      }
      return 'continue';
    }
    if (kind === 'turn-start') {
      this.#awaitingIdle = false;
      return 'continue';
    }
    if (kind === 'turn-error') {
      this.#awaitingIdle = false;
      return 'settle';
    }
    if (kind === 'turn-completed') {
      if (this.#phase === 'active') {
        this.#awaitingIdle = true;
        return 'suppress';
      }
      return 'settle';
    }
    return 'continue';
  }

  #applyGoalChange(data) {
    const goal = data.goal && typeof data.goal === 'object' ? data.goal : null;
    const operation = asString(data.operation || (goal && goal.operation)).toLowerCase();
    if (operation === 'clear' || (data.goal === null && 'goal' in data)) {
      this.#phase = null;
      return;
    }
    const rawPhase = asString((goal && goal.phase) || data.phase).toLowerCase();
    if (GOAL_PHASES.has(rawPhase)) {
      this.#phase = rawPhase === 'completed' ? 'complete' : rawPhase;
    }
  }
}

/**
 * Settle a DSH approval request through the plugin's permission dialog.
 * Returns true when the respond RPC succeeded.
 */
export async function bridgeDshApproval(client, event, sessionId, log = () => {}) {
  try {
    const allowed = await requestPermissionFromJava(event.toolName, {
      tool: event.toolName,
      reason: event.message || undefined,
      approvalId: event.approvalId,
      input: event.input,
    });
    await client.respond(event.rpcId, {
      sessionId,
      approvalId: event.approvalId,
      outcome: allowed ? 'allowed-once' : 'rejected',
    });
    log(`[dsh] approval ${event.approvalId} ${allowed ? 'allowed-once' : 'rejected'}`);
    return true;
  } catch (error) {
    log(`[dsh] approval respond failed: ${error.message}`);
    // Best-effort rejection so the host request is not parked until the watchdog.
    try {
      await client.respond(event.rpcId, {
        sessionId,
        approvalId: event.approvalId,
        outcome: 'rejected',
      });
    } catch {
      // secondary failure — the host-side watchdog will settle it
    }
    return false;
  }
}

/**
 * Settle a DSH question request through the plugin's AskUserQuestion dialog.
 */
export async function bridgeDshQuestion(client, event, sessionId, log = () => {}) {
  try {
    const answers = await requestAskUserQuestionAnswers({ questions: event.questions });
    await client.respond(event.rpcId, {
      sessionId,
      answer: { answers: mapQuestionAnswers(answers) },
    });
    log('[dsh] question answered');
    return true;
  } catch (error) {
    log(`[dsh] question respond failed: ${error.message}`);
    // Best-effort empty answer so the host request is not parked until the watchdog.
    try {
      await client.respond(event.rpcId, {
        sessionId,
        answer: { answers: [] },
      });
    } catch {
      // secondary failure — the host-side watchdog will settle it
    }
    return false;
  }
}

function mapQuestionAnswers(answers) {
  if (!answers || typeof answers !== 'object') {
    return [];
  }
  return Object.entries(answers).map(([id, value]) => {
    let selected = [];
    if (value && typeof value === 'object' && Array.isArray(value.answers)) {
      selected = value.answers;
    } else if (Array.isArray(value)) {
      selected = value;
    } else if (typeof value === 'string') {
      selected = [value];
    }
    return { id, selected };
  });
}

/**
 * Mux WebSocket lifecycle with reconnect. Delivers unwrapped frames to
 * `onFrame(frame, rpcId, raw)`.
 */
export class DshMuxConnection {
  #url;
  #onFrame;
  #log;
  #ws = null;
  #stopped = false;
  #retry = 0;
  #retryTimer = null;
  #openListeners = [];

  constructor(url, onFrame, log = () => {}) {
    this.#url = url;
    this.#onFrame = onFrame;
    this.#log = log;
  }

  connect() {
    if (this.#stopped) {
      return;
    }
    const ws = new DshWebSocket();
    this.#ws = ws;
    ws.on('error', (error) => {
      this.#log(`[dsh] mux error: ${error.message}`);
    });
    ws.on('open', () => {
      this.#retry = 0;
      this.#log(`[dsh] mux connected ${this.#url}`);
      const listeners = this.#openListeners.splice(0);
      for (const listener of listeners) {
        listener();
      }
    });
    ws.on('message', (text) => {
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        return;
      }
      const { frame, rpcId } = unwrapMuxEnvelope(raw);
      try {
        this.#onFrame(frame, rpcId, raw);
      } catch (error) {
        this.#log(`[dsh] mux frame handler threw: ${error.message}`);
      }
    });
    ws.on('close', () => {
      if (this.#stopped) {
        return;
      }
      this.#retry += 1;
      const delay = Math.min(10_000, 500 * 2 ** Math.max(0, this.#retry - 1));
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        this.connect();
      }, delay);
    });
    ws.connect(this.#url);
  }

  /** Resolve once the socket is open (or immediately if already open). */
  whenOpen() {
    if (this.#ws && this.#ws.isOpen) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#openListeners.push(resolve);
    });
  }

  close() {
    this.#stopped = true;
    // Drop a pending reconnect so a one-shot bridge process exits promptly.
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#openListeners.splice(0).forEach((resolve) => resolve());
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
  }
}
