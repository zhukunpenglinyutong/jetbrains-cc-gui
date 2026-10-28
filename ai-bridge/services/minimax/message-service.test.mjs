import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMiniMaxArgs,
  createMiniMaxEventHandler,
  flushMiniMaxUnknownTypeCounts,
  getMiniMaxSkippedShapeCounts,
  getMiniMaxUnknownTypeCounts,
  isMiniMaxTerminalLine,
  normalizeMiniMaxUsage,
  normalizeToolStatus,
  parseMiniMaxStreamLine,
  resetMiniMaxUnknownTypeCounts,
  resolveUnterminatedFailureReason,
  shouldUseStdinPrompt,
} from './message-service.js';

// ---------------------------------------------------------------------------
// Fixture: two verbatim `mcode 0.5.5 exec --output-format stream-json` runs
// captured on this machine with the 0.5.5 entry point pinned explicitly
// (resolveMiniMaxCliPath() prefers the locally installed `minimax` 0.4.10,
// which speaks the old delta protocol — sampling that would prove nothing):
//   node <NPM_GLOBAL>\@minimax-ai\code\cli.js exec \
//        --output-format stream-json --permission off "<prompt>"
// run 1 (fresh)  listed the cwd, read marker.txt, then answered
// run 2 (--session <run 1 sessionId>) answered a follow-up
//
// Every main-path 0.5.5 assertion below reads from this file. Only shapes a
// successful run cannot produce are hand-written, inside [0.5.5-ALLOWED]
// blocks (see the comment on each block for its plan criterion / whitelist id).
//
// The capture is scrubbed before it was added to this public fork: absolute
// paths were replaced with <USERPROFILE>/<TEMP> placeholders, the background
// task uuid with <uuid>, and envSanitized emptied. No field name or structure
// was removed, and no assertion below depends on a path value — they all read
// the object they are asserting about out of the same line.
// ---------------------------------------------------------------------------
const FIXTURE_URL = new URL('./fixtures/mcode-0.5.5-stream.ndjson', import.meta.url);
const fixtureLines = (() => {
  const raw = readFileSync(FIXTURE_URL, 'utf8').split(/\r?\n/);
  // NDJSON ends with a newline, so the split leaves a trailing empty string:
  // drop it before parsing (plan step 1(1)).
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw;
})();
const fixtureRecords = fixtureLines.map((raw) => ({ raw, event: JSON.parse(raw) }));
const recordsWhere = (predicate) => fixtureRecords.filter((r) => predicate(r.event));
const rawWhere = (predicate) => recordsWhere(predicate).map((r) => r.raw);
const eventWhere = (predicate) => recordsWhere(predicate).map((r) => r.event);
const firstEvent = (predicate) => eventWhere(predicate)[0];
const firstRaw = (predicate) => rawWhere(predicate)[0];

// A fragment starts at every exec.started (plan step 1(5)) — the fixture holds
// exactly two runs, so exactly two fragments with no orphaned lines.
const fixtureFragments = (() => {
  const fragments = [];
  for (const record of fixtureRecords) {
    if (record.event.type === 'exec.started') fragments.push([]);
    fragments[fragments.length - 1].push(record);
  }
  return fragments;
})();

/**
 * Exclusion set for plan 8(2)(b) / 9(1).
 *
 * K11: every tool call emits three pending/running rows (toolCall.status 4 then
 * 5) that carry neither input nor output; parseMiniMaxItemEvent deliberately
 * ignores them so no empty-argument tool card is created. Unhandled-by-design
 * must not be confused with protocol drift.
 */
function isExcludedOther(event) {
  if (!event.item) return false;
  if (!String(event.type).startsWith('item.')) return false;
  if (event.item.type !== 'tool_call') return false;
  const status = normalizeToolStatus(event.item.toolCall?.status);
  return status === 4 || status === 5;
}

function createFakeEmitter() {
  const emitted = {
    sessionIds: [], content: [], thinking: [], toolUse: [], toolResult: [], usage: [], errors: [],
  };
  return {
    emitted,
    sessionId: (id) => emitted.sessionIds.push(id),
    content: (text) => emitted.content.push(text),
    thinking: (text) => emitted.thinking.push(text),
    toolUse: (call) => emitted.toolUse.push(call),
    toolResult: (payload) => emitted.toolResult.push(payload),
    usage: (usage) => emitted.usage.push(usage),
    sendError: (message) => emitted.errors.push(message),
  };
}

/** Run one fixture fragment through parser + handler, keeping both views. */
function replayFragment(records) {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  const kinds = [];
  const unhandled = [];
  for (const { raw, event } of records) {
    const parsed = parseMiniMaxStreamLine(raw);
    kinds.push(parsed.kind);
    if (parsed.kind === 'other') unhandled.push(event);
    handleEvent(parsed);
  }
  return { kinds, unhandled, emitted: emitter.emitted };
}

// ===========================================================================
// schema B — legacy mcode 0.2.x – 0.4.x (regression guard, unchanged)
// ===========================================================================

test('delta content maps to text event', () => {
  const line = JSON.stringify({
    type: 'delta', messageId: 'm1', role: 'assistant',
    content: 'hello', chunkIndex: 1,
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'text', data: 'hello', messageId: 'm1',
  });
});

test('delta thinking maps to thinking event', () => {
  const line = JSON.stringify({
    type: 'delta', messageId: 'm2', role: 'assistant',
    thinking: 'pondering', chunkIndex: 2,
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'thinking', data: 'pondering', messageId: 'm2',
  });
});

test('delta with toolCalls status 1 maps to tool_start', () => {
  const line = JSON.stringify({
    type: 'delta', role: 'assistant', chunkIndex: 3,
    toolCalls: [{ id: 'call-1', name: 'bash', status: 1, input: { command: 'ls' } }],
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'tool_start');
  assert.equal(event.call.id, 'call-1');
  assert.equal(event.call.name, 'bash');
  assert.deepEqual(event.call.input, { command: 'ls' });
});

test('delta with toolCalls status 2 maps to tool_done with output text', () => {
  const line = JSON.stringify({
    type: 'delta', role: 'assistant', chunkIndex: 4,
    toolCalls: [{
      id: 'call-2', name: 'bash', status: 2, input: { command: 'pwd' },
      output: { content: [{ type: 'text', text: '/repo' }] },
    }],
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'tool_done');
  assert.equal(event.call.id, 'call-2');
  assert.equal(event.output, '/repo');
});

test('assistant message with usage maps to usage event', () => {
  const line = JSON.stringify({
    type: 'message',
    message: {
      id: 'm3', role: 'assistant', content: 'ok',
      usage: { totalTokens: 10, inputTokens: 4, outputTokens: 6 },
    },
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'usage');
  assert.deepEqual(event.usage, { totalTokens: 10, inputTokens: 4, outputTokens: 6 });
});

test('exec.result maps to result event with sessionId', () => {
  const line = JSON.stringify({
    schemaVersion: 1, type: 'exec.result',
    sessionId: 'mvs_abc123', status: 'succeeded', answer: 'done',
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'result', sessionId: 'mvs_abc123', status: 'succeeded',
    failed: false, errorMessage: '', answer: 'done',
  });
});

test('exec.result with failed status is flagged and carries the error text', () => {
  const line = JSON.stringify({
    type: 'exec.result', status: 'failed', error: 'permission denied',
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'result', sessionId: '', status: 'failed',
    failed: true, errorMessage: 'permission denied', answer: '',
  });
});

test('exec.result failure falls back to the message field', () => {
  const line = JSON.stringify({
    type: 'exec.result', status: 'cancelled', message: 'aborted by user',
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.failed, true);
  assert.equal(event.errorMessage, 'aborted by user');
});

test('exec.result without a status is not treated as failure', () => {
  const line = JSON.stringify({ type: 'exec.result', sessionId: 'mvs_x' });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.failed, false);
  assert.equal(event.errorMessage, '');
});

test('noise events (heartbeat/generic/session-status/done/user message) are ignored', () => {
  assert.deepEqual(parseMiniMaxStreamLine('{"type":"heartbeat","turnId":"t1"}'), { kind: 'other' });
  assert.deepEqual(
    parseMiniMaxStreamLine('{"type":"generic","eventType":"query_collapse_view"}'),
    { kind: 'other' },
  );
  assert.deepEqual(parseMiniMaxStreamLine('{"type":"done","turnId":"t1"}'), { kind: 'other' });
  assert.deepEqual(
    parseMiniMaxStreamLine('{"type":"message","message":{"role":"user","content":"hi"}}'),
    { kind: 'other' },
  );
  assert.deepEqual(parseMiniMaxStreamLine('not json'), { kind: 'other' });
  assert.deepEqual(parseMiniMaxStreamLine(''), { kind: 'other' });
});

test('empty delta with finish flag is ignored', () => {
  const line = JSON.stringify({
    type: 'delta', messageId: 'm4', role: 'assistant', chunkIndex: 9, finish: true,
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), { kind: 'other' });
});

test('normalizeMiniMaxUsage reconstructs total_tokens when missing', () => {
  const normalized = normalizeMiniMaxUsage({
    inputTokens: 100,
    cacheReadTokens: 50,
    outputTokens: 10,
  });
  assert.deepEqual(normalized, {
    input_tokens: 100,
    cache_read_input_tokens: 50,
    output_tokens: 10,
    total_tokens: 160,
  });
});

test('normalizeMiniMaxUsage returns null for invalid inputs', () => {
  assert.equal(normalizeMiniMaxUsage(null), null);
  assert.equal(normalizeMiniMaxUsage(undefined), null);
  assert.equal(normalizeMiniMaxUsage({}), null);
  assert.equal(normalizeMiniMaxUsage([]), null);
  assert.equal(normalizeMiniMaxUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }), null);
  assert.equal(normalizeMiniMaxUsage({ inputTokens: -5, cacheReadTokens: -1, outputTokens: -3 }), null);
  assert.equal(normalizeMiniMaxUsage('not an object'), null);
  assert.equal(normalizeMiniMaxUsage(42), null);
});

test('legacy usage still emits the same four snake_case keys', () => {
  // Zero-regression guard for the 0.2.x-0.4.x `message` usage path: a payload
  // without cacheWriteTokens/reasoningTokens must keep its previous shape.
  const normalized = normalizeMiniMaxUsage({
    totalTokens: 36178, inputTokens: 1347, outputTokens: 15, cacheReadTokens: 34816,
  });
  assert.deepEqual(Object.keys(normalized).sort(), [
    'cache_read_input_tokens', 'input_tokens', 'output_tokens', 'total_tokens',
  ]);
  assert.deepEqual(normalized, {
    input_tokens: 1347,
    cache_read_input_tokens: 34816,
    output_tokens: 15,
    total_tokens: 36178,
  });
});

// ===========================================================================
// schema A — mcode >= 0.5, driven by the real capture
// ===========================================================================

test('fixture is raw NDJSON: every line parses and it splits into >= 2 runs', () => {
  assert.ok(fixtureLines.length > 0, 'fixture must not be empty');
  const execStarted = fixtureRecords.filter((r) => r.event.type === 'exec.started');
  assert.ok(execStarted.length >= 2, 'expected at least the fresh run and the resumed run');
  // 1(5): no orphaned lines — the fragment count equals the exec.started count.
  assert.equal(fixtureFragments.length, execStarted.length);
  // 1(2): the required event types are all really in the capture.
  const types = new Set(fixtureRecords.map((r) => r.event.type));
  for (const required of [
    'session.started', 'session.resumed', 'turn.started', 'turn.completed',
    'exec.completed', 'item.started', 'item.updated', 'item.completed',
  ]) {
    assert.ok(types.has(required), `fixture is missing ${required}`);
  }
  // Registered item.type whitelist (K12: this model emitted no reasoning item,
  // and a user_message echo never reaches the stream, so the capture shows only
  // two of the four registered types — a subset check, not an exact set).
  const REGISTERED_ITEM_TYPES = new Set([
    'agent_message', 'tool_call', 'reasoning', 'user_message',
  ]);
  const itemTypes = [...new Set(eventWhere((e) => e.item).map((e) => e.item.type))].sort();
  assert.ok(itemTypes.length > 0, 'the capture must contain items');
  for (const type of itemTypes) {
    assert.ok(REGISTERED_ITEM_TYPES.has(type), `unregistered item.type in the capture: ${type}`);
  }
  for (const type of ['agent_message', 'tool_call']) {
    assert.ok(itemTypes.includes(type), `the capture must still exercise ${type}`);
  }
});

test('exec.started surfaces the real session id early', () => {
  const raw = rawWhere((e) => e.type === 'exec.started')[0];
  const event = JSON.parse(raw);
  assert.deepEqual(parseMiniMaxStreamLine(raw), {
    kind: 'session', sessionId: event.sessionId,
  });
  // Same sessionId on the three ensureStarted() events of that run.
  const runSession = new Set(
    fixtureFragments[0]
      .map((r) => r.event)
      .filter((e) => typeof e.sessionId === 'string')
      .map((e) => e.sessionId),
  );
  assert.deepEqual([...runSession], [event.sessionId]);
});

test('the resumed run reports session.resumed, not session.started', () => {
  const resumed = eventWhere((e) => e.type === 'session.resumed');
  assert.equal(resumed.length, 1);
  assert.equal(fixtureFragments[1].some((r) => r.event.type === 'session.resumed'), true);
  const parsed = parseMiniMaxStreamLine(
    fixtureFragments[1].find((r) => r.event.type === 'session.resumed').raw,
  );
  assert.deepEqual(parsed, { kind: 'session', sessionId: resumed[0].sessionId });
});

test('real agent_message contentDelta maps to text and its content maps to text_final', () => {
  const dualId = [...new Set(eventWhere((e) => e.item?.type === 'agent_message').map((e) => e.item.id))]
    .find((id) => (
      eventWhere((e) => e.item?.type === 'agent_message' && e.item.id === id && 'contentDelta' in e.item).length > 0
      && eventWhere((e) => e.item?.type === 'agent_message' && e.item.id === id && 'content' in e.item).length > 0
    ));
  assert.ok(dualId, 'fixture must contain an agent_message with both contentDelta and content');
  const deltaRecord = recordsWhere((e) => (
    e.item?.type === 'agent_message' && e.item.id === dualId && 'contentDelta' in e.item
  ))[0];
  const finalRecord = recordsWhere((e) => (
    e.item?.type === 'agent_message' && e.item.id === dualId && 'content' in e.item
  ))[0];

  assert.deepEqual(parseMiniMaxStreamLine(deltaRecord.raw), {
    kind: 'text', data: deltaRecord.event.item.contentDelta, messageId: dualId,
  });
  assert.deepEqual(parseMiniMaxStreamLine(finalRecord.raw), {
    kind: 'text_final', data: finalRecord.event.item.content, messageId: dualId,
  });
  // The dedup key is the item id and the final really repeats the deltas.
  const streamed = eventWhere((e) => e.item?.id === dualId && 'contentDelta' in e.item)
    .map((e) => e.item.contentDelta).join('');
  assert.equal(finalRecord.event.item.content, streamed);
});

test('real tool_call status 1 maps to tool_start with its input', () => {
  const record = recordsWhere((e) => (
    e.type.startsWith('item.') && e.item?.type === 'tool_call' && e.item.toolCall?.status === 1
  ))[0];
  assert.equal(typeof record.event.item.toolCall.status, 'number', '0.5.5 sends Int32');
  const call = record.event.item.toolCall;
  const event = parseMiniMaxStreamLine(record.raw);
  assert.equal(event.kind, 'tool_start');
  assert.equal(event.call.id, call.id);
  assert.equal(event.call.name, call.name);
  assert.deepEqual(event.call.input, call.input);
  assert.ok(Object.keys(event.call.input).length > 0, 'tool_start must carry real arguments');
});

test('real tool_call status 2 maps to tool_done with extracted output text', () => {
  const record = recordsWhere((e) => (
    e.type.startsWith('item.') && e.item?.type === 'tool_call' && e.item.toolCall?.status === 2
  ))[0];
  const call = record.event.item.toolCall;
  const expected = call.output.content
    .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
    .join('');
  const event = parseMiniMaxStreamLine(record.raw);
  assert.equal(event.kind, 'tool_done');
  assert.equal(event.call.id, call.id);
  assert.equal(typeof event.output, 'string');
  assert.equal(event.output, expected);
  assert.ok(event.output.length > 0);
});

test('real turn.completed usage normalizes to the Java-side snake_case shape', () => {
  const record = recordsWhere((e) => e.type === 'turn.completed' && e.usage)[0];
  const event = parseMiniMaxStreamLine(record.raw);
  assert.equal(event.kind, 'usage');
  const usage = record.event.usage;
  const normalized = normalizeMiniMaxUsage(event.usage);
  assert.equal(normalized.input_tokens, usage.inputTokens);
  assert.equal(normalized.cache_read_input_tokens, usage.cacheReadTokens);
  assert.equal(normalized.output_tokens, usage.outputTokens);
  assert.equal(normalized.total_tokens, usage.totalTokens);
  // The capture carries no requestDurationMs, so asserting on it there proved
  // nothing (the old check named a snake_case key that is not even a candidate
  // mapping). K5 is asserted on a synthetic payload that really has the field:
  // a non-token field must be dropped by its camelCase source name.
  assert.equal('requestDurationMs' in usage, false, '0.5.5 sent no requestDurationMs here');
  const withDuration = normalizeMiniMaxUsage({ ...usage, requestDurationMs: 1234 });
  assert.equal('requestDurationMs' in withDuration, false, 'the camelCase source key must not survive');
  assert.equal('request_duration_ms' in withDuration, false, 'nor a snake_case spelling of it');
  assert.deepEqual(withDuration, normalized, 'dropping a non-token field must not disturb the rest');
});

test('real exec.completed result maps to a result event read from the nested result', () => {
  const record = recordsWhere((e) => e.type === 'exec.completed')[0];
  const result = record.event.result;
  assert.deepEqual(parseMiniMaxStreamLine(record.raw), {
    kind: 'result',
    sessionId: result.sessionId,
    status: result.status,
    failed: result.status.toLowerCase() !== 'succeeded',
    errorMessage: '',
    answer: typeof result.answer === 'string' ? result.answer : '',
  });
});

test('legacy exec.result and 0.5.5 exec.completed produce isomorphic result events', () => {
  // 8(3): one assertion set, run over both protocols. The six result fields
  // are compared individually, so a shape difference cannot hide.
  const assertResultEvent = (line, expected) => {
    const event = parseMiniMaxStreamLine(line);
    assert.deepEqual(Object.keys(event).sort(), [
      'answer', 'errorMessage', 'failed', 'kind', 'sessionId', 'status',
    ]);
    assert.equal(event.kind, 'result');
    assert.equal(event.sessionId, expected.sessionId);
    assert.equal(event.status, expected.status);
    assert.equal(event.failed, expected.failed);
    assert.equal(event.errorMessage, expected.errorMessage);
    assert.equal(event.answer, expected.answer);
  };

  assertResultEvent(
    JSON.stringify({ type: 'exec.result', sessionId: 'mvs_same', status: 'succeeded', answer: 'ok' }),
    { sessionId: 'mvs_same', status: 'succeeded', failed: false, errorMessage: '', answer: 'ok' },
  );
  const raw = firstRaw((e) => e.type === 'exec.completed');
  const result = JSON.parse(raw).result;
  assertResultEvent(raw, {
    sessionId: result.sessionId,
    status: result.status,
    failed: result.status.toLowerCase() !== 'succeeded',
    errorMessage: '',
    answer: typeof result.answer === 'string' ? result.answer : '',
  });

  // Both shapes reach the same handler branch, so the session marker is
  // emitted once for either protocol.
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  handleEvent(parseMiniMaxStreamLine(JSON.stringify({
    type: 'exec.result', sessionId: 'mvs_same', status: 'succeeded',
  })));
  assert.deepEqual(emitter.emitted.sessionIds, ['mvs_same']);
});

test('user_message items and unknown item types are ignored', () => {
  // [0.5.5-ALLOWED] W4: a user_message item is a prompt echo, not stream output.
  assert.deepEqual(
    parseMiniMaxStreamLine(JSON.stringify({
      type: 'item.started', item: { id: 'u1', type: 'user_message', contentDelta: 'hi' },
    })),
    { kind: 'other' },
  );
  assert.deepEqual(
    parseMiniMaxStreamLine(JSON.stringify({ type: 'item.updated', item: null })),
    { kind: 'other' },
  );
  // [/0.5.5-ALLOWED]
});

test('a turn.started line without a session id stays unhandled (K14)', () => {
  // [0.5.5-ALLOWED] W5: single-point probe that the session branch is guarded
  // by isNonEmptySessionId. Real 0.5.5 always injects a sessionId.
  assert.deepEqual(
    parseMiniMaxStreamLine(JSON.stringify({ type: 'turn.started', turnId: 't1' })),
    { kind: 'other' },
  );
  // [/0.5.5-ALLOWED]
});

test('a captured 0.5.5 sequence yields content, thinking, usage and a result', () => {
  // [0.5.5-ALLOWED] W12: pre-existing smoke sequence, kept verbatim as the
  // minimal "one of each event shape" regression. The reasoning lines are the
  // only 0.5.5 shape the capture cannot provide (K12: this model emitted no
  // thinking, so reasoning is asserted here rather than from the fixture).
  const lines = [
    '{"type":"exec.started","sessionId":"mvs_1","runId":"r"}',
    '{"type":"item.started","item":{"id":"a:reasoning","type":"reasoning","contentDelta":"think"}}',
    '{"type":"item.started","item":{"id":"a:message","type":"agent_message","contentDelta":"O"}}',
    '{"type":"item.completed","item":{"id":"a:message","type":"agent_message","content":"OK"}}',
    '{"type":"turn.completed","usage":{"inputTokens":10,"outputTokens":2,"totalTokens":12}}',
    '{"type":"exec.completed","result":{"type":"exec.result","sessionId":"mvs_1","status":"succeeded"}}',
  ];
  const kinds = lines.map((l) => parseMiniMaxStreamLine(l).kind);
  assert.deepEqual(kinds, ['session', 'thinking', 'text', 'text_final', 'usage', 'result']);
  // [/0.5.5-ALLOWED]
});

test('reasoning items map to thinking / thinking_final (K12 fixture gap)', () => {
  // [0.5.5-ALLOWED] K12: neither captured run produced a reasoning item, so
  // the reasoning branch has no fixture line; asserted from the wire shape the
  // 0.5.5 bundle builds (er(): id `${messageId}:reasoning`, contentDelta while
  // streaming, content on completion).
  const streaming = JSON.stringify({
    type: 'item.started',
    item: { id: 'r1', type: 'reasoning', contentDelta: 'pondering' },
  });
  const completed = JSON.stringify({
    type: 'item.completed',
    item: { id: 'r1', type: 'reasoning', content: 'full reasoning' },
  });
  assert.deepEqual(parseMiniMaxStreamLine(streaming), {
    kind: 'thinking', data: 'pondering', messageId: 'r1',
  });
  assert.deepEqual(parseMiniMaxStreamLine(completed), {
    kind: 'thinking_final', data: 'full reasoning', messageId: 'r1',
  });
  // [/0.5.5-ALLOWED]
});

test('isMiniMaxTerminalLine fires on the real 0.5 completion envelope only', () => {
  const realCompleted = firstRaw((e) => e.type === 'exec.completed');
  assert.equal(isMiniMaxTerminalLine(realCompleted), true);
  for (const type of ['exec.started', 'session.started', 'turn.started', 'turn.completed', 'item.updated']) {
    assert.equal(isMiniMaxTerminalLine(firstRaw((e) => e.type === type)), false, `${type} must not terminate`);
  }
  // A nested legacy-shaped payload inside a non-terminal event must not stop it.
  assert.equal(
    isMiniMaxTerminalLine(JSON.stringify({ type: 'item.completed', item: { type: 'exec.result' } })),
    false,
  );
  assert.equal(isMiniMaxTerminalLine(JSON.stringify({ type: 'exec.result', status: 'succeeded' })), true);
  assert.equal(isMiniMaxTerminalLine('not json'), false);
  assert.equal(isMiniMaxTerminalLine(''), false);
});

// ===========================================================================
// defect 1 — `error` is an object in 0.5.x, a string in 0.2.x-0.4.x
// ===========================================================================

test('exec.result with an object error reads its message', () => {
  // [0.5.5-ALLOWED] W1: a successful capture never contains an error object.
  const line = JSON.stringify({
    type: 'exec.result', sessionId: 's1', status: 'failed',
    error: { category: 'runtime', code: 'E1', message: 'boom', retryable: true },
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.errorMessage, 'boom');
  assert.equal(event.failed, true);
  // [/0.5.5-ALLOWED]
});

test('an object error without a message falls back to its code, then to the status', () => {
  // [0.5.5-ALLOWED] W2: depends on the absent `message` field.
  const withCode = parseMiniMaxStreamLine(JSON.stringify({
    type: 'exec.result', status: 'failed',
    error: { category: 'runtime', code: 'STRUCTURED_OUTPUT_INVALID' },
  }));
  assert.equal(withCode.errorMessage, 'STRUCTURED_OUTPUT_INVALID');

  // Nothing usable anywhere: the surfaced text degrades to the status string.
  const bare = parseMiniMaxStreamLine(JSON.stringify({
    type: 'exec.result', status: 'failed',
    error: { category: 'internal', retryable: false },
  }));
  assert.equal(bare.errorMessage, '');
  const emitter = createFakeEmitter();
  createMiniMaxEventHandler(emitter).handleEvent(bare);
  assert.deepEqual(emitter.emitted.errors, ['MiniMax CLI run failed (status: failed)']);
  // [/0.5.5-ALLOWED]
});

test('nine classes of unusable session id produce no session event', () => {
  // [0.5.5-ALLOWED] W4: real session ids are always well-formed.
  const bad = ['', '   ', '.', '..', 'a..b', 'a/b', 'a\\b', undefined, 42];
  for (const sessionId of bad) {
    for (const type of ['exec.started', 'session.started', 'session.resumed', 'turn.started']) {
      const payload = { type };
      if (sessionId !== undefined) payload.sessionId = sessionId;
      assert.deepEqual(
        parseMiniMaxStreamLine(JSON.stringify(payload)),
        { kind: 'other' },
        `${type} with sessionId=${JSON.stringify(sessionId)} must be rejected`,
      );
    }
  }
  // [/0.5.5-ALLOWED]
});

test('a rejected session id never reaches the session marker', () => {
  // [0.5.5-ALLOWED] W4: guards the emission side of the same nine cases.
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  for (const sessionId of ['', '  ', '.', '..', 'a..b', 'a/b', 'a\\b', undefined, 7]) {
    handleEvent(parseMiniMaxStreamLine(JSON.stringify({ type: 'session.started', sessionId })));
  }
  assert.deepEqual(emitter.emitted.sessionIds, []);
  // [/0.5.5-ALLOWED]
});

test('a session id carrying a line break cannot forge a second marker line', () => {
  // [0.5.5-ALLOWED] W4: 0.5.5 ids are hex+u, so this input cannot come from a
  // capture. Root cause: marker-protocol.js `emitSessionId` interpolates the id
  // raw and isNonEmptySessionId ignores CR/LF, so
  // `"mvs_ok\n[SEND_ERROR] {...}"` used to write TWO stdout lines, the second
  // one attacker-controlled. Driven through the REAL emitter here because the
  // whole defect lives in what reaches stdout, not in the fake emitter.
  const FORGED = 'mvs_ok\n[SEND_ERROR] {"error":"forged"}';
  const out = [];
  const originalLog = console.log;
  console.log = (...args) => out.push(args.map(String).join(' ') + '\n');
  try {
    const { handleEvent } = createMiniMaxEventHandler();
    for (const type of ['exec.started', 'session.started', 'session.resumed', 'turn.started']) {
      handleEvent(parseMiniMaxStreamLine(JSON.stringify({ type, sessionId: FORGED })));
    }
    // The result path carries its own sessionId and must be guarded too.
    handleEvent(parseMiniMaxStreamLine(JSON.stringify({
      type: 'exec.completed',
      result: { type: 'exec.result', sessionId: FORGED, status: 'succeeded' },
    })));
    // Positive control: a well-formed id still reaches the marker exactly once,
    // so this test cannot be passed by refusing every session id.
    handleEvent(parseMiniMaxStreamLine(JSON.stringify({
      type: 'session.started', sessionId: 'mvs_ok',
    })));
  } finally {
    console.log = originalLog;
  }
  const stdout = out.join('');
  assert.equal(stdout.includes('forged'), false, 'no forged marker may reach stdout');
  assert.equal(stdout.includes('\n[SEND_ERROR]'), false, 'no second line may be injected');
  assert.deepEqual(out, ['[SESSION_ID] mvs_ok\n'], 'only the well-formed id may be emitted');
  // A lone \r and a trailing \n must be refused as well, and the parse side must
  // not even classify such a line as a session event.
  for (const unsafe of ['mvs_ok\r', 'mvs_ok\n', 'mvs\r\nok', 'mvs_ok\r\n[SEND_ERROR] x']) {
    assert.deepEqual(
      parseMiniMaxStreamLine(JSON.stringify({ type: 'session.started', sessionId: unsafe })),
      { kind: 'other' },
      `${JSON.stringify(unsafe)} must not be a session event`,
    );
  }
  // [/0.5.5-ALLOWED]
  resetMiniMaxUnknownTypeCounts();
});

// ===========================================================================
// defect 2 — turn.failed
// ===========================================================================

test('turn.failed is classified with its exact status and error text', () => {
  // [0.5.5-ALLOWED] W6: a successful run never emits turn.failed.
  const line = JSON.stringify({
    type: 'turn.failed', status: 'failed',
    error: { category: 'runtime', code: 'E2', message: 'boom', retryable: false },
    durationMs: 12,
  });
  const event = parseMiniMaxStreamLine(line);
  assert.notEqual(event.kind, 'other');
  assert.equal(event.status, 'failed');
  // Exact equality, not "includes": a raw line stuffed into a field must fail.
  assert.equal(event.errorMessage, 'boom');
  // [/0.5.5-ALLOWED]
});

test('turn.failed emits no usage marker', () => {
  // [0.5.5-ALLOWED] W7: turn.failed carries no usage, so none is invented.
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  handleEvent(parseMiniMaxStreamLine(JSON.stringify({
    type: 'turn.failed', status: 'failed',
    error: { category: 'runtime', code: 'E3', message: 'boom', retryable: false },
    durationMs: 9,
  })));
  assert.equal(emitter.emitted.usage.length, 0);
  assert.equal(emitter.emitted.content.length, 0);
  assert.equal(emitter.emitted.errors.length, 0, 'the reason is surfaced by the result line, not here');
  // [/0.5.5-ALLOWED]
});

test('turn.failed is not a terminal event', () => {
  // [0.5.5-ALLOWED] W7: the bundle's emit order has exec.completed after
  // turn.failed, so the latter is not what ends the run. Assumed, not observed:
  // the capture contains no turn.failed line.
  const line = JSON.stringify({
    type: 'turn.failed', status: 'failed', durationMs: 3,
    error: { category: 'runtime', code: 'E4', message: 'boom', retryable: false },
  });
  assert.equal(isMiniMaxTerminalLine(line), false);
  // [/0.5.5-ALLOWED]
});

test('a failure reason carried only by turn.failed reaches the user', () => {
  // [0.5.5-ALLOWED] W6: exec.completed may omit the reason turn.failed carried.
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  handleEvent(parseMiniMaxStreamLine(JSON.stringify({
    type: 'turn.failed', status: 'failed',
    error: { category: 'runtime', code: 'E5', message: 'boom', retryable: false },
  })));
  handleEvent(parseMiniMaxStreamLine(JSON.stringify({
    type: 'exec.completed', result: { type: 'exec.result', status: 'failed' },
  })));
  assert.deepEqual(emitter.emitted.errors, ['boom']);
  // [/0.5.5-ALLOWED]
});

test('turn.failed with no result event still produces a [SEND_ERROR]', () => {
  // [0.5.5-ALLOWED] W6: this is the branch the capture cannot produce — the
  // orphan run. The failure mode it removes: the CLI reports turn.failed,
  // never sends exec.completed and exits 0, so shouldTerminate never fires and
  // runCliStreaming's non-zero-exit fallback never fires either. Without the
  // finally-block net, turnFailureMessage is written and never read and the UI
  // ends the run with no output at all.
  const orphan = JSON.stringify({
    type: 'turn.failed', status: 'failed',
    error: { category: 'runtime', code: 'E6', message: 'quota exhausted', retryable: false },
  });

  // State the handler leaves behind after an orphan turn.failed — the exact
  // input the finally-block net evaluates.
  const emitter = createFakeEmitter();
  const stream = createMiniMaxEventHandler(emitter);
  stream.handleEvent(parseMiniMaxStreamLine(orphan));
  assert.equal(stream.sawResult, false, 'no result event was seen');
  assert.equal(stream.turnFailureMessage, 'quota exhausted');
  assert.deepEqual(emitter.emitted.errors, [], 'nothing is reported mid-run, only at the end');

  // The net itself, evaluated on that state.
  assert.equal(resolveUnterminatedFailureReason(stream), 'quota exhausted');

  // ...and the two states in which it must stay silent: a normal run (the
  // result line already reported the reason — exactly one error overall) and a
  // run that never recorded a reason (nothing to invent).
  const normal = createFakeEmitter();
  const normalStream = createMiniMaxEventHandler(normal);
  normalStream.handleEvent(parseMiniMaxStreamLine(orphan));
  normalStream.handleEvent(parseMiniMaxStreamLine(JSON.stringify({
    type: 'exec.completed', result: { type: 'exec.result', status: 'failed' },
  })));
  assert.equal(normalStream.sawResult, true);
  assert.equal(resolveUnterminatedFailureReason(normalStream), '', 'must not double-report');
  assert.deepEqual(normal.emitted.errors, ['quota exhausted'], 'the result line reported it once');

  assert.equal(resolveUnterminatedFailureReason({ sawResult: false, turnFailureMessage: '' }), '');
  assert.equal(resolveUnterminatedFailureReason({ sawResult: true, turnFailureMessage: 'x' }), '');
  // [/0.5.5-ALLOWED]
});

// ===========================================================================
// defect 3 / defect 10 — session.resumed and turn.started share one case block
// ===========================================================================

test('session.started, session.resumed and turn.started all resolve to one session event', () => {
  // [0.5.5-ALLOWED] W5: single-point probes pinning the three case labels to
  // the same guarded session branch.
  for (const type of ['session.started', 'session.resumed', 'turn.started']) {
    assert.deepEqual(
      parseMiniMaxStreamLine(JSON.stringify({ type, sessionId: 'mvs_1', turnId: 'turn_1' })),
      { kind: 'session', sessionId: 'mvs_1' },
      `${type} must resolve to the session branch`,
    );
  }
  // [/0.5.5-ALLOWED]
});

test('one session id arriving through four events emits one session marker', () => {
  // [0.5.5-ALLOWED] W5: the real run shape — exec.started, session.*,
  // turn.started and exec.completed.result all carry the same sessionId.
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  for (const type of ['exec.started', 'session.resumed', 'turn.started']) {
    handleEvent(parseMiniMaxStreamLine(JSON.stringify({ type, sessionId: 'mvs_1' })));
  }
  handleEvent(parseMiniMaxStreamLine(JSON.stringify({
    type: 'exec.completed', result: { type: 'exec.result', sessionId: 'mvs_1', status: 'succeeded' },
  })));
  assert.deepEqual(emitter.emitted.sessionIds, ['mvs_1']);
  // [/0.5.5-ALLOWED]
});

// The parser dispatches on two routing tables — schema A (0.5.x) and schema B
// (legacy delta/message/exec.result) — so a type listed in a table but missing
// from that table's own branch, or a table entry pointing at the other
// protocol, would degrade the line to {kind:'other'}. One minimal payload per
// routing-table entry pins both directions at once.
// [/0.5.5-ALLOWED] W5: single-point probes, one per event type.
test('every routing-table type is answered by its own protocol branch', () => {
  const probes = [
    ['exec.started', { sessionId: 'mvs_1' }, 'session'],
    ['session.started', { sessionId: 'mvs_1' }, 'session'],
    ['session.resumed', { sessionId: 'mvs_1' }, 'session'],
    ['turn.started', { sessionId: 'mvs_1' }, 'session'],
    ['item.started', { item: { type: 'agent_message', id: 'i1', contentDelta: 'a' } }, 'text'],
    ['item.updated', { item: { type: 'reasoning', id: 'i2', contentDelta: 'b' } }, 'thinking'],
    ['item.completed', { item: { type: 'agent_message', id: 'i3', content: 'c' } }, 'text_final'],
    ['item.completed', { item: { type: 'reasoning', id: 'i4', content: 'd' } }, 'thinking_final'],
    ['turn.completed', { usage: { inputTokens: 1, outputTokens: 1 } }, 'usage'],
    ['turn.failed', { status: 'failed', error: 'why' }, 'turn_failed'],
    ['exec.completed', { result: { status: 'succeeded', sessionId: 'mvs_1' } }, 'result'],
    ['delta', { content: 'x', messageId: 'm1' }, 'text'],
    ['message', { message: { role: 'assistant', usage: { inputTokens: 1, outputTokens: 1 } } }, 'usage'],
    ['exec.result', { status: 'succeeded', sessionId: 'mvs_1' }, 'result'],
  ];
  for (const [type, payload, expectedKind] of probes) {
    assert.equal(
      parseMiniMaxStreamLine(JSON.stringify({ type, ...payload })).kind,
      expectedKind,
      `${type} must be answered by its own protocol table`,
    );
  }
  // [/0.5.5-ALLOWED]
});

// ===========================================================================
// defect 4 — usage: cacheWriteTokens / reasoningTokens, total_tokens formula
// ===========================================================================

test('a five-field usage payload maps to exactly the five expected snake keys', () => {
  // W10: constructed with five DISTINCT values on purpose — otherwise swapping
  // inputTokens and outputTokens would still satisfy a key-set assertion.
  const normalized = normalizeMiniMaxUsage({
    inputTokens: 101, cacheReadTokens: 102, cacheWriteTokens: 103,
    outputTokens: 104, reasoningTokens: 105,
  });
  // total_tokens is always present (reconstructed when the CLI omits it), so
  // the reachable assertion is "the five mapped keys, and nothing else".
  assert.deepEqual(Object.keys(normalized).sort(), [
    'cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens',
    'output_tokens', 'reasoning_tokens', 'total_tokens',
  ]);
  assert.equal(normalized.input_tokens, 101);
  assert.equal(normalized.cache_read_input_tokens, 102);
  assert.equal(normalized.cache_creation_input_tokens, 103);
  assert.equal(normalized.output_tokens, 104);
  assert.equal(normalized.reasoning_tokens, 105);
});

test('cacheWriteTokens becomes cache_creation_input_tokens (the key Java reads)', () => {
  // Java TokenUsageUtils.java:35-36 / :54 read usage.get("cache_creation_input_tokens").
  const normalized = normalizeMiniMaxUsage({
    inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40,
  });
  assert.equal(normalized.cache_creation_input_tokens, 30);
  assert.equal('cache_write_input_tokens' in normalized, false);
});

test('total_tokens is reconstructed with the Java four-term formula', () => {
  // Java TokenUsageUtils.calculateTotalTokens = input + cache_creation +
  // cache_read + output. This is deliberately NOT the mcode CLI status-bar
  // number (input + output), so a reconstructed total can exceed it.
  const normalized = normalizeMiniMaxUsage({
    inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40,
  });
  assert.equal(normalized.total_tokens, 100);
  assert.notEqual(normalized.total_tokens, normalized.input_tokens + normalized.output_tokens);
});

test('a CLI-supplied total_tokens is passed through untouched', () => {
  const normalized = normalizeMiniMaxUsage({
    inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30,
    outputTokens: 40, totalTokens: 7777,
  });
  assert.equal(normalized.total_tokens, 7777);
});

test('a real-shaped usage payload with a cache write carries the billing key', () => {
  // 6(6) on real captured values: mcode 0.5.5 with MiniMax-M3.1 never reported
  // cacheWriteTokens in the captured runs (see the next test), so the field is
  // injected onto a real payload to prove the mapping on the real code path.
  const usage = firstEvent((e) => e.type === 'turn.completed' && e.usage).usage;
  const normalized = normalizeMiniMaxUsage({ ...usage, cacheWriteTokens: 4242 });
  assert.equal(normalized.cache_creation_input_tokens, 4242);
  assert.equal(normalized.input_tokens, usage.inputTokens);
});

test('the cache key is present exactly when the CLI sent a cache write', () => {
  // 6(6): both branches are asserted explicitly. The old version could only
  // ever reach the "CLI sent one" branch, which neither captured usage payload
  // satisfies, so the billing key's absence case had no coverage at all.
  //
  // Branch 1 — the real capture: 0.5.5 reported no cache write, so the Java
  // billing key must be absent.
  const captured = eventWhere((e) => e.type === 'turn.completed' && e.usage).map((e) => e.usage);
  assert.ok(captured.length >= 2, 'both captured runs must carry a usage payload');
  for (const usage of captured) {
    assert.equal('cacheWriteTokens' in usage, false, '0.5.5 sent no cacheWriteTokens in the capture');
    const normalized = normalizeMiniMaxUsage(usage);
    assert.equal(
      'cache_creation_input_tokens' in normalized,
      false,
      'no cache write reported must mean no billing key',
    );
  }

  // Branch 2 — a payload that does report one: the key must appear and carry
  // the exact value (asserted on a copy of a real payload, so the rest of the
  // shape is the captured one).
  const withWrite = normalizeMiniMaxUsage({ ...captured[0], cacheWriteTokens: 4242 });
  assert.equal('cache_creation_input_tokens' in withWrite, true);
  assert.equal(withWrite.cache_creation_input_tokens, 4242);
});

// ===========================================================================
// defect 5 — toolCall.status: numbers only, with a numeric-string fallback
// ===========================================================================

test('normalizeToolStatus passes numbers through and rejects everything else', () => {
  assert.equal(normalizeToolStatus(1), 1);
  assert.equal(normalizeToolStatus(2), 2);
  assert.equal(normalizeToolStatus(4), 4);
  assert.equal(normalizeToolStatus(5), 5);
  assert.equal(normalizeToolStatus('1'), 1);
  assert.equal(normalizeToolStatus(' 2 '), 2);
  assert.equal(normalizeToolStatus('0'), 0);
  for (const value of [
    '', ' ', 'started', 'completed', 'succeeded', 'success', 'failed', 'error',
    'in_progress', '1.0', '1e1', '+1', '-1', null, undefined, NaN, Infinity, -Infinity,
    true, {}, [], () => {},
  ]) {
    assert.equal(normalizeToolStatus(value), undefined, `${JSON.stringify(value) ?? String(value)} must be rejected`);
  }
});

test('pending tool statuses 4 and 5 are ignored (K11: deliberate, not drift)', () => {
  // [0.5.5-ALLOWED] W8: the capture contains such rows, but 8(2)(b)/9(1)
  // absorb them in the exclusion set, so they need a single-point assertion.
  for (const status of [4, 5]) {
    assert.deepEqual(
      parseMiniMaxStreamLine(JSON.stringify({
        type: 'item.started',
        item: { id: 't1', type: 'tool_call', toolCall: { id: 'c1', name: 'read', status } },
      })),
      { kind: 'other' },
      `status ${status} must not create an empty tool card`,
    );
  }
  // [/0.5.5-ALLOWED]
});

test('numeric string statuses behave exactly like the numeric ones', () => {
  // [0.5.5-ALLOWED] W9: 0.5.5 always sends Int32, so the string form can only
  // be asserted from a constructed sample.
  const numericStart = parseMiniMaxStreamLine(JSON.stringify({
    type: 'item.started',
    item: { id: 't1', type: 'tool_call', toolCall: { id: 'c1', name: 'read', status: 1, input: { path: 'a' } } },
  }));
  const stringStart = parseMiniMaxStreamLine(JSON.stringify({
    type: 'item.started',
    item: { id: 't1', type: 'tool_call', toolCall: { id: 'c1', name: 'read', status: '1', input: { path: 'a' } } },
  }));
  assert.deepEqual(stringStart, numericStart);
  assert.equal(stringStart.kind, 'tool_start');

  const numericDone = parseMiniMaxStreamLine(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 't1', type: 'tool_call',
      toolCall: {
        id: 'c1', name: 'read', status: 2, input: { path: 'a' },
        output: { content: [{ type: 'text', text: 'hi' }] },
      },
    },
  }));
  const stringDone = parseMiniMaxStreamLine(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 't1', type: 'tool_call',
      toolCall: {
        id: 'c1', name: 'read', status: '2', input: { path: 'a' },
        output: { content: [{ type: 'text', text: 'hi' }] },
      },
    },
  }));
  assert.deepEqual(stringDone, numericDone);
  assert.equal(stringDone.kind, 'tool_done');
  assert.equal(stringDone.output, 'hi');
  // [/0.5.5-ALLOWED]
});

test('word-form tool statuses are rejected, not aliased', () => {
  // [0.5.5-ALLOWED] W9: the legacy telemetry observer's word table is NOT the
  // 0.5.x wire contract (K10), so none of these may produce a tool event.
  for (const status of [
    '', ' ', 'started', 'completed', 'succeeded', 'success', 'failed', 'error',
    'in_progress', '1.0', null, undefined,
  ]) {
    assert.deepEqual(
      parseMiniMaxStreamLine(JSON.stringify({
        type: 'item.updated',
        item: { id: 't1', type: 'tool_call', toolCall: { id: 'c1', name: 'read', status, input: { path: 'a' } } },
      })),
      { kind: 'other' },
      `status ${JSON.stringify(status)} must be rejected`,
    );
  }
  // [/0.5.5-ALLOWED]
});

test('the fixture only ever carries Int32 tool statuses', () => {
  const statuses = eventWhere((e) => e.item?.type === 'tool_call')
    .map((e) => e.item.toolCall?.status);
  assert.ok(statuses.length > 0, 'fixture must contain tool calls');
  for (const status of statuses) {
    assert.equal(typeof status, 'number', `0.5.5 sent a non-numeric status: ${status}`);
  }
  assert.deepEqual([...new Set(statuses)].sort(), [1, 2, 4, 5]);
});

// ===========================================================================
// plan step 7 — the injected-emitter handler: de-duplication
// ===========================================================================

test('streamed deltas are concatenated and the replayed full text is dropped', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  const id = eventWhere((e) => e.item?.type === 'agent_message' && 'contentDelta' in e.item)[0].item.id;
  const deltas = eventWhere((e) => e.item?.type === 'agent_message' && e.item.id === id && 'contentDelta' in e.item)
    .map((e) => e.item.contentDelta);
  const final = eventWhere((e) => e.item?.type === 'agent_message' && e.item.id === id && 'content' in e.item)[0]
    .item.content;
  assert.ok(deltas.length >= 2, 'the capture should provide several deltas for one id');

  for (const delta of deltas) handleEvent({ kind: 'text', data: delta, messageId: id });
  handleEvent({ kind: 'text_final', data: final, messageId: id });

  // One entry per streamed delta, and no extra entry for the replayed full text.
  assert.deepEqual(emitter.emitted.content, deltas);
  assert.equal(emitter.emitted.content.length, deltas.length);
  // final is the concatenation of the deltas, so it is longer than any chunk.
  assert.equal(
    emitter.emitted.content.includes(final),
    false,
    'the replayed full text must not be emitted again',
  );
});

test('a final with no preceding deltas is still emitted', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  handleEvent({ kind: 'text_final', data: 'only source', messageId: 'x' });
  handleEvent({ kind: 'text_final', data: 'only source', messageId: 'x' });
  assert.deepEqual(emitter.emitted.content, ['only source']);
});

test('reasoning and content de-duplicate in two independent sets', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  // Same id on both: the reasoning final is swallowed, the content final is not.
  handleEvent({ kind: 'thinking', data: 't1 ', messageId: 'same' });
  handleEvent({ kind: 'thinking', data: 't2', messageId: 'same' });
  handleEvent({ kind: 'thinking_final', data: 't1 t2', messageId: 'same' });
  handleEvent({ kind: 'text_final', data: 'answer', messageId: 'same' });
  assert.deepEqual(emitter.emitted.thinking, ['t1 ', 't2']);
  assert.deepEqual(emitter.emitted.content, ['answer']);
});

// The mirror of the case above: content streams first, so the *reasoning* final
// is the one that must survive. Together the two directions forbid merging the
// two id sets into one.
test('a content id does not swallow the reasoning final carrying the same id', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  handleEvent({ kind: 'text', data: 'a1 ', messageId: 'same' });
  handleEvent({ kind: 'thinking_final', data: 'mind', messageId: 'same' });
  assert.deepEqual(emitter.emitted.content, ['a1 ']);
  assert.deepEqual(emitter.emitted.thinking, ['mind']);
});

test('a repeated tool call id yields one tool_use and one tool_result', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  const call = { id: 'call-1', name: 'read', input: { path: 'a' } };
  for (let i = 0; i < 2; i += 1) {
    handleEvent({ kind: 'tool_start', call });
    handleEvent({ kind: 'tool_done', call, output: `out${i}` });
  }
  assert.equal(emitter.emitted.toolUse.length, 1);
  assert.equal(emitter.emitted.toolResult.length, 1);
  assert.deepEqual(emitter.emitted.toolResult[0].toolUseId, 'call-1');
});

test('a tool_done without a preceding tool_start still emits both markers', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  const call = { id: 'call-2', name: 'read', input: { path: 'a' } };
  handleEvent({ kind: 'tool_done', call, output: 'out' });
  assert.equal(emitter.emitted.toolUse.length, 1);
  assert.equal(emitter.emitted.toolResult.length, 1);
});

test('the usage safety net emits a message body that never streamed', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  handleEvent({
    kind: 'usage',
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    message: { id: 'm9', role: 'assistant', content: 'body', thinking: 'mind' },
  });
  assert.deepEqual(emitter.emitted.content, ['body']);
  assert.deepEqual(emitter.emitted.thinking, ['mind']);
  assert.equal(emitter.emitted.usage.length, 1);
});

test('a non-streaming event is ignored without throwing', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  handleEvent(undefined);
  handleEvent(null);
  handleEvent('nope');
  handleEvent({ kind: 'other' });
  assert.deepEqual(emitter.emitted, {
    sessionIds: [], content: [], thinking: [], toolUse: [], toolResult: [], usage: [], errors: [],
  });
});

test('multi events fan out to their parts (legacy delta shape)', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  handleEvent({
    kind: 'multi',
    events: [
      { kind: 'thinking', data: 't', messageId: 'm' },
      { kind: 'text', data: 'c', messageId: 'm' },
    ],
  });
  assert.deepEqual(emitter.emitted.thinking, ['t']);
  assert.deepEqual(emitter.emitted.content, ['c']);
});

// ===========================================================================
// plan step 8 — fixture replay, fragment by fragment
// ===========================================================================

test('fragment 1 produces session, text, usage and result', () => {
  const { kinds } = replayFragment(fixtureFragments[0]);
  for (const expected of ['session', 'text', 'usage', 'result']) {
    assert.ok(kinds.includes(expected), `fragment 1 must produce a ${expected} event, got ${kinds.join(',')}`);
  }
  // K12: this model emitted no reasoning item, so no `thinking` can be expected.
  // 8(6): the assertion stays in the suite as an explicit skip, never deleted.
});

test('a thinking event is produced when the capture contains reasoning items', {
  skip: 'K12: neither captured run produced a reasoning item',
}, () => {
  const hasReasoning = eventWhere((e) => e.item?.type === 'reasoning').length > 0;
  if (!hasReasoning) return;
  const { kinds } = replayFragment(fixtureFragments[0]);
  assert.ok(kinds.includes('thinking'));
});

test('every fragment leaves no unhandled event outside the exclusion set', () => {
  fixtureFragments.forEach((fragment, index) => {
    const { unhandled } = replayFragment(fragment);
    const unexpected = unhandled.filter((event) => !isExcludedOther(event));
    assert.deepEqual(
      unexpected.map((e) => e.type),
      [],
      `fragment ${index + 1} left unhandled: ${JSON.stringify(unexpected.map((e) => e.type))}`,
    );
  });
});

test('the excluded rows really are the pending-tool shape', () => {
  const excluded = [];
  for (const fragment of fixtureFragments) {
    for (const { raw, event } of fragment) {
      if (parseMiniMaxStreamLine(raw).kind === 'other') excluded.push(event);
    }
  }
  assert.ok(excluded.length > 0, 'the capture should contain pending tool rows');
  for (const event of excluded) {
    assert.equal(isExcludedOther(event), true, `${event.type} must be in the exclusion set`);
    assert.equal(event.item.type, 'tool_call');
    assert.ok(!('input' in event.item.toolCall) && !('output' in event.item.toolCall));
  }
});

test('fragment 2 (the resumed run) also yields a session id and a result', () => {
  assert.ok(fixtureFragments.length >= 2, 'the capture must contain the resumed run');
  for (const fragment of fixtureFragments.slice(1)) {
    const { kinds, emitted } = replayFragment(fragment);
    assert.ok(kinds.includes('session'), 'a resumed run must surface its session id');
    assert.ok(kinds.includes('result'), 'a resumed run must reach a result');
    assert.ok(emitted.sessionIds.length > 0);
  }
});

test('replaying the capture emits content, tool cards, usage and one session id', () => {
  const emitter = createFakeEmitter();
  const { handleEvent } = createMiniMaxEventHandler(emitter);
  for (const { raw } of fixtureRecords) {
    handleEvent(parseMiniMaxStreamLine(raw));
  }
  assert.ok(emitter.emitted.content.length > 0, 'the answer text must reach the marker');
  assert.ok(emitter.emitted.toolUse.length > 0, 'the tool call must reach the marker');
  assert.ok(emitter.emitted.toolResult.length > 0);
  assert.ok(emitter.emitted.usage.length > 0);
  // Exact de-duplicated text, not just "something was emitted": the streamed
  // deltas of each id, in order, with the replayed full text dropped.
  const streamedDeltas = eventWhere((e) => e.item?.type === 'agent_message' && 'contentDelta' in e.item)
    .map((e) => e.item.contentDelta);
  assert.deepEqual(emitter.emitted.content, streamedDeltas);
  const streamedToolIds = [...new Set(eventWhere((e) => (
    e.item?.type === 'tool_call' && e.item.toolCall?.status === 1
  )).map((e) => e.item.toolCall.id))];
  assert.deepEqual(emitter.emitted.toolUse.map((c) => c.id), streamedToolIds);
  // One run captured at a time: run 1 and the resumed run share a session id.
  assert.deepEqual(emitter.emitted.sessionIds, [fixtureFragments[0][0].event.sessionId]);
});

// ===========================================================================
// plan step 9 — protocol-drift visibility
// ===========================================================================

test('a healthy capture tallies nothing as unknown (the known shapes are skipped)', () => {
  // Single pass: the old version parsed the whole capture twice (so its own
  // counters were doubled) and only asserted `count > 0` — it never checked
  // the "minus the known shapes" its title promised.
  resetMiniMaxUnknownTypeCounts();
  try {
    for (const { raw } of fixtureRecords) parseMiniMaxStreamLine(raw);

    const pendingRows = eventWhere(isExcludedOther).length;
    assert.ok(pendingRows > 0, 'the capture must contain pending tool rows to be excluded');
    // The only {kind:'other'} lines in a healthy capture are the pending rows,
    // so the unknown tally — the aggregate minus the known shapes — must be
    // empty, and the skipped bucket must hold exactly those rows.
    assert.deepEqual(getMiniMaxUnknownTypeCounts(), {});
    assert.deepEqual(getMiniMaxSkippedShapeCounts(), { tool_pending: pendingRows });
  } finally {
    resetMiniMaxUnknownTypeCounts();
  }
});

test('a healthy capture warns about no drift and reports the skips separately', () => {
  resetMiniMaxUnknownTypeCounts();
  const seen = [];
  const original = console.error;
  console.error = (...args) => seen.push(args.map(String).join(' '));
  try {
    for (const { raw } of fixtureRecords) parseMiniMaxStreamLine(raw);
    flushMiniMaxUnknownTypeCounts();
  } finally {
    console.error = original;
  }
  const stderr = seen.join('\n');
  const pendingRows = eventWhere(isExcludedOther).length;
  assert.ok(stderr.includes(`skipped_tool_pending=${pendingRows}`), 'the known shape must be named and counted');
  // The regression this guards: before the split, every healthy run printed
  // "unhandled event type: item.started/item.updated" plus a top-N summary, so
  // a real 0.5.6 rename would be indistinguishable from the daily noise.
  assert.equal(stderr.includes('unhandled event type'), false, 'a healthy run must not report drift');
  assert.equal(stderr.includes('unhandled event types (top'), false);
  resetMiniMaxUnknownTypeCounts();
});

test('an unknown event type is reported on stderr with [DEBUG][MiniMax]', () => {
  resetMiniMaxUnknownTypeCounts();
  const seen = [];
  const original = console.error;
  console.error = (...args) => seen.push(args.map(String).join(' '));
  try {
    // [0.5.5-ALLOWED] W11: a synthetic type; no capture can contain it.
    parseMiniMaxStreamLine('{"type":"totally.unknown.event","payload":1}');
    flushMiniMaxUnknownTypeCounts();
  } finally {
    console.error = original;
  }
  const text = seen.join('\n');
  assert.ok(text.includes('[DEBUG][MiniMax]'), 'drift must be announced under the debug prefix');
  assert.ok(text.includes('totally.unknown.event'), 'the unknown type name must be visible');
  assert.ok(text.includes('unhandled event types (top 5): totally.unknown.event=1'));
  assert.deepEqual(getMiniMaxUnknownTypeCounts()['totally.unknown.event'], 1);
  // A real unknown must not be able to hide in the skip bucket.
  assert.deepEqual(getMiniMaxSkippedShapeCounts(), {});
  // [/0.5.5-ALLOWED]
  resetMiniMaxUnknownTypeCounts();
});

test('a 0.5.x event type that turns unknown is still tallied, not skipped', () => {
  // The skip bucket must be closed over the reasons the parser actually emits:
  // a renamed/added 0.5.x type carries no reason and has to surface as drift.
  resetMiniMaxUnknownTypeCounts();
  const original = console.error;
  console.error = () => {};
  try {
    for (const type of ['turn.completed.renamed', 'item.started.unmapped', 'exec.completed2']) {
      parseMiniMaxStreamLine(JSON.stringify({ type, sessionId: 'mvs_1' }));
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(getMiniMaxUnknownTypeCounts(), {
    'turn.completed.renamed': 1, 'item.started.unmapped': 1, 'exec.completed2': 1,
  });
  assert.deepEqual(getMiniMaxSkippedShapeCounts(), {});
  resetMiniMaxUnknownTypeCounts();
});

test('the tally is a per-type aggregate across a run', () => {
  resetMiniMaxUnknownTypeCounts();
  const original = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 3; i += 1) {
      parseMiniMaxStreamLine('{"type":"repeat.me","n":' + i + '}');
    }
    parseMiniMaxStreamLine('{"type":"once.me"}');
  } finally {
    console.error = original;
  }
  const counts = getMiniMaxUnknownTypeCounts();
  assert.equal(counts['repeat.me'], 3);
  assert.equal(counts['once.me'], 1);
  resetMiniMaxUnknownTypeCounts();
});

test('markers stay on stdout and debug output stays on stderr', () => {
  resetMiniMaxUnknownTypeCounts();
  const out = [];
  const err = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalError = console.error;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  console.log = (...args) => { out.push(args.map(String).join(' ') + '\n'); };
  console.error = (...args) => { err.push(args.map(String).join(' ')); };
  try {
    // Real emitter (default), fed real capture lines including a pending tool row.
    const { handleEvent } = createMiniMaxEventHandler();
    for (const { raw } of fixtureRecords) handleEvent(parseMiniMaxStreamLine(raw));
    flushMiniMaxUnknownTypeCounts();
  } finally {
    process.stdout.write = originalOut;
    console.log = originalLog;
    console.error = originalError;
  }
  const stdout = out.join('');
  const stderr = err.join('\n');
  assert.ok(stdout.includes('[SESSION_ID]'), 'markers must still be written to stdout');
  assert.ok(stdout.includes('[USAGE]'), 'usage must still be written to stdout');
  assert.equal(stdout.includes('[DEBUG][MiniMax]'), false, 'debug output must not reach stdout');
  assert.equal(stderr.includes('[USAGE]'), false);
  assert.ok(stderr.includes('[DEBUG][MiniMax]'), 'the aggregate must be announced on stderr');
  resetMiniMaxUnknownTypeCounts();
});

// ---------------------------------------------------------------------------
// mcode exec argv: native image attachments via --file
// ---------------------------------------------------------------------------

test('buildMiniMaxArgs attaches each image with --file before the prompt', () => {
  const args = buildMiniMaxArgs({
    message: 'what color?',
    sessionId: 'mvs_abc',
    model: '',
    permissionMode: 'bypassPermissions',
    cwd: 'F:/proj',
    imagePaths: ['C:/tmp/a.png', 'C:/tmp/b.png'],
  });
  const promptIndex = args.indexOf('what color?');
  const fileA = args.indexOf('--file');
  assert.ok(fileA > 0, '--file must be present');
  assert.equal(args[fileA + 1], 'C:/tmp/a.png');
  assert.equal(args[args.indexOf('--file', fileA + 1) + 1], 'C:/tmp/b.png');
  // Flags before the positional prompt, prompt stays the last token.
  assert.ok(promptIndex > args.lastIndexOf('--file') + 1);
  assert.equal(args[args.length - 1], 'what color?');
  // No Kimi-style prompt injection remains: the raw text is passed through.
  assert.equal(args.includes('what color?'), true);
});

test('buildMiniMaxArgs without images has no --file and ignores falsy entries', () => {
  const noImages = buildMiniMaxArgs({
    message: 'hi', sessionId: '', model: '', permissionMode: '', cwd: '',
  });
  assert.equal(noImages.includes('--file'), false);
  assert.equal(noImages[noImages.length - 1], 'hi');

  const withFalsy = buildMiniMaxArgs({
    message: 'hi', sessionId: '', model: '', permissionMode: '', cwd: '',
    imagePaths: ['', null, undefined, 'C:/tmp/ok.png'],
  });
  assert.deepEqual(withFalsy.slice(withFalsy.indexOf('--file'), -1), ['--file', 'C:/tmp/ok.png']);
});

// ---------------------------------------------------------------------------
// Multi-line/oversized prompts ride stdin (--input -), not argv
// ---------------------------------------------------------------------------

test('shouldUseStdinPrompt flags newlines and oversized single lines', () => {
  assert.equal(shouldUseStdinPrompt('one line'), false);
  assert.equal(shouldUseStdinPrompt('line1\nline2'), true);
  assert.equal(shouldUseStdinPrompt('line1\rline2'), true);
  assert.equal(shouldUseStdinPrompt('with trailing newline\n'), true);
  assert.equal(shouldUseStdinPrompt('a'.repeat(12001)), true);
  assert.equal(shouldUseStdinPrompt('a'.repeat(12000)), false);
  assert.equal(shouldUseStdinPrompt(''), false);
  assert.equal(shouldUseStdinPrompt(null), false);
  assert.equal(shouldUseStdinPrompt(undefined), false);
});

test('buildMiniMaxArgs stdin mode uses --input - and drops the prompt positional', () => {
  const args = buildMiniMaxArgs({
    message: 'multi\nline log',
    sessionId: 'mvs_abc',
    model: '',
    permissionMode: 'bypassPermissions',
    cwd: 'F:/proj',
    imagePaths: ['C:/tmp/a.png'],
    promptViaStdin: true,
  });
  const inputIdx = args.indexOf('--input');
  assert.equal(args[inputIdx + 1], '-');
  assert.equal(args[args.indexOf('--input-format') + 1], 'text');
  // The prompt positional is gone — argv never carries the payload.
  assert.equal(args.includes('multi\nline log'), false);
  assert.equal(args.includes('multi'), false);
  // --file attachments still ride argv.
  assert.equal(args[args.indexOf('--file') + 1], 'C:/tmp/a.png');
  // Non-stdin mode keeps the prompt as the last token.
  const argvMode = buildMiniMaxArgs({
    message: 'short one', sessionId: '', model: '', permissionMode: '', cwd: '', promptViaStdin: false,
  });
  assert.equal(argvMode[argvMode.length - 1], 'short one');
  assert.equal(argvMode.includes('--input'), false);
});
