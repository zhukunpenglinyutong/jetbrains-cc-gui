import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureOpenCodePath, normalizeOpenCodeSdkError } from './opencode-utils.js';
import { isOpenCodeRuntimeTransportError } from './message-service.js';

test('opencode path discovery prepends user-managed install directory', () => {
  const originalPath = process.env.PATH;
  const delimiter = process.platform === 'win32' ? ';' : ':';

  try {
    process.env.PATH = ['/usr/bin', '/bin'].join(delimiter);

    const nextPath = ensureOpenCodePath();
    const entries = nextPath.split(delimiter);

    assert.equal(entries[0], `${process.env.HOME}/.opencode/bin`);
    assert.equal(entries.includes('/usr/bin'), true);
    assert.equal(entries.includes('/bin'), true);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('opencode path discovery does not duplicate existing entries', () => {
  const originalPath = process.env.PATH;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const userOpencodeBin = `${process.env.HOME}/.opencode/bin`;

  try {
    process.env.PATH = [userOpencodeBin, '/usr/bin'].join(delimiter);

    const nextPath = ensureOpenCodePath();
    const entries = nextPath.split(delimiter);

    assert.equal(entries.filter((entry) => entry === userOpencodeBin).length, 1);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('normalizes opencode fetch failures as server connectivity errors', () => {
  const normalized = normalizeOpenCodeSdkError(new Error('fetch failed'));

  assert.equal(normalized.code, 'OPENCODE_SERVER_UNREACHABLE');
  assert.match(normalized.error, /opencode server request failed/);
});

test('detects transport failures that should discard persistent runtimes', () => {
  assert.equal(isOpenCodeRuntimeTransportError(new Error('fetch failed')), true);
  assert.equal(isOpenCodeRuntimeTransportError(new Error('ECONNRESET')), true);
  assert.equal(isOpenCodeRuntimeTransportError(new Error('Input exceeds context window of this model')), false);
});
