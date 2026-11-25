import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRewindQueryOptions } from './message-rewind.js';

test('rewind never loads project or local settings', () => {
  const options = buildRewindQueryOptions('session-1', process.cwd());
  assert.deepEqual(options.settingSources, ['user']);
  assert.equal(options.strictMcpConfig, true);
});

test('rewind starts a Windows .cmd launcher through its own spawner', { skip: process.platform !== 'win32' }, () => {
  const previous = process.env.CLAUDE_CODE_PATH;
  try {
    process.env.CLAUDE_CODE_PATH = 'C:\\tools\\work.cmd';
    const options = buildRewindQueryOptions('session-1', process.cwd());
    assert.equal(options.pathToClaudeCodeExecutable, 'C:\\tools\\work.cmd');
    assert.equal(typeof options.spawnClaudeCodeProcess, 'function');
    process.env.CLAUDE_CODE_PATH = 'C:\\tools\\claude.exe';
    assert.equal('spawnClaudeCodeProcess' in buildRewindQueryOptions('session-1', process.cwd()), false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_PATH;
    else process.env.CLAUDE_CODE_PATH = previous;
  }
});

test('rewind keeps resuming the session with file checkpointing and no tools', async () => {
  const options = buildRewindQueryOptions('session-1', process.cwd());
  assert.equal(options.resume, 'session-1');
  assert.equal(options.enableFileCheckpointing, true);
  assert.equal(options.maxTurns, 1);
  assert.equal((await options.canUseTool('Bash', {})).behavior, 'deny');
});
