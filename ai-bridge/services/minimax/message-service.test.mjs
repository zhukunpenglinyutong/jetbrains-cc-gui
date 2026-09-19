import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMiniMaxStreamLine } from './message-service.js';

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

// ---------------------------------------------------------------------------
// mcode >= 0.4.x item-based stream events (schemaVersion 1 envelopes)
// ---------------------------------------------------------------------------

test('0.4.x item.updated agent_message contentDelta maps to text event', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 6, timestampMs: 1789544529033,
    runId: 'exec_turn_x', sessionId: 'mvs_abc', turnId: 'turn_x',
    type: 'item.updated',
    item: { id: 'uuid:message', type: 'agent_message', contentDelta: 'I\'ll run that' },
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'text', data: 'I\'ll run that', messageId: 'uuid:message',
  });
});

test('0.4.x item.started reasoning contentDelta maps to thinking event', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 4, timestampMs: 1789544529033,
    runId: 'exec_turn_x', sessionId: 'mvs_abc', turnId: 'turn_x',
    type: 'item.started',
    item: { id: 'uuid:reasoning', type: 'reasoning', contentDelta: 'The user is asking' },
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'thinking', data: 'The user is asking', messageId: 'uuid:reasoning',
  });
});

test('0.4.x item tool_call status 1 maps to tool_start', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 11, type: 'item.updated',
    item: {
      id: 'call_846fff14d71d2a86', type: 'tool_call',
      toolCall: { id: 'call_846fff14d71d2a86', name: 'bash', status: 1, input: { command: 'echo hi' } },
    },
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'tool_start');
  assert.equal(event.call.id, 'call_846fff14d71d2a86');
  assert.equal(event.call.name, 'bash');
  assert.deepEqual(event.call.input, { command: 'echo hi' });
});

test('0.4.x item tool_call status 2 maps to tool_done with output text', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 12, type: 'item.updated',
    item: {
      id: 'call_846fff14d71d2a86', type: 'tool_call',
      toolCall: {
        id: 'call_846fff14d71d2a86', name: 'bash', status: 2,
        input: { command: 'echo hi' },
        output: { content: [{ type: 'text', text: 'hi\r\n' }], details: { status: 'completed' } },
      },
    },
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'tool_done');
  assert.equal(event.call.id, 'call_846fff14d71d2a86');
  assert.equal(event.output, 'hi\r\n');
});

test('0.4.x item tool_call queued/running statuses (4/5) are ignored', () => {
  for (const status of [4, 5]) {
    const line = JSON.stringify({
      schemaVersion: 1, sequence: 8, type: 'item.updated',
      item: {
        id: 'call_1', type: 'tool_call',
        toolCall: { id: 'call_1', name: 'bash', status },
      },
    });
    assert.deepEqual(parseMiniMaxStreamLine(line), { kind: 'other' });
  }
});

test('0.4.x item.completed agent_message maps to completed_item fallback', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 44, type: 'item.completed',
    item: { id: 'uuid:message', type: 'agent_message', content: 'ok' },
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'completed_item', itemType: 'agent_message',
    messageId: 'uuid:message', content: 'ok',
  });
});

test('0.4.x item.completed reasoning maps to completed_item fallback', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 43, type: 'item.completed',
    item: { id: 'uuid:reasoning', type: 'reasoning', content: 'thought about it' },
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'completed_item', itemType: 'reasoning',
    messageId: 'uuid:reasoning', content: 'thought about it',
  });
});

test('0.4.x item.completed tool_call status 2 maps to tool_done', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 15, type: 'item.completed',
    item: {
      id: 'call_1', type: 'tool_call',
      toolCall: { id: 'call_1', name: 'bash', status: 2, input: {}, output: { content: 'done' } },
    },
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'tool_done');
  assert.equal(event.output, 'done');
});

test('0.4.x turn.completed maps usage to usage event', () => {
  const usage = {
    inputTokens: 30660, outputTokens: 100, reasoningTokens: 0,
    cacheReadTokens: 128, cacheWriteTokens: 0, totalTokens: 30760,
  };
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 45, type: 'turn.completed',
    model: { providerId: 'minimax', modelId: 'MiniMax-M3' },
    usage, durationMs: 6194,
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), { kind: 'usage', usage });
});

test('0.4.x turn.completed without usage is ignored', () => {
  const line = JSON.stringify({ schemaVersion: 1, sequence: 3, type: 'turn.completed' });
  assert.deepEqual(parseMiniMaxStreamLine(line), { kind: 'other' });
});

test('0.4.x exec.completed succeeded maps to result with sessionId', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 46, type: 'exec.completed',
    runId: 'exec_turn_x', sessionId: 'mvs_b6eca1d466a04b46932ccf5c5ffcc499', turnId: 'turn_x',
    result: {
      schemaVersion: 1, type: 'exec.result', runId: 'exec_turn_x',
      sessionId: 'mvs_b6eca1d466a04b46932ccf5c5ffcc499', turnId: 'turn_x',
      status: 'succeeded', output: 'ok',
      usage: { totalTokens: 30760 },
      durationMs: 6194,
    },
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'result', sessionId: 'mvs_b6eca1d466a04b46932ccf5c5ffcc499',
    status: 'succeeded', failed: false, errorMessage: '', answer: '',
  });
});

test('0.4.x exec.completed failed maps the error object message into result', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 5, type: 'exec.completed',
    sessionId: 'mvs_0f9a7182ec2148c294f38f6f9b703f23',
    result: {
      schemaVersion: 1, type: 'exec.result', status: 'failed',
      sessionId: 'mvs_0f9a7182ec2148c294f38f6f9b703f23',
      error: {
        category: 'runtime',
        message: 'Model "bogus/nonexistent-model" is not available for the "configured_provider" route (preset cn-prod).',
        retryable: true,
      },
      durationMs: 983,
    },
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'result', sessionId: 'mvs_0f9a7182ec2148c294f38f6f9b703f23',
    status: 'failed', failed: true,
    errorMessage: 'Model "bogus/nonexistent-model" is not available for the "configured_provider" route (preset cn-prod).',
    answer: '',
  });
});

test('0.4.x unknown item types are ignored', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 9, type: 'item.updated',
    item: { id: 'x', type: 'file_change', contentDelta: 'patch' },
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), { kind: 'other' });
});

test('0.4.x turn.failed maps the error object message to a turn_failed event', () => {
  const line = JSON.stringify({
    schemaVersion: 1, sequence: 40, type: 'turn.failed', status: 'failed',
    error: { category: 'runtime', message: 'model overloaded', retryable: true },
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'turn_failed', errorMessage: 'model overloaded',
  });
});

test('0.4.x turn.failed accepts a plain string error', () => {
  const line = JSON.stringify({
    schemaVersion: 1, type: 'turn.failed', error: 'rate limited',
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'turn_failed', errorMessage: 'rate limited',
  });
});

test('0.4.x turn.failed without any error text is ignored', () => {
  const line = JSON.stringify({ schemaVersion: 1, type: 'turn.failed', status: 'failed' });
  assert.deepEqual(parseMiniMaxStreamLine(line), { kind: 'other' });
});

test('0.4.x item tool_call string statuses "1"/"2" map like numeric ones', () => {
  const started = JSON.stringify({
    schemaVersion: 1, type: 'item.updated',
    item: { id: 'call_1', type: 'tool_call',
      toolCall: { id: 'call_1', name: 'bash', status: '1', input: {} } },
  });
  assert.equal(parseMiniMaxStreamLine(started).kind, 'tool_start');
  const done = JSON.stringify({
    schemaVersion: 1, type: 'item.updated',
    item: { id: 'call_1', type: 'tool_call',
      toolCall: { id: 'call_1', name: 'bash', status: '2', input: {},
        output: { content: [{ type: 'text', text: 'ok' }] } } },
  });
  const event = parseMiniMaxStreamLine(done);
  assert.equal(event.kind, 'tool_done');
  assert.equal(event.output, 'ok');
});

test('0.4.x exec.completed carries the nested answer text through', () => {
  const line = JSON.stringify({
    schemaVersion: 1, type: 'exec.completed', sessionId: 'mvs_a',
    result: { type: 'exec.result', sessionId: 'mvs_a', status: 'succeeded', answer: 'full answer' },
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'result');
  assert.equal(event.answer, 'full answer');
});
