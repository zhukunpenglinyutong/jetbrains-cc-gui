import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STALL_TIMEOUT_MS,
  STALL_TIMEOUT_ENV,
  resolveStallTimeoutMs,
  trackToolActivity,
} from './turn-stall-watchdog.js';

test('the stall timeout defaults to ten minutes', () => {
  assert.equal(DEFAULT_STALL_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(resolveStallTimeoutMs({}), DEFAULT_STALL_TIMEOUT_MS);
  assert.equal(resolveStallTimeoutMs({ [STALL_TIMEOUT_ENV]: '' }), DEFAULT_STALL_TIMEOUT_MS);
});

test('the stall timeout can be overridden or disabled with 0', () => {
  assert.equal(resolveStallTimeoutMs({ [STALL_TIMEOUT_ENV]: '90000' }), 90000);
  assert.equal(resolveStallTimeoutMs({ [STALL_TIMEOUT_ENV]: '0' }), 0);
});

test('an unusable stall timeout falls back to the default', () => {
  assert.equal(resolveStallTimeoutMs({ [STALL_TIMEOUT_ENV]: 'abc' }), DEFAULT_STALL_TIMEOUT_MS);
  assert.equal(resolveStallTimeoutMs({ [STALL_TIMEOUT_ENV]: '-5' }), DEFAULT_STALL_TIMEOUT_MS);
});

test('tool calls are tracked from the assistant request until their result arrives', () => {
  const pending = new Set();
  trackToolActivity(pending, {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'running' }, { type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }] },
  });
  assert.deepEqual([...pending], ['a', 'b']);

  trackToolActivity(pending, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } });
  assert.deepEqual([...pending], ['b']);

  trackToolActivity(pending, { type: 'system', subtype: 'status' });
  trackToolActivity(pending, null);
  assert.deepEqual([...pending], ['b']);
});
