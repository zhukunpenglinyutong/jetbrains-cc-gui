import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveClaudeCommitPath } from './commit-message.js';

// ---------- resolveClaudeCommitPath (#1655) ----------

test('resolveClaudeCommitPath picks ask path for real API key auth', () => {
  for (const authType of ['api_key', 'auth_token']) {
    assert.equal(
      resolveClaudeCommitPath({ apiKey: 'sk-test', authType }),
      'ask',
      `authType=${authType} should use the Anthropic ask path`,
    );
  }
});

test('resolveClaudeCommitPath picks agent path for CLI login (subscription OAuth)', () => {
  // setupApiKey() returns apiKey: '' + authType: 'cli_login' for CLI Login mode -
  // the exact shape that used to hard-fail with "No API key configured" (#1655).
  assert.equal(
    resolveClaudeCommitPath({ apiKey: '', authType: 'cli_login' }),
    'agent',
  );
});

test('resolveClaudeCommitPath picks agent path when no key is configured at all', () => {
  assert.equal(resolveClaudeCommitPath({ apiKey: null, authType: 'unknown' }), 'agent');
  assert.equal(resolveClaudeCommitPath(null), 'agent');
});
