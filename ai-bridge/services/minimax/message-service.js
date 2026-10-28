/**
 * MiniMax Code CLI message service.
 *
 * Spawns local `minimax` (mcode) headless mode and maps its stream-json NDJSON
 * onto the shared bridge marker protocol (same markers as Grok/Kimi/OpenCode).
 *
 * CLI:
 *   minimax exec --output-format stream-json --cwd <dir> --permission <policy>
 *        [--model <provider/model>] [--session <id>] "<prompt>"
 *
 * Two NDJSON schemas are supported: the CLI changed its event contract between
 * releases, so the bridge must understand both to stay version-agnostic.
 *
 * Evidence legend — every 0.5.x protocol claim below is tagged, because the
 * module has very little observational evidence and must not imply more:
 *   Verified: seen verbatim in the two real 0.5.5 runs captured in
 *     services/minimax/fixtures/mcode-0.5.5-stream.ndjson (the only
 *     observational evidence this module has).
 *   Assumed:  read from the installed 0.5.5 bundle source, NOT observed in any
 *     capture — pending verification by a real sampling run.
 *
 * Schema A — mcode >= 0.5, item-based.
 *
 * Verified (every line below occurs in the capture):
 *   {"type":"exec.started","sessionId":"mvs_...","runId":...}
 *   {"type":"session.started","sessionId":"mvs_...",...}      // fresh run
 *   {"type":"session.resumed","sessionId":"mvs_...",...}      // --session run
 *   {"type":"turn.started","sessionId":"mvs_...","turnId":...}
 *   {"type":"item.started"|"item.updated","item":{"id","type":"agent_message",
 *      "contentDelta":"..."}}
 *   {"type":"item.completed","item":{"id","type":"agent_message","content":"<full text>"}}
 *   {"type":"item.*","item":{"id","type":"tool_call",
 *      "toolCall":{"id","name","status","input","output"}}}
 *   {"type":"turn.completed","usage":{inputTokens,outputTokens,cacheReadTokens,
 *      totalTokens},"durationMs":...}
 *   {"type":"exec.completed","result":{"type":"exec.result","sessionId","status","output",...}}
 *
 * Assumed (bundle source only — the capture holds 0 turn.failed lines, 0
 * reasoning items and no error object, so none of the following has been seen
 * on the wire):
 *   {"type":"turn.failed","status":...,"error":{"category","code","message",
 *      "retryable"},"durationMs":...}                       // carries no usage
 *   {"type":"item.started"|"item.completed","item":{"type":"reasoning",...}}
 *   usage may additionally carry cacheWriteTokens / reasoningTokens /
 *      requestDurationMs
 *
 *   The first four lines above are four separate events: ensureStarted() emits
 *   exec.started, then session.started|session.resumed, then turn.started, and
 *   event() injects sessionId/turnId into every one of them. All three carry the
 *   same sessionId, so they resolve to a single [SESSION_ID] marker.
 *
 *   Assumed (unverified): turn.failed is NOT a terminal event — 0.5.5 is
 *   believed to still send exec.completed after it, so termination stays with
 *   exec.completed / exec.result and turn.failed would only contribute status +
 *   error text. Source: the bundle's emit order. The capture contains no
 *   turn.failed line at all, so this is an inference, not an observation, and
 *   it is pending real-sampling verification. Because the assumption is
 *   load-bearing, turn.failed is also treated as non-terminal state: if a run
 *   never produces a result event, sendMessage's finally block surfaces the
 *   reason as [SEND_ERROR] (createMiniMaxEventHandler) instead of leaving the
 *   UI with no output. That orphan case is asserted from a constructed sample.
 *
 *   Verified: toolCall.status is an Int32 in the capture — 4/5 rows carry
 *   neither input nor output, 1 attaches input, 2 attaches output.content[].
 *   Assumed: 4 = pending, 5 = running (the bundle's own naming of those two
 *   values). Only 1 and 2 are surfaced, so each tool is announced once and
 *   always with real arguments; 4/5 fall through to
 *   {kind:'other', reason:'tool_pending'} and the drift detector counts them
 *   under skipped_tool_pending, never as an unknown type — otherwise the rows a
 *   healthy run always emits would hide a real 0.5.6 rename behind noise.
 *   normalizeToolStatus() also accepts the pure-numeric strings "1"/"2" as a
 *   defensive fallback; no word aliases ("started"/"completed"/"succeeded"/…)
 *   are ever compared — that table belongs to a legacy-protocol telemetry
 *   observer, not to the 0.5.x wire format.
 *
 *   Assumed: error is an object, not a string:
 *   {category, code, message, retryable}. It is read as message → code →
 *   payload.message, and a run with no usable text falls back to
 *   `MiniMax CLI run failed (status: <status>)`. A successful capture carries no
 *   error object, so both shapes are asserted from constructed samples.
 *
 *   Verified: a CLI-supplied totalTokens is passed through unchanged (the
 *   capture always sends one). Assumed: when the CLI omits it, the value is
 *   reconstructed as input + cache_creation + cache_read + output, matching the
 *   Java TokenUsageUtils.calculateTotalTokens formula (input_tokens +
 *   cache_creation_input_tokens + cache_read_input_tokens + output_tokens).
 *   That is deliberately NOT the mcode CLI status-bar formula (input +
 *   output), so a reconstructed total can exceed the CLI's own number.
 *   reasoning_tokens is forwarded for parity only: Java TokenUsageUtils does
 *   not read it today.
 *
 * Schema B — legacy mcode 0.2.x – 0.4.x:
 *   {"type":"heartbeat","turnId":...}
 *   {"type":"message","message":{"role":"user"|"assistant","content",...,"usage":{...}}}
 *   {"type":"generic","eventType":...}                       (UI noise)
 *   {"type":"session-status","status":"started"|"finished"}
 *   {"type":"delta","role":"assistant","thinking":"..."|"content":"...",...}
 *   {"type":"delta","role":"assistant","toolCalls":[{"id","name","status","input","output"}]}
 *   {"type":"done","turnId":...}
 *   {"type":"exec.result","sessionId":"mvs_...","answer":...,"status":"succeeded"}
 *
 *   toolCalls status: 1 = call started, 2 = finished (with output.content[]).
 *
 * The CLI keeps running past its completion event — the child tree is killed
 * once that event is seen (isMiniMaxTerminalLine, wired as shouldTerminate).
 *
 * Auth/config comes from the MiniMax CLI native home (~/.minimax).
 */

import { homedir } from 'os';
import { resolveMiniMaxCliPath, enrichPathWithBinDirs, commonCliBinDirs } from '../../utils/cli-path.js';
import { runCliStreaming } from '../../utils/cli-spawn.js';
import {
  beginStream,
  emitJsonStringMarker,
  emitSendError,
  emitSessionId,
  emitUsage,
  emitToolResultMessage,
  emitToolUseMessage,
  isNonEmptySessionId,
  safePromptArg,
} from '../../utils/marker-protocol.js';
import {
  cleanupMaterializedImagePaths,
  materializeImageAttachments,
} from '../../utils/cli-image-input.js';

function logDebug(...args) {
  console.error('[DEBUG][MiniMax]', ...args);
}

// --- protocol-drift detector -------------------------------------------------
// Every line that resolves to {kind:'other'} is tallied by its raw `type`,
// except the ones the parser recognizes as an intentional skip: those arrive
// with a known reason and land in their own bucket. Without that split, the
// toolCall.status 4/5 rows a 100%-healthy 0.5.5 run always emits would be
// structurally indistinguishable from real drift, every run would warn, and a
// 0.5.6 rename would drown in noise that always appears anyway.
const KNOWN_SKIP_REASONS = new Set(['tool_pending']);
const unknownTypeCounts = new Map();
const skippedShapeCounts = new Map();

function recordUnknownType(type, reason) {
  if (KNOWN_SKIP_REASONS.has(reason)) {
    const seen = (skippedShapeCounts.get(reason) || 0) + 1;
    skippedShapeCounts.set(reason, seen);
    return;
  }
  if (typeof type !== 'string' || !type) return;
  const next = (unknownTypeCounts.get(type) || 0) + 1;
  unknownTypeCounts.set(type, next);
  // Log the first sighting of every type so drift is visible mid-run without
  // repeating the line for each occurrence.
  if (next === 1) logDebug('unhandled event type:', type);
}

/** Truly unhandled event types seen so far, as {type: count}. */
export function getMiniMaxUnknownTypeCounts() {
  return Object.fromEntries(unknownTypeCounts);
}

/**
 * Intentional skips seen so far, as {reason: count} — e.g. `{tool_pending: 6}`
 * for the toolCall.status 4/5 rows. Kept apart from the unknown tally so a
 * healthy run can never be read as protocol drift; the flush summary prints
 * them as `skipped_<reason>=<count>`.
 */
export function getMiniMaxSkippedShapeCounts() {
  return Object.fromEntries(skippedShapeCounts);
}

/** Drop both tallies (used between runs and by tests). */
export function resetMiniMaxUnknownTypeCounts() {
  unknownTypeCounts.clear();
  skippedShapeCounts.clear();
}

/**
 * Log one line for the intentional skips and one top-N line for the real
 * unknowns (stderr only, once per run).
 */
export function flushMiniMaxUnknownTypeCounts(topN = 5) {
  if (skippedShapeCounts.size > 0) {
    const skipped = [...skippedShapeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `skipped_${reason}=${count}`);
    logDebug('skipped known event shapes:', skipped.join(', '));
  }
  if (unknownTypeCounts.size === 0) return;
  const top = [...unknownTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([type, count]) => `${type}=${count}`);
  logDebug(`unhandled event types (top ${topN}):`, top.join(', '));
}

/**
 * Map CCGUI permission modes onto mcode --permission policies
 * (ask | smart | full | off). "ask" is never used: headless exec cannot
 * answer an interactive permission prompt.
 */
function resolvePermissionPolicy(permissionMode) {
  const value = String(permissionMode || '').trim().toLowerCase();
  if (
    value === 'bypasspermissions'
    || value === 'bypass'
    || value === 'dangerouslyskippedpermissions'
    || value === 'yolo'
    || value === 'off'
  ) {
    return 'off';
  }
  if (value === 'acceptedits' || value === 'acceptall' || value === 'full') {
    return 'full';
  }
  return 'smart';
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

function extractToolOutputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  const content = output.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
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
 * Normalize a MiniMax (mcode) usage payload into the snake_case shape the
 * shared marker protocol expects (consumed by Java TokenUsageUtils, which
 * reads input_tokens / cache_creation_input_tokens / cache_read_input_tokens /
 * output_tokens / total_tokens).
 *
 * The mcode CLI emits camelCase fields (inputTokens / outputTokens /
 * reasoningTokens / cacheReadTokens / cacheWriteTokens / totalTokens) and may
 * attach non-token fields such as requestDurationMs — those are dropped here.
 * cacheWriteTokens maps to cache_creation_input_tokens because that is the key
 * Java TokenUsageUtils.java:35-36 / :54 reads; dropping it made cache writes
 * invisible to billing. Any field whose value is not a positive integer is
 * omitted, so a payload without cacheWriteTokens keeps the previous shape.
 *
 * When total_tokens is missing it is reconstructed as the Java-side formula
 * (input + cache_creation + cache_read + output) — see the file header for why
 * that differs from the CLI's own input+output status-bar number.
 *
 * Returns null when the input is unusable (non-object, array, null, or every
 * tracked field is missing/non-positive), so callers can skip emission
 * instead of sending a zeroed usage marker.
 */
export function normalizeMiniMaxUsage(usage) {
  if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) {
    return null;
  }
  const result = {};
  const fields = [
    ['input_tokens', 'inputTokens'],
    ['cache_creation_input_tokens', 'cacheWriteTokens'],
    ['cache_read_input_tokens', 'cacheReadTokens'],
    ['output_tokens', 'outputTokens'],
    ['reasoning_tokens', 'reasoningTokens'],
    ['total_tokens', 'totalTokens'],
  ];
  for (const [snake, camel] of fields) {
    const raw = usage[camel];
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
      result[snake] = raw;
    }
  }
  if (result.total_tokens == null) {
    const sum = (result.input_tokens || 0)
      + (result.cache_creation_input_tokens || 0)
      + (result.cache_read_input_tokens || 0)
      + (result.output_tokens || 0);
    if (sum > 0) {
      result.total_tokens = sum;
    }
  }
  if (Object.keys(result).length === 0) {
    return null;
  }
  return result;
}

/**
 * Read the failure reason out of a completion payload.
 *
 * 0.5.x sends `error` as an object ({category, code, message, retryable}) while
 * 0.2.x–0.4.x sends a plain string, so both shapes are accepted: a non-empty
 * string is used verbatim, an object is read as message → code, and the
 * top-level `message` field stays the last in-protocol fallback. The caller
 * substitutes `MiniMax CLI run failed (status: …)` when this returns ''.
 */
function extractErrorText(payload) {
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    if (message) return message;
    const code = typeof error.code === 'string' ? error.code.trim() : '';
    if (code) return code;
  }
  return typeof payload.message === 'string' ? payload.message.trim() : '';
}

/**
 * Build the terminal result event from a completion payload.
 *
 * Schema A nests the payload under `exec.completed.result`, schema B sends it
 * at the top level as `exec.result`; both share the same field names.
 */
function buildMiniMaxResultEvent(payload) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  const status = typeof payload.status === 'string' ? payload.status : '';
  const errorMessage = extractErrorText(payload);
  // The envelope may carry the full answer text; kept so a run that streamed
  // nothing can still publish it once (see createResultKindHandler).
  const answer = typeof payload.answer === 'string' ? payload.answer : '';
  // Anything other than an explicit success counts as failure: the stream
  // is terminated on this line, so a failed run must not end in silence.
  const failed = status !== '' && status.toLowerCase() !== 'succeeded';
  return { kind: 'result', sessionId, status, failed, errorMessage, answer };
}

/**
 * Normalize a tool-call status onto the numeric 0.5.x wire form.
 *
 * Real 0.5.5 runs send an Int32 (1 = started with input, 2 = finished with
 * output; 4/5 = pending/running carrying neither), so numbers pass through
 * untouched and 4/5 deliberately end up as {kind:'other'} rather than empty
 * tool cards. A pure numeric string ("1"/"2") is accepted as a defensive
 * fallback in case some upstream encoder types the field as a string.
 *
 * Nothing else is accepted — in particular the word aliases "started" /
 * "completed" / "succeeded" / "success" / "failed" / "error" are NOT compared
 * anywhere. That table lives in a legacy-protocol telemetry observer
 * (delta/message events), not in the 0.5.x stream-json wire format, and 0.5.5
 * never emits those strings for toolCall.status.
 */
export function normalizeToolStatus(status) {
  if (typeof status === 'number') {
    return Number.isFinite(status) ? status : undefined;
  }
  if (typeof status === 'string') {
    const trimmed = status.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
  }
  return undefined;
}

/**
 * Map one schema-A item lifecycle event (`item.started` / `item.updated` /
 * `item.completed`) onto an event descriptor.
 *
 * Streaming deltas arrive on started/updated; the completed event repeats the
 * whole text, so it is reported as `*_final` and de-duplicated by the caller
 * against the deltas already emitted for the same item id.
 */
function parseMiniMaxItemEvent(value, type) {
  const item = value.item;
  if (!item || typeof item !== 'object') return { kind: 'other' };
  const itemType = typeof item.type === 'string' ? item.type : '';
  const itemId = typeof item.id === 'string' ? item.id : '';
  const isFinal = type === 'item.completed';

  if (itemType === 'tool_call') {
    const call = item.toolCall && typeof item.toolCall === 'object' ? item.toolCall : item;
    const name = typeof call.name === 'string' && call.name ? call.name : 'tool';
    const id = typeof call.id === 'string' && call.id
      ? call.id
      : (itemId || `minimax-tool-${name}`);
    const toolCall = { id, name, input: parseToolArguments(call.input) };
    const status = normalizeToolStatus(call.status);
    if (status === 2) {
      return { kind: 'tool_done', call: toolCall, output: extractToolOutputText(call.output) };
    }
    // Statuses 4/5 are pending/running and carry no input; waiting for 1 keeps
    // the tool card from appearing with empty arguments, so they deliberately
    // fall through to {kind:'other'} — tagged with the known reason
    // 'tool_pending' so the drift detector buckets them as
    // skipped_tool_pending instead of as protocol drift.
    if (status === 1) {
      return { kind: 'tool_start', call: toolCall };
    }
    return { kind: 'other', reason: 'tool_pending' };
  }

  if (itemType === 'reasoning' || itemType === 'agent_message') {
    const isThinking = itemType === 'reasoning';
    if (!isFinal) {
      const delta = typeof item.contentDelta === 'string' ? item.contentDelta : '';
      if (!delta) return { kind: 'other' };
      return { kind: isThinking ? 'thinking' : 'text', data: delta, messageId: itemId };
    }
    const full = typeof item.content === 'string' ? item.content : '';
    if (!full) return { kind: 'other' };
    return { kind: isThinking ? 'thinking_final' : 'text_final', data: full, messageId: itemId };
  }

  return { kind: 'other' };
}

/**
 * True when a session id may be interpolated into a [SESSION_ID] line.
 *
 * Root cause: marker-protocol.js `emitSessionId` is a bare template
 * interpolation (`[SESSION_ID] ${sessionId}`) and `isNonEmptySessionId` does
 * not look at line breaks, so a sessionId carrying "\n" splits stdout into an
 * extra line and forges any marker on it — demonstrated with
 * `"mvs_ok\n[SEND_ERROR] {\"error\":\"forged\"}"`, which produced a second
 * stdout line. That file is shared with the Grok / Kimi / OpenCode bridges and
 * is out of scope for this change, so every call site in this module that can
 * reach the marker refuses CR/LF first. The global fix (rejecting CR/LF inside
 * emitSessionId / isNonEmptySessionId themselves) needs its own task.
 */
function isSafeToEmitSessionId(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return false;
  return isNonEmptySessionId(value);
}

/**
 * The schema-A (mcode >= 0.5) routing table: every `type` this protocol sends
 * is listed here and nowhere else, and each one is handled by
 * classifySchemaAStreamEvent. A type missing from this table is unhandled.
 */
const SCHEMA_A_EVENT_TYPES = new Set([
  'exec.started',
  'session.started',
  'session.resumed',
  'turn.started',
  'item.started',
  'item.updated',
  'item.completed',
  'turn.completed',
  'turn.failed',
  'exec.completed',
]);

/**
 * The schema-B (legacy mcode 0.2.x – 0.4.x) routing table, kept apart from
 * SCHEMA_A_EVENT_TYPES so neither protocol's branches can be read for the
 * other's events.
 */
const SCHEMA_B_EVENT_TYPES = new Set(['delta', 'message', 'exec.result']);

/**
 * Build the {kind:'other'} reporter shared by both protocol tables.
 *
 * `onOther` is invoked with the raw `type` of every line that resolves to
 * {kind:'other'} plus the reason for deliberate skips (undefined for shapes the
 * parser does not recognize). The reason is what feeds the protocol-drift
 * counter's skipped bucket; everything without one counts as real drift.
 */
function createOtherReporter(onOther) {
  return (type, reason) => {
    if (typeof onOther === 'function') onOther(type, reason);
    return { kind: 'other' };
  };
}

/**
 * Map one schema-A (0.5.x) line onto a small event descriptor.
 *
 * `other` is this line's reporter (createOtherReporter), so every deliberate
 * skip keeps feeding the protocol-drift buckets from the same place.
 */
function classifySchemaAStreamEvent(value, type, other) {
  switch (type) {
    // ensureStarted() emits exec.started, then session.started|session.resumed,
    // then turn.started as three separate events, and event() injects the same
    // sessionId into all three — so they share one case block and one session
    // marker.
    case 'exec.started':
    case 'session.started':
    case 'session.resumed':
    case 'turn.started': {
      // Emitted early so a run that dies mid-stream still leaves a resumable
      // session id behind; [SESSION_ID] is idempotent on the Java side.
      // A CR/LF-bearing id is not a session event at all (see
      // isSafeToEmitSessionId: it would forge a second stdout line), and the
      // CLI never sends one, so it is tallied as an unhandled type like any
      // other unexpected shape.
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
      return isSafeToEmitSessionId(sessionId)
        ? { kind: 'session', sessionId: sessionId.trim() }
        : other(type);
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const event = parseMiniMaxItemEvent(value, type);
      return event.kind === 'other' ? other(type, event.reason) : event;
    }
    case 'turn.completed':
      return value.usage && typeof value.usage === 'object'
        ? { kind: 'usage', usage: value.usage }
        : other(type);
    case 'turn.failed': {
      // 0.5.x sends {type, status, error?, durationMs} and NO usage. It is not
      // a terminal event (exec.completed still follows), so it only carries the
      // reason; no usage is inferred from it.
      const status = typeof value.status === 'string' ? value.status : '';
      return { kind: 'turn_failed', status, errorMessage: extractErrorText(value) };
    }
    case 'exec.completed':
      return buildMiniMaxResultEvent(
        value.result && typeof value.result === 'object' ? value.result : value,
      );
    default:
      // Only reachable if a type is routed here without a case above: an
      // unrecognized shape stays unhandled, exactly as before the split.
      return other(type);
  }
}

/**
 * Map one schema-B (legacy delta / message / exec.result) line onto a small
 * event descriptor, with the same `other` reporter as schema A.
 */
function classifySchemaBStreamEvent(value, type, other) {
  switch (type) {
    case 'delta': {
      const events = [];
      const messageId = typeof value.messageId === 'string' ? value.messageId : '';
      if (typeof value.thinking === 'string' && value.thinking) {
        events.push({ kind: 'thinking', data: value.thinking, messageId });
      }
      if (typeof value.content === 'string' && value.content) {
        events.push({ kind: 'text', data: value.content, messageId });
      }
      if (Array.isArray(value.toolCalls) && value.toolCalls.length > 0) {
        for (const call of value.toolCalls) {
          if (!call || typeof call !== 'object') continue;
          const id = typeof call.id === 'string' ? call.id : '';
          const name = typeof call.name === 'string' && call.name ? call.name : 'tool';
          const toolCall = { id: id || `minimax-tool-${name}`, name, input: parseToolArguments(call.input) };
          // Same numeric contract as schema A (P5: one normalizer for both).
          const status = normalizeToolStatus(call.status);
          if (status === 2) {
            events.push({ kind: 'tool_done', call: toolCall, output: extractToolOutputText(call.output) });
          } else if (status === 1) {
            events.push({ kind: 'tool_start', call: toolCall });
          }
        }
      }
      if (events.length === 0) return other(type);
      if (events.length === 1) return events[0];
      return { kind: 'multi', events };
    }
    case 'message': {
      const message = value.message;
      if (!message || typeof message !== 'object') return other(type);
      if (message.role === 'assistant' && message.usage && typeof message.usage === 'object') {
        return { kind: 'usage', usage: message.usage, message };
      }
      return other(type);
    }
    case 'exec.result':
      return buildMiniMaxResultEvent(value);
    default:
      // Only reachable if a type is routed here without a case above: an
      // unrecognized shape stays unhandled, exactly as before the split.
      return other(type);
  }
}

/**
 * Map one mcode stream-json line onto a small event descriptor.
 *
 * A thin dispatcher: it parses the line, picks the protocol from `type` and
 * hands the value to that protocol's table. No event branch lives here.
 */
function classifyMiniMaxStreamLine(line, onOther) {
  const other = createOtherReporter(onOther);
  if (!line || !line.trim()) return other('');
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return other('');
  }
  if (!value || typeof value !== 'object') return other('');

  const type = typeof value.type === 'string' ? value.type : '';
  if (SCHEMA_B_EVENT_TYPES.has(type)) return classifySchemaBStreamEvent(value, type, other);
  if (SCHEMA_A_EVENT_TYPES.has(type)) return classifySchemaAStreamEvent(value, type, other);
  return other(type);
}

/**
 * Parse one mcode stream-json line into an event descriptor.
 *
 * Unhandled lines are counted per `type` so a 0.5.6 protocol change shows up
 * as an explicit [DEBUG][MiniMax] line instead of silently dropping content.
 */
export function parseMiniMaxStreamLine(line) {
  return classifyMiniMaxStreamLine(line, recordUnknownType);
}

/**
 * True when the line reports that the run is over.
 *
 * Schema A ends with `exec.completed` (the legacy `exec.result` is nested
 * inside it), schema B ends with a top-level `exec.result`. Parsing beats a
 * substring match here: `"type":"exec.result"` also occurs inside the
 * completion envelope, so matching on it would couple termination to the
 * nested shape.
 */
export function isMiniMaxTerminalLine(line) {
  if (!line || !line.trim()) return false;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object') return false;
  return value.type === 'exec.completed' || value.type === 'exec.result';
}

/**
 * Prompts longer than this ride stdin even without newlines: the Windows
 * command line caps near 32k chars including the whole argv and quoteCmdArg's
 * doubling, so stay an order of magnitude below it.
 */
const STDIN_PROMPT_ARG_THRESHOLD = 12000;

/**
 * Decide whether the prompt must be piped via stdin (`mcode exec --input -`)
 * instead of riding argv.
 *
 * Windows cmd.exe command lines cannot carry a newline (everything after the
 * first line never reaches the CLI — pasted logs arrived as one line) and are
 * capped near 32k chars including quoting, so oversized prompts fail the spawn
 * outright. Short single-line prompts keep the plain argv positional.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function shouldUseStdinPrompt(text) {
  if (typeof text !== 'string') return false;
  if (/[\r\n]/.test(text)) return true;
  return text.length > STDIN_PROMPT_ARG_THRESHOLD;
}

export function buildMiniMaxArgs({ message, sessionId, model, permissionMode, cwd, imagePaths, promptViaStdin }) {
  const args = [
    'exec',
    '--output-format', 'stream-json',
    '--permission', resolvePermissionPolicy(permissionMode),
  ];
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) {
    args.push('--model', modelFlag);
  }
  if (isNonEmptySessionId(sessionId)) {
    args.push('--session', sessionId.trim());
  }
  if (cwd && cwd !== 'undefined' && cwd !== 'null') {
    args.push('--cwd', cwd);
  }
  // Native multimodal attachments: `mcode exec --file <path>` (repeatable)
  // attaches the image to the run so the model sees it directly. Flags stay
  // before the prompt positional — mcode's parser accepts options first, and
  // the prompt must remain the last argv token.
  for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
    if (imagePath && typeof imagePath === 'string') {
      args.push('--file', imagePath);
    }
  }
  if (promptViaStdin) {
    // The prompt travels on stdin (see shouldUseStdinPrompt); --input and the
    // prompt positional are mutually exclusive in mcode.
    args.push('--input', '-', '--input-format', 'text');
  } else {
    args.push(safePromptArg(message));
  }
  return args;
}

/**
 * The orphan-failure net, as a pure policy so it is testable without spawning
 * the CLI: a run that reported turn.failed but never produced a result event
 * must still tell the user why, because nothing else in the pipeline will
 * (shouldTerminate never fired, so runCliStreaming's non-zero-exit fallback
 * never fires either, and a 0-exit run is silent by definition).
 *
 * Returns the reason to surface, or '' when there is nothing to report: a run
 * that reached a result event has already been handled (and reporting again
 * would double up), and a run with no recorded reason has no text to invent.
 *
 * @param {{sawResult: boolean, turnFailureMessage: string}} streamState
 */
export function resolveUnterminatedFailureReason(streamState) {
  if (!streamState || streamState.sawResult) return '';
  return typeof streamState.turnFailureMessage === 'string' ? streamState.turnFailureMessage : '';
}

/**
 * Bind the event handler to the real marker protocol.
 *
 * This is the single place the production marker functions are named, so a
 * test injecting a fake emitter drives the exact same code path.
 */
function createMarkerEmitter() {
  return {
    sessionId: (sessionId) => emitSessionId(sessionId),
    content: (text) => emitJsonStringMarker('[CONTENT_DELTA]', text),
    thinking: (text) => emitJsonStringMarker('[THINKING_DELTA]', text),
    toolUse: (call) => emitToolUseMessage(call),
    toolResult: (payload) => emitToolResultMessage(payload),
    usage: (usage) => emitUsage(usage),
    sendError: (message, label) => emitSendError(message, label),
  };
}

/**
 * The per-run de-duplication state, as one object so the handler body stays
 * read-state → decide → emit.
 *
 * The keys are the ids the parser already put on each event (item.id for
 * schema A, messageId for the legacy delta protocol, toolCall.id for tools).
 * `streamedContentMessageIds` and `streamedThinkingMessageIds` stay two
 * independent sets on purpose: a reasoning item and an agent_message item may
 * carry the same id, and only a replay of each stream's own id may be dropped.
 * `emittedSessionId` seeds with the id this run already emitted, which is what
 * makes [SESSION_ID] once-per-run.
 */
function createDedupState(initialSessionId = '') {
  return {
    seenToolUseIds: new Set(),
    seenToolResultIds: new Set(),
    streamedContentMessageIds: new Set(),
    streamedThinkingMessageIds: new Set(),
    emittedSessionId: initialSessionId,
    turnFailureMessage: '',
    sawResult: false,
  };
}

/**
 * One emitter call site per marker, so an injected emitter sees exactly the
 * same sequence a real run would emit. The CR/LF refusal repeats the parser's
 * own guard so the `result` path cannot become a second forgery door, and the
 * once-per-run session baseline is read from (and written back to) the dedup
 * state instead of a local.
 */
function createPublishBridge(emitter, state) {
  return {
    session(sessionId) {
      if (!isSafeToEmitSessionId(sessionId) || sessionId === state.emittedSessionId) return;
      state.emittedSessionId = sessionId;
      emitter.sessionId(state.emittedSessionId);
    },
    content: (text) => emitter.content(text),
    thinking: (text) => emitter.thinking(text),
    toolUse: (call) => emitter.toolUse(call),
    toolResult: (toolUseId, content) => emitter.toolResult({ toolUseId, content }),
    usage: (usage) => emitter.usage(usage),
    sendError: (message) => emitter.sendError(message, 'MiniMax'),
  };
}

/**
 * The two message-id branches of one stream, as an {onDelta, onFinal} pair: a
 * delta records its id and emits, the `*_final` replay is dropped when that id
 * already streamed. Built once per stream with that stream's own Set, so
 * content and reasoning can never suppress each other.
 */
function createStreamIdKinds(streamedIds, emit) {
  return {
    onDelta: (event) => {
      if (event.messageId) streamedIds.add(event.messageId);
      emit(event.data);
    },
    onFinal: (event) => {
      if (event.messageId && streamedIds.has(event.messageId)) return;
      if (event.messageId) streamedIds.add(event.messageId);
      emit(event.data);
    },
  };
}

/** The two tool branches: a call is announced once, its result once. */
function createToolKindHandlers(state, publish) {
  return {
    tool_start: (event) => {
      if (state.seenToolUseIds.has(event.call.id)) return;
      state.seenToolUseIds.add(event.call.id);
      publish.toolUse(event.call);
    },
    tool_done: (event) => {
      // A finished call that never announced itself still needs both markers,
      // so the start check repeats here.
      if (!state.seenToolUseIds.has(event.call.id)) {
        state.seenToolUseIds.add(event.call.id);
        publish.toolUse(event.call);
      }
      if (!state.seenToolResultIds.has(event.call.id)) {
        state.seenToolResultIds.add(event.call.id);
        publish.toolResult(event.call.id, event.output);
      }
    },
  };
}

/** Normalize the usage marker, then run the unstreamed-message safety net. */
function createUsageKindHandler(state, publish) {
  return (event) => {
    const normalizedUsage = normalizeMiniMaxUsage(event.usage);
    if (normalizedUsage) {
      publish.usage(normalizedUsage);
    }
    // Safety net: if a finished assistant message never produced deltas
    // (e.g. non-streaming fallback), emit its full text/thinking once.
    if (event.message && typeof event.message === 'object' && event.message.id) {
      const msgId = String(event.message.id);
      const content = typeof event.message.content === 'string' ? event.message.content : '';
      if (content && !state.streamedContentMessageIds.has(msgId)) {
        state.streamedContentMessageIds.add(msgId);
        publish.content(content);
      }
      const thinking = typeof event.message.thinking === 'string' ? event.message.thinking : '';
      if (thinking && !state.streamedThinkingMessageIds.has(msgId)) {
        state.streamedThinkingMessageIds.add(msgId);
        publish.thinking(thinking);
      }
    }
  };
}

/** The terminal branch: record that a result arrived, then report its failure. */
// Dedup key for a result-carried answer that no streamed item id owns.
const ANON_CONTENT_KEY = '<anon-agent_message>';

function createResultKindHandler(state, publish) {
  return (event) => {
    state.sawResult = true;
    publish.session(event.sessionId);
    // Final fallback: a run that streamed no content at all but whose result
    // envelope carries the full answer emits it exactly once.
    if (event.answer && state.streamedContentMessageIds.size === 0) {
      state.streamedContentMessageIds.add(ANON_CONTENT_KEY);
      publish.content(event.answer);
    }
    // shouldTerminate kills the CLI on this line and suppresses the
    // non-zero exit code, so a failed run with no streamed output would
    // otherwise end the stream in silence — surface it explicitly.
    const nothingStreamed = state.streamedContentMessageIds.size === 0
      && state.streamedThinkingMessageIds.size === 0
      && state.seenToolUseIds.size === 0;
    if (event.failed && nothingStreamed) {
      publish.sendError(
        event.errorMessage || state.turnFailureMessage
          || `MiniMax CLI run failed (status: ${event.status})`,
      );
    }
  };
}

/**
 * The event-kind → handler table, built per run so every closure reads and
 * writes the one dedup state. A Map rather than an object literal, so a
 * hostile `kind` can never resolve to an inherited property.
 */
function createKindHandlers(state, publish) {
  const content = createStreamIdKinds(state.streamedContentMessageIds, publish.content);
  const thinking = createStreamIdKinds(state.streamedThinkingMessageIds, publish.thinking);
  return new Map([
    ['session', (event) => publish.session(event.sessionId)],
    // Schema A repeats the whole message on item.completed after the deltas
    // already carried it — onFinal drops it when that id was streamed.
    ['text', content.onDelta],
    ['text_final', content.onFinal],
    ['thinking', thinking.onDelta],
    ['thinking_final', thinking.onFinal],
    ...Object.entries(createToolKindHandlers(state, publish)),
    ['usage', createUsageKindHandler(state, publish)],
    // Assumed non-terminal (exec.completed is believed to follow) and never a
    // usage source; only remember the reason, so the result line can surface
    // it when the CLI leaves the reason only here — and so sendMessage can
    // still surface it if no result line ever arrives.
    ['turn_failed', (event) => {
      state.turnFailureMessage = event.errorMessage || '';
    }],
    ['result', createResultKindHandler(state, publish)],
  ]);
}

/**
 * Create the per-run stream handler: content/tool/session de-duplication plus
 * marker emission, with the emitter injected for testing.
 *
 * Extracted verbatim from the sendMessage closure — the dedup keys, the two
 * independent reasoning/content id sets and the once-per-run session marker are
 * unchanged; only the marker functions became an injected dependency.
 *
 * @param {object} [emitter] defaults to the real marker protocol
 * @param {string} [initialSessionId] session id already emitted for this run
 * @returns {{handleEvent: (event: object) => void, sawResult: boolean,
 *   turnFailureMessage: string}} `sawResult` and `turnFailureMessage` are live
 *   getters: sendMessage reads them in its finally block to surface a run that
 *   failed without ever producing a result event.
 */
export function createMiniMaxEventHandler(
  emitter = createMarkerEmitter(),
  initialSessionId = '',
) {
  const state = createDedupState(initialSessionId);
  const publish = createPublishBridge(emitter, state);
  const kindHandlers = createKindHandlers(state, publish);

  const handleEvent = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'multi') {
      for (const sub of event.events) handleEvent(sub);
      return;
    }
    const handler = kindHandlers.get(event.kind);
    if (typeof handler === 'function') handler(event);
  };

  return {
    handleEvent,
    /** True once a result event (exec.completed / exec.result) was handled. */
    get sawResult() {
      return state.sawResult;
    },
    /** Reason carried by the last turn.failed; '' when none was seen. */
    get turnFailureMessage() {
      return state.turnFailureMessage;
    },
  };
}

/**
 * @param {string} message
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} model
 * @param {string} [_reasoningEffort] unused (mcode reasoning is model-driven)
 * @param {Array} [attachments] image attachments (fileName/mediaType/data)
 * @param {string} [permissionMode] CCGUI permission mode
 */
export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  _reasoningEffort = '',
  attachments = [],
  permissionMode = ''
) {
  beginStream();

  // Headless exec has no multimodal prompt payload; materialize images to
  // temp files and append path instructions (same approach as Kimi bridge).
  let promptText = message || '';
  let imagePaths = [];
  try {
    imagePaths = await materializeImageAttachments(attachments);
    if (imagePaths.length > 0) {
      logDebug('image attachments', imagePaths.length, imagePaths);
    }
  } catch (err) {
    console.error('[MiniMax] failed to materialize image attachments:', err?.message || err);
  }

  const bin = resolveMiniMaxCliPath();
  // Multi-line/oversized prompts ride stdin — cmd.exe argv cannot carry
  // newlines and caps near 32k chars (see shouldUseStdinPrompt).
  const promptViaStdin = shouldUseStdinPrompt(promptText);
  const args = buildMiniMaxArgs({
    message: promptText,
    sessionId,
    model,
    permissionMode,
    cwd,
    imagePaths,
    promptViaStdin,
  });
  // Same CR/LF refusal as the parser: a session id from the caller reaches the
  // marker before the CLI even starts.
  const resolvedSessionId = isSafeToEmitSessionId(sessionId) ? sessionId.trim() : null;
  if (resolvedSessionId) {
    emitSessionId(resolvedSessionId);
  }

  logDebug('spawn', bin, args.join(' ').slice(0, 500),
    `promptLen=${String(promptText || '').length}`,
    `promptViaStdin=${promptViaStdin}`,
    `permission=${resolvePermissionPolicy(permissionMode)}`);

  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, commonCliBinDirs(home));

  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();
  const stream = createMiniMaxEventHandler(createMarkerEmitter(), resolvedSessionId || '');
  resetMiniMaxUnknownTypeCounts();

  try {
    await runCliStreaming({
      bin,
      args,
      cwd: workCwd,
      env,
      label: 'MiniMax',
      stdinData: promptViaStdin ? String(promptText ?? '') : undefined,
      // De-duplication lives in handleEvent, which sees the `*_final` replay
      // and the streamed deltas in the same place.
      onLine: (line) => stream.handleEvent(parseMiniMaxStreamLine(line)),
      // mcode exec keeps running after its completion event — stop there.
      shouldTerminate: isMiniMaxTerminalLine,
    });
  } finally {
    await cleanupMaterializedImagePaths(imagePaths);
    // Report what the run left unhandled (stderr only) so a 0.5.6 protocol
    // change surfaces as a top-N summary instead of silently missing output.
    flushMiniMaxUnknownTypeCounts();
    // Orphan-failure net: turn.failed is only *believed* to be followed by
    // exec.completed (see the file header). If a run reports the failure, exits
    // 0 — so runCliStreaming's non-zero-exit fallback never fires — and never
    // produces a result event, the reason would be dropped and the UI would end
    // the run with no output at all: the exact failure mode this bridge exists
    // to remove. Normal runs all set sawResult, so this stays silent.
    const orphanFailure = resolveUnterminatedFailureReason(stream);
    if (orphanFailure) {
      emitSendError(orphanFailure, 'MiniMax');
    }
  }
}
