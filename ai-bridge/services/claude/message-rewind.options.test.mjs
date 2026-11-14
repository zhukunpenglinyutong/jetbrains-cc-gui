import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRewindQueryOptions } from './message-rewind.js';

test('rewind never loads project or local settings', () => {
  const options = buildRewindQueryOptions('session-1', process.cwd());
  assert.deepEqual(options.settingSources, ['user']);
  assert.equal(options.strictMcpConfig, true);
});

test('rewind keeps resuming the session with file checkpointing and no tools', async () => {
  const options = buildRewindQueryOptions('session-1', process.cwd());
  assert.equal(options.resume, 'session-1');
  assert.equal(options.enableFileCheckpointing, true);
  assert.equal(options.maxTurns, 1);
  assert.equal((await options.canUseTool('Bash', {})).behavior, 'deny');
});
