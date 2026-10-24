import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnSettings } from './persistent-codex-service.js';

test('Full Auto retains its native access when no independent scope has been selected', () => {
  const settings = buildTurnSettings({ permissionMode: 'bypassPermissions', sandboxSource: 'default' });
  assert.equal(settings.sandbox, 'danger-full-access');
  assert.equal(settings.approvalPolicy, 'never');
});

test('legacy Java project records cannot override the current chat access scope', () => {
  const settings = buildTurnSettings({ permissionMode: 'default', sandboxSource: 'default',
    sandboxSelection: 'read-only', rawSandboxConfig: { default: 'danger-full-access' } });
  assert.equal(settings.sandbox, 'read-only');
  assert.equal(settings.approvalPolicy, 'on-request');
});

test('explicit read-only access survives Full Auto mode mapping', () => {
  const settings = buildTurnSettings({ permissionMode: 'bypassPermissions', approvalPreset: 'request',
    sandboxSelection: 'read-only', sandboxSource: 'user' });
  assert.equal(settings.sandbox, 'read-only');
  assert.equal(settings.approvalPolicy, 'on-request');
});

test('missing legacy Java records cannot downgrade a restored Full Auto mode', () => {
  const settings = buildTurnSettings({ permissionMode: 'bypassPermissions', sandboxSource: 'default', rawSandboxConfig: null });
  assert.equal(settings.sandbox, 'danger-full-access');
});
