import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './message-sender.js';

const base = {
  workingDirectory: process.cwd(),
  permissionMode: 'default',
  sdkModelName: 'claude-sonnet-4-6',
  streamingEnabled: false,
  systemPromptAppend: '',
  preToolUseHook: async () => ({ continue: true }),
  sdkStderrLines: [],
};

test('the per-process sender loads project settings only for a trusted project', () => {
  assert.deepEqual(__testing.buildQueryOptions({ ...base, projectTrusted: true }).settingSources, ['user', 'project', 'local']);
  assert.deepEqual(__testing.buildQueryOptions({ ...base, projectTrusted: false }).settingSources, ['user']);
  assert.deepEqual(__testing.buildQueryOptions({ ...base }).settingSources, ['user']);
});
