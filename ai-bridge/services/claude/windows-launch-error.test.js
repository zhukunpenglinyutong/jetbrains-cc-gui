import test from 'node:test';
import assert from 'node:assert/strict';
import { describeClaudeLaunchFailure } from './windows-launch-error.js';
import { __testing } from './persistent-query-service.js';

test('exit code 3221225785 (0xC0000139) on Windows is explained as a missing system API', () => {
  const hint = describeClaudeLaunchFailure('Claude Code process exited with code 3221225785', 'win32');

  assert.match(hint, /0xC0000139/);
  assert.match(hint, /Windows 10/);
  assert.match(hint, /1809/);
  assert.match(hint, /0\.1\.x/);
  assert.match(hint, /Claude Code 2\.0\.x/);
});

test('the same status reported as a signed 32-bit exit code is explained too', () => {
  assert.ok(describeClaudeLaunchFailure('Claude Code process exited with code -1073741511', 'win32'));
});

test('other exit codes are not explained', () => {
  assert.equal(describeClaudeLaunchFailure('Claude Code process exited with code 1', 'win32'), null);
  assert.equal(describeClaudeLaunchFailure('Claude Code process exited with code 3221225786', 'win32'), null);
  assert.equal(describeClaudeLaunchFailure('Request timed out', 'win32'), null);
  assert.equal(describeClaudeLaunchFailure(undefined, 'win32'), null);
});

test('the explanation is only given on Windows', () => {
  assert.equal(describeClaudeLaunchFailure('Claude Code process exited with code 3221225785', 'linux'), null);
});

test('a send error for that exit code carries the explanation and the original message', () => {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = () => {};
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    __testing.emitSendError(null, new Error('Claude Code process exited with code 3221225785'), null);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    console.log = originalLog;
    console.error = originalError;
  }

  const line = lines.find((entry) => entry.startsWith('[SEND_ERROR]'));
  const payload = JSON.parse(line.slice('[SEND_ERROR]'.length).trim());
  assert.match(payload.error, /0xC0000139/);
  assert.match(payload.error, /exited with code 3221225785/);
});
