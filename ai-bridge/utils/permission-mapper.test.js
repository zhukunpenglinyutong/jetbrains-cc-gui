import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UnifiedPermissionMode,
  ClaudePermissionMapper,
  CodexPermissionMapper,
  GeminiPermissionMapper,
  PermissionMapperFactory,
} from './permission-mapper.js';
import { VALID_APPROVAL_POLICIES, applyCodexApprovalsReviewerConfig } from '../services/codex/codex-utils.js';

// ---------- CodexPermissionMapper.toProvider (#1702: 'untrusted' retired) ----------

test('toProvider never maps any unified mode to the removed untrusted policy', () => {
  const modes = [
    UnifiedPermissionMode.DEFAULT,
    UnifiedPermissionMode.SANDBOX,
    UnifiedPermissionMode.AUTO,
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

// ---------- Provider-native auto review ----------

test('Claude mapper preserves the native auto permission mode', () => {
  assert.equal(ClaudePermissionMapper.toProvider(UnifiedPermissionMode.AUTO), 'auto');
  assert.equal(ClaudePermissionMapper.fromProvider('auto'), UnifiedPermissionMode.AUTO);
});

test('toProvider maps native auto to Codex automatic review inside workspace sandbox', () => {
  assert.deepEqual(CodexPermissionMapper.toProvider(UnifiedPermissionMode.AUTO), {
    skipGitRepoCheck: true,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
  });
  assert.equal(
    CodexPermissionMapper.fromProvider({ sandbox: 'workspace-write', approvalsReviewer: 'auto_review' }),
    UnifiedPermissionMode.AUTO,
  );
  assert.equal(
    CodexPermissionMapper.fromProvider({ sandbox: 'workspace-write', approvals_reviewer: 'auto_review' }),
    UnifiedPermissionMode.AUTO,
  );
});

test('Codex options select auto_review only for native auto mode', () => {
  const options = { config: { model_supports_reasoning_summaries: true } };
  const nativeAuto = CodexPermissionMapper.toProvider(UnifiedPermissionMode.AUTO);
  applyCodexApprovalsReviewerConfig(options, nativeAuto);

  assert.deepEqual(options.config, {
    model_supports_reasoning_summaries: true,
    approvals_reviewer: 'auto_review',
  });

  const fullAutoOptions = { config: { model_supports_reasoning_summaries: true } };
  applyCodexApprovalsReviewerConfig(
    fullAutoOptions,
    CodexPermissionMapper.toProvider('bypassPermissions'),
  );
  assert.deepEqual(fullAutoOptions.config, {
    model_supports_reasoning_summaries: true,
    approvals_reviewer: 'user',
  });

  const defaultOptions = {};
  applyCodexApprovalsReviewerConfig(defaultOptions, CodexPermissionMapper.toProvider('default'));
  assert.deepEqual(defaultOptions.config, { approvals_reviewer: 'user' });
});

test('toProvider keeps yolo / acceptEdits mappings unchanged', () => {
  assert.equal(CodexPermissionMapper.toProvider(UnifiedPermissionMode.YOLO).approvalPolicy, 'never');
  assert.equal(CodexPermissionMapper.toProvider('bypassPermissions').approvalPolicy, 'never');
  assert.equal(CodexPermissionMapper.toProvider('acceptEdits').approvalPolicy, 'on-request');
  assert.equal(CodexPermissionMapper.toProvider('autoEdit').approvalPolicy, 'on-request');
});

// ---------- GeminiPermissionMapper ----------

const GEMINI_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'sandbox'];

test('factory returns the real mapper for gemini (no stub throw)', () => {
  assert.equal(PermissionMapperFactory.getMapper('gemini'), GeminiPermissionMapper);
  assert.equal(typeof GeminiPermissionMapper.toProvider, 'function');
  assert.equal(typeof GeminiPermissionMapper.fromProvider, 'function');
});

test('toProvider maps each unified mode to the live-verified agy flags', () => {
  assert.deepEqual(GeminiPermissionMapper.toProvider('default'), { args: [] });
  assert.deepEqual(GeminiPermissionMapper.toProvider('plan'), { args: ['--mode', 'plan'] });
  assert.deepEqual(GeminiPermissionMapper.toProvider('acceptEdits'), { args: ['--mode', 'accept-edits'] });
  assert.deepEqual(GeminiPermissionMapper.toProvider('bypassPermissions'), { args: ['--dangerously-skip-permissions'] });
  assert.deepEqual(GeminiPermissionMapper.toProvider('sandbox'), { args: ['--sandbox'] });
});

test('toProvider falls back to no flags (never throws) for unknown/blank/non-string modes', () => {
  for (const mode of [undefined, null, '', '   ', 'smol', 'slow', 'autoEdit', 'yolo', '--evil', 'request-review', 42, {}]) {
    assert.deepEqual(GeminiPermissionMapper.toProvider(mode), { args: [] }, `mode=${String(mode)}`);
  }
});

test('toProvider tolerates case variants of the canonical ids', () => {
  assert.deepEqual(GeminiPermissionMapper.toProvider('PLAN').args, ['--mode', 'plan']);
  assert.deepEqual(GeminiPermissionMapper.toProvider('AcceptEdits').args, ['--mode', 'accept-edits']);
  assert.deepEqual(GeminiPermissionMapper.toProvider('BypassPermissions').args, ['--dangerously-skip-permissions']);
  assert.deepEqual(GeminiPermissionMapper.toProvider(' Sandbox ').args, ['--sandbox']);
});

test('fromProvider inverts toProvider for every mode', () => {
  for (const mode of GEMINI_MODES) {
    const { args } = GeminiPermissionMapper.toProvider(mode);
    assert.equal(GeminiPermissionMapper.fromProvider(args), mode, `round-trip via [${args.join(' ')}]`);
  }
});

test('fromProvider accepts an {args} wrapper as well as a bare array', () => {
  assert.equal(GeminiPermissionMapper.fromProvider({ args: ['--sandbox'] }), 'sandbox');
});

test('fromProvider defaults malformed or unrecognized input', () => {
  assert.equal(GeminiPermissionMapper.fromProvider(undefined), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider(null), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider([]), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider(['-p', 'hi', '--model', 'x']), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider(['--mode', 'bogus']), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider({ args: 'not-an-array' }), 'default');
});

// ---------- VALID_APPROVAL_POLICIES whitelist ----------

test('VALID_APPROVAL_POLICIES no longer accepts the removed untrusted value', () => {
  assert.equal(VALID_APPROVAL_POLICIES.has('untrusted'), false);
  assert.equal(VALID_APPROVAL_POLICIES.has('on-request'), true);
  assert.equal(VALID_APPROVAL_POLICIES.has('never'), true);
  assert.equal(VALID_APPROVAL_POLICIES.has('on-failure'), true);
});
