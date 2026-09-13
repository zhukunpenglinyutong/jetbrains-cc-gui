import test from 'node:test';
import assert from 'node:assert/strict';

import { extractResultError, isRetryableError } from './message-utils.js';

// Regression guard for the "API request failed" masking bug: the Claude Agent
// SDK reports the real error text in the `errors` array (or in `result` when
// subtype is "success"), never in a generic message. These cases pin down the
// exact precedence so a real failure can no longer be silently dropped.

test('extractResultError: reads the errors array for a normal error result', () => {
  const msg = {
    type: 'result',
    is_error: true,
    subtype: 'error',
    errors: ['rate_limit_error: 429 Too Many Requests', 'Retry after 60s'],
    result: 'ignored generic text',
  };
  assert.equal(extractResultError(msg), 'rate_limit_error: 429 Too Many Requests; Retry after 60s');
});

test('extractResultError: trims and drops blank entries from the errors array', () => {
  const msg = { type: 'result', is_error: true, subtype: 'error', errors: ['  auth failed  ', '', '  '] };
  assert.equal(extractResultError(msg), 'auth failed');
});

test('extractResultError: falls back when the errors array is entirely blank', () => {
  const msg = { type: 'result', is_error: true, subtype: 'error', errors: ['', '   '] };
  assert.equal(extractResultError(msg), 'API request failed');
});

test('extractResultError: prefers `result` when subtype is "success" (SDK precedence)', () => {
  const msg = {
    type: 'result',
    is_error: true,
    subtype: 'success',
    errors: ['must-not-win'],
    result: 'the real message',
  };
  assert.equal(extractResultError(msg), 'the real message');
});

test('extractResultError: falls back to `result` then `message` when no errors array', () => {
  assert.equal(extractResultError({ type: 'result', is_error: true, result: 'from result' }), 'from result');
  assert.equal(extractResultError({ type: 'result', is_error: true, message: 'from message' }), 'from message');
});

test('extractResultError: falls back to the generic text for an empty message', () => {
  assert.equal(extractResultError({ type: 'result', is_error: true }), 'API request failed');
  assert.equal(extractResultError(null), 'API request failed');
  assert.equal(extractResultError(undefined), 'API request failed');
});

test('isRetryableError recognizes retryable SDK errors after detailed extraction', () => {
  const rateLimitError = new Error(extractResultError({
    subtype: 'error_during_execution',
    errors: ['rate_limit_error: 429 Too Many Requests'],
  }));
  const overloadedError = new Error(extractResultError({
    subtype: 'error_during_execution',
    errors: ['overloaded_error: service temporarily unavailable'],
  }));

  assert.equal(isRetryableError(rateLimitError), true);
  assert.equal(isRetryableError(overloadedError), true);
});
