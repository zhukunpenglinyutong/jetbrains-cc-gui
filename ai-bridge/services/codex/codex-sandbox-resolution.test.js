import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveCodexSandboxCandidate,
} from './codex-sandbox-resolution.js';

test('unsaved Windows value is not evidence of full access', () => {
  // No codexSandboxMode object at all: the old getter would have returned the
  // platform default (danger-full-access on Windows); the raw read must not.
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: null,
    projectPath: 'C:/project',
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.sandbox, 'workspace-write');
  assert.equal(result.source, 'safe-default');
  assert.equal(result.explicitFullAccess, false);
});

test('empty raw object behaves like an unsaved value', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: {},
    projectPath: 'C:/project',
  });
  assert.equal(result.sandbox, 'workspace-write');
  assert.equal(result.source, 'safe-default');
});

test('explicit project value overrides a wider default', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: {
      'C:/project': 'workspace-write',
      default: 'danger-full-access',
    },
    projectPath: 'C:/project',
  });
  assert.equal(result.sandbox, 'workspace-write');
  assert.equal(result.source, 'legacy-project');
  assert.equal(result.explicitFullAccess, false);
});

test('explicit saved full access keeps its evidence', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: {
      'C:/project': 'danger-full-access',
      default: 'workspace-write',
    },
    projectPath: 'C:/project',
  });
  assert.equal(result.sandbox, 'danger-full-access');
  assert.equal(result.source, 'legacy-project');
  assert.equal(result.explicitFullAccess, true);
});

test('legacy default value is used when the project key is absent', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: { default: 'workspace-write' },
    projectPath: 'C:/other',
  });
  assert.equal(result.sandbox, 'workspace-write');
  assert.equal(result.source, 'legacy-default');
});

test('explicit read-only from a legacy source is protected from widening', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: { default: 'read-only' },
    projectPath: 'C:/project',
  });
  assert.equal(result.sandbox, 'read-only');
  assert.equal(result.explicitReadOnly, true);
});

test('current-user selection outranks persisted and native values', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: { default: 'read-only' },
    projectPath: 'C:/project',
    currentUserSelection: 'workspace-write',
    nativeEffective: { sandbox: 'danger-full-access' },
  });
  assert.equal(result.sandbox, 'workspace-write');
  assert.equal(result.source, 'current-user');
});

test('user explicitly replacing a migrated read-only records the new source', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: { default: 'read-only' },
    projectPath: 'C:/project',
    currentUserSelection: 'workspace-write',
  });
  assert.equal(result.sandbox, 'workspace-write');
  assert.equal(result.source, 'current-user');
  assert.equal(result.explicitReadOnly, false);
});

test('native effective configuration is used only when provided', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: null,
    projectPath: 'C:/project',
    nativeEffective: {
      sandbox: 'workspace-write',
      // turn/start.sandboxPolicy wire format (camelCase per the v2 schema).
      policy: { type: 'workspace-write', networkAccess: false, writableRoots: ['/fixture'] },
    },
  });
  assert.equal(result.sandbox, 'workspace-write');
  assert.equal(result.source, 'native-config');
  assert.deepEqual(result.sandboxPolicy, {
    type: 'workspace-write',
    networkAccess: false,
    writableRoots: ['/fixture'],
  });
});

test('native read-only keeps full policy and read-only protection', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: null,
    projectPath: 'C:/project',
    nativeEffective: { sandbox: 'read-only', policy: { type: 'read-only' } },
  });
  assert.equal(result.sandbox, 'read-only');
  assert.equal(result.explicitReadOnly, true);
});

test('unknown persisted value produces a migration error', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: { 'C:/project': 'yolo-sandbox' },
    projectPath: 'C:/project',
  });
  assert.equal(result.status, 'migration-error');
  assert.equal(result.sandbox, null);
  assert.match(result.migrationError, /unknown persisted sandbox value/);
});

test('unknown native mode produces a migration error', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: null,
    projectPath: 'C:/project',
    nativeEffective: { sandbox: 'full-auto' },
  });
  assert.equal(result.status, 'migration-error');
  assert.match(result.migrationError, /unknown native sandbox mode/);
});

test('unknown current-user selection produces a migration error', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: null,
    projectPath: 'C:/project',
    currentUserSelection: 'unrestricted',
  });
  assert.equal(result.status, 'migration-error');
});

test('null projectPath only consults the default key', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: { 'C:/project': 'workspace-write', default: 'read-only' },
    projectPath: null,
  });
  assert.equal(result.sandbox, 'read-only');
  assert.equal(result.source, 'legacy-default');
});

test('empty-string project value is treated as present-but-invalid', () => {
  const result = resolveCodexSandboxCandidate({
    rawSandboxConfig: { 'C:/project': '' },
    projectPath: 'C:/project',
  });
  assert.equal(result.status, 'migration-error');
  assert.match(result.migrationError, /C:\/project/);
});
