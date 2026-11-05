import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './persistent-query-service.js';

const base = { sessionId: '', model: 'claude-sonnet-4-6', cwd: process.cwd(), permissionMode: 'default' };

test('a trusted project starts the chat runtime with project and local settings', async () => {
  const context = await __testing.buildRequestContext({ ...base, projectTrusted: true });
  assert.deepEqual(context.options.settingSources, ['user', 'project', 'local']);
});

test('an untrusted project starts the chat runtime with user settings only', async () => {
  const context = await __testing.buildRequestContext({ ...base, projectTrusted: false });
  assert.deepEqual(context.options.settingSources, ['user']);
});

test('a request without a trust flag is treated as untrusted', async () => {
  const context = await __testing.buildRequestContext({ ...base });
  assert.deepEqual(context.options.settingSources, ['user']);
});

test('a change of project trust rebuilds the runtime instead of reusing it', async () => {
  const trusted = await __testing.buildRequestContext({ ...base, projectTrusted: true });
  const untrusted = await __testing.buildRequestContext({ ...base, projectTrusted: false });
  assert.notEqual(trusted.runtimeSignature, untrusted.runtimeSignature);
});
