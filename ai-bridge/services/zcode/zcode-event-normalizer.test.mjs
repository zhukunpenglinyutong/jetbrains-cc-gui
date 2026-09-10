import test from 'node:test';
import assert from 'node:assert/strict';
import { ZcodeEventNormalizer } from './zcode-event-normalizer.js';

function collect() {
  const lines = [];
  const normalizer = new ZcodeEventNormalizer((line) => lines.push(line));
  return { lines, normalizer };
}

function ev(type, payload = {}, turnId = 't1') {
  return { type, seq: 1, sessionId: 's1', turnId, payload };
}

test('text streaming turn emits canonical marker sequence', () => {
  const { lines, normalizer } = collect();
  assert.equal(normalizer.handleSessionEvent(ev('turn.started', { input: 'hi' })), null);
  normalizer.handleSessionEvent(ev('model.streaming', { kind: 'reasoning_delta', delta: 'thinking ' }));
  normalizer.handleSessionEvent(ev('model.streaming', { kind: 'text_delta', delta: 'Hello' }));
  normalizer.handleSessionEvent(ev('model.streaming', { kind: 'text_delta', delta: ' world' }));
  const terminal = normalizer.handleSessionEvent(ev('turn.completed', {
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2 },
  }));

  assert.equal(terminal, 'completed');
  assert.deepEqual(lines[0], '[MESSAGE_START]');
  assert.deepEqual(lines[1], '[STREAM_START]');
  assert.ok(lines.includes('[THINKING_DELTA] "thinking "'));
  assert.ok(lines.includes('[CONTENT_DELTA] "Hello"'));
  assert.ok(lines.includes('[CONTENT_DELTA] " world"'));
  const usage = lines.find((l) => l.startsWith('[USAGE]'));
  const usageJson = JSON.parse(usage.slice('[USAGE]'.length));
  // snake_case contract for the Java side
  assert.equal(usageJson.input_tokens, 10);
  assert.equal(usageJson.cache_read_input_tokens, 2);
  assert.equal(lines.at(-2), '[STREAM_END]');
  assert.equal(lines.at(-1), '[MESSAGE_END]');
});

test('tool call merges streaming input with lifecycle frames', () => {
  const { lines, normalizer } = collect();
  normalizer.handleSessionEvent(ev('turn.started'));
  normalizer.handleSessionEvent(ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'c1', toolName: 'Bash' }));
  normalizer.handleSessionEvent(ev('model.streaming', { kind: 'tool_input_delta', toolCallId: 'c1', delta: '{"command":"echo hi"' }));
  normalizer.handleSessionEvent(ev('model.streaming', { kind: 'tool_input_delta', toolCallId: 'c1', delta: '}' }));
  normalizer.handleSessionEvent(ev('model.streaming', { kind: 'tool_input_end', toolCallId: 'c1' }));
  normalizer.handleSessionEvent(ev('tool.updated', { kind: 'result', toolCallId: 'c1', result: { success: true, content: 'hi\n' } }));
  normalizer.handleSessionEvent(ev('turn.completed', { usage: {} }));

  const toolUse = lines.find((l) => l.includes('tool_use'));
  const parsed = JSON.parse(toolUse.slice('[MESSAGE]'.length));
  const block = parsed.message.content[0];
  assert.equal(block.name, 'Bash');
  assert.deepEqual(block.input, { command: 'echo hi' });

  const toolResult = lines.find((l) => l.startsWith('[TOOL_RESULT]'));
  const resultJson = JSON.parse(toolResult.slice('[TOOL_RESULT]'.length));
  assert.equal(resultJson.tool_use_id, 'c1');
  assert.equal(resultJson.content, 'hi\n');
  assert.equal(resultJson.is_error, false);

  // exactly one tool_use + one tool_result — no duplicates from merged channels
  assert.equal(lines.filter((l) => l.startsWith('[MESSAGE]') && l.includes('"tool_use"')).length, 1);
  assert.equal(lines.filter((l) => l.startsWith('[TOOL_RESULT]')).length, 1);
});

test('tool error surfaces as is_error result', () => {
  const { lines, normalizer } = collect();
  normalizer.handleSessionEvent(ev('turn.started'));
  normalizer.handleSessionEvent(ev('tool.updated', {
    kind: 'error', toolCallId: 'c9', toolName: 'Read', error: { message: 'denied' },
  }));
  normalizer.handleSessionEvent(ev('turn.failed', { error: { message: 'boom' } }));

  const toolResult = JSON.parse(lines.find((l) => l.startsWith('[TOOL_RESULT]')).slice('[TOOL_RESULT]'.length));
  assert.equal(toolResult.is_error, true);
  assert.equal(toolResult.content, 'denied');
  const sendError = JSON.parse(lines.find((l) => l.startsWith('[SEND_ERROR]')).slice('[SEND_ERROR]'.length));
  assert.equal(sendError.error, 'boom');
});

test('turn.failed settles dangling tool calls as cancelled', () => {
  const { lines, normalizer } = collect();
  normalizer.handleSessionEvent(ev('turn.started'));
  normalizer.handleSessionEvent(ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'c2', toolName: 'Edit' }));
  const terminal = normalizer.handleSessionEvent(ev('turn.failed', { error: { message: 'x' } }));
  assert.equal(terminal, 'failed');
  const toolResult = JSON.parse(lines.find((l) => l.startsWith('[TOOL_RESULT]')).slice('[TOOL_RESULT]'.length));
  assert.equal(toolResult.is_error, true);
});

test('events without matching active turn are inert', () => {
  const { lines, normalizer } = collect();
  assert.equal(normalizer.handleSessionEvent(null), null);
  assert.equal(normalizer.handleSessionEvent({ type: 'session.updated', payload: {} }), null);
  assert.deepEqual(lines, []);
});
