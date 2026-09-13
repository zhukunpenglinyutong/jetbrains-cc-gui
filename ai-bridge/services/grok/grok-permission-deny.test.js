import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDenyAllMode,
  resolveAcpPermissionDecision,
} from './grok-acp-client.js';

test('isDenyAllMode recognises deny variants only', () => {
  assert.equal(isDenyAllMode('deny'), true);
  assert.equal(isDenyAllMode('deny-all'), true);
  assert.equal(isDenyAllMode('denyall'), true);
  assert.equal(isDenyAllMode('never'), true);
  assert.equal(isDenyAllMode('DENY'), true);
  assert.equal(isDenyAllMode('bypassPermissions'), false);
  assert.equal(isDenyAllMode('default'), false);
  assert.equal(isDenyAllMode(''), false);
  assert.equal(isDenyAllMode(undefined), false);
});

test('resolveAcpPermissionDecision denies tools in deny mode without asking', async () => {
  const decision = await resolveAcpPermissionDecision(
    {
      toolCall: {
        title: 'run_terminal_command',
        kind: 'execute',
        rawInput: { command: 'rm -rf /tmp/x' },
      },
      options: [
        { optionId: 'allow-once' },
        { optionId: 'reject-once' },
      ],
    },
    'deny',
    { requestPermission: () => assert.fail('must not ask Java in deny mode') }
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.source, 'deny-all');
  assert.equal(decision.optionId, 'reject-once');
  assert.deepEqual(decision.response, {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
});

test('resolveAcpPermissionDecision falls back to cancelled when no reject option', async () => {
  const decision = await resolveAcpPermissionDecision(
    { toolCall: { title: 'write', kind: 'edit' }, options: [{ optionId: 'allow' }] },
    'deny',
    { requestPermission: () => assert.fail('must not ask Java in deny mode') }
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.optionId, null);
  assert.deepEqual(decision.response, { outcome: { outcome: 'cancelled' } });
});
