import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEND_ERROR_LENGTH, prependSdkStderr } from './message-output-filter.js';
import { __testing as senderTesting } from './message-sender.js';
import { __testing } from './persistent-query-service.js';

const EXIT_MESSAGE = 'Claude Code process exited with code 3221225785';
const TRUNCATED_MARKER = '[earlier stderr truncated]';

function captureSendError(channel, emit) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = channel === 'log' ? (...args) => lines.push(args.join(' ')) : () => {};
  console.error = channel === 'error' ? (...args) => lines.push(args.join(' ')) : () => {};
  try {
    emit();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const line = lines.find((entry) => entry.startsWith('[SEND_ERROR]'));
  return JSON.parse(line.slice('[SEND_ERROR]'.length).trim());
}

function emitPersistent(runtime, error) {
  return captureSendError('log', () => __testing.emitSendError(runtime, error, null));
}

test('a send error carries the SDK message unchanged for the diagnostic card to match', () => {
  assert.equal(emitPersistent(null, new Error(EXIT_MESSAGE)).error, EXIT_MESSAGE);
});

test('stderr that does not fit gives way to the SDK message', () => {
  const stderr = `oldest-${'x'.repeat(3000)}-recent`;

  const payload = emitPersistent({ stderrLines: [stderr] }, new Error(EXIT_MESSAGE));

  assert.ok(payload.error.endsWith(EXIT_MESSAGE), 'the SDK message survives');
  assert.equal(payload.error.length, MAX_SEND_ERROR_LENGTH);
  assert.ok(payload.error.includes(TRUNCATED_MARKER));
  assert.match(payload.error, /-recent/);
  assert.doesNotMatch(payload.error, /oldest-/);
  assert.equal(payload.details.sdkError, stderr);
});

test('the per-process path keeps the SDK message and redacts stderr too', () => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const stderr = `${'x'.repeat(3000)} ${secret}`;

  const payload = captureSendError('error', () => {
    senderTesting.handleSendError(new Error(EXIT_MESSAGE), { streamingEnabled: false }, [stderr]);
  });

  assert.ok(payload.error.includes(EXIT_MESSAGE), 'the SDK message survives');
  assert.ok(payload.error.includes(TRUNCATED_MARKER));
  assert.ok(payload.error.length <= MAX_SEND_ERROR_LENGTH);
  assert.ok(!payload.error.includes(secret), 'the payload text is redacted');
  assert.ok(!payload.details.sdkError.includes(secret), 'the details are redacted');
});

test('stderr that fits is kept whole in front of the message', () => {
  assert.equal(prependSdkStderr('boom', 'line one\nline two'), 'SDK-STDERR:\n```\nline one\nline two\n```\n\nboom');
});

test('a message that leaves no room for stderr is returned alone', () => {
  const message = `${EXIT_MESSAGE} ${'y'.repeat(MAX_SEND_ERROR_LENGTH - EXIT_MESSAGE.length - 11)}`;

  assert.equal(prependSdkStderr(message, 'x'.repeat(40)), message);
});
