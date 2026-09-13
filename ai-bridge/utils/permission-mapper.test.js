import test from 'node:test';
import assert from 'node:assert/strict';

import { UnifiedPermissionMode, CodexPermissionMapper } from './permission-mapper.js';
import { VALID_APPROVAL_POLICIES } from '../services/codex/codex-utils.js';

// ---------- CodexPermissionMapper.toProvider (#1702: 'untrusted' retired) ----------

test('toProvider never maps any unified mode to the removed untrusted policy', () => {
  const modes = [
    UnifiedPermissionMode.DEFAULT,
    UnifiedPermissionMode.SANDBOX,
    UnifiedPermissionMode.YOLO,
    'bypassPermissions',
    'acceptEdits',
    'autoEdit',
    'plan',
    'unknown-mode',
    null,
    undefined,
  ];

  for (const mode of modes) {
    const config = CodexPermissionMapper.toProvider(mode);
    assert.ok(
      config.approvalPolicy !== 'untrusted',
      `mode=${mode} must not map to the removed 'untrusted' policy (got: ${config.approvalPolicy})`,
    );
    assert.ok(
      VALID_APPROVAL_POLICIES.has(config.approvalPolicy),
      `mode=${mode} approvalPolicy ${config.approvalPolicy} must be in VALID_APPROVAL_POLICIES`,
    );
  }
});

test('toProvider maps default and sandbox to on-request (untrusted semantics successor)', () => {
  // Codex CLI v0.149 removed 'untrusted'; its ask-before-run semantics now live in
  // 'on-request'. Older CLI versions support 'on-request' as well, so it is safe
  // for both (#1702).
  assert.equal(CodexPermissionMapper.toProvider(UnifiedPermissionMode.DEFAULT).approvalPolicy, 'on-request');
  assert.equal(CodexPermissionMapper.toProvider(UnifiedPermissionMode.SANDBOX).approvalPolicy, 'on-request');
  assert.equal(CodexPermissionMapper.toProvider('plan').approvalPolicy, 'on-request');
});

test('toProvider keeps yolo / acceptEdits mappings unchanged', () => {
  assert.equal(CodexPermissionMapper.toProvider(UnifiedPermissionMode.YOLO).approvalPolicy, 'never');
  assert.equal(CodexPermissionMapper.toProvider('bypassPermissions').approvalPolicy, 'never');
  assert.equal(CodexPermissionMapper.toProvider('acceptEdits').approvalPolicy, 'on-request');
  assert.equal(CodexPermissionMapper.toProvider('autoEdit').approvalPolicy, 'on-request');
});

// ---------- VALID_APPROVAL_POLICIES whitelist ----------

test('VALID_APPROVAL_POLICIES no longer accepts the removed untrusted value', () => {
  assert.equal(VALID_APPROVAL_POLICIES.has('untrusted'), false);
  assert.equal(VALID_APPROVAL_POLICIES.has('on-request'), true);
  assert.equal(VALID_APPROVAL_POLICIES.has('never'), true);
  assert.equal(VALID_APPROVAL_POLICIES.has('on-failure'), true);
});
