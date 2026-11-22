import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GeminiPermissionMapper } from './permission-mapper.js';

const GEMINI_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'sandbox'];

test('Story 006 AC-1: ai-bridge/utils/permission-mapper.js and .test.js are deleted and GeminiPermissionMapper is in services/gemini', async () => {
  const oldPath = fileURLToPath(new URL('../../utils/permission-mapper.js', import.meta.url));
  const oldTestPath = fileURLToPath(new URL('../../utils/permission-mapper.test.js', import.meta.url));
  const newPath = fileURLToPath(new URL('./permission-mapper.js', import.meta.url));

  assert.equal(existsSync(oldPath), false, 'ai-bridge/utils/permission-mapper.js must be deleted');
  assert.equal(existsSync(oldTestPath), false, 'ai-bridge/utils/permission-mapper.test.js must be deleted');
  assert.equal(existsSync(newPath), true, 'ai-bridge/services/gemini/permission-mapper.js must exist');

  const mod = await import('./permission-mapper.js');
  assert.ok(typeof mod.GeminiPermissionMapper === 'function', 'GeminiPermissionMapper must be exported');
  assert.equal('ClaudePermissionMapper' in mod, false, 'ClaudePermissionMapper must not be exported');
  assert.equal('CodexPermissionMapper' in mod, false, 'CodexPermissionMapper must not be exported');
});

test('Story 006 AC-1: GeminiPermissionMapper maps unified modes to agy flags and back without Claude or Codex mappers', async () => {
  const { GeminiPermissionMapper: Mapper } = await import('./permission-mapper.js');

  // toProvider
  assert.deepEqual(Mapper.toProvider('plan'), { args: ['--mode', 'plan'] });
  assert.deepEqual(Mapper.toProvider('acceptEdits'), { args: ['--mode', 'accept-edits'] });
  assert.deepEqual(Mapper.toProvider('bypassPermissions'), { args: ['--dangerously-skip-permissions'] });
  assert.deepEqual(Mapper.toProvider('sandbox'), { args: ['--sandbox'] });
  assert.deepEqual(Mapper.toProvider('default'), { args: [] });
  assert.deepEqual(Mapper.toProvider('unknown'), { args: [] });
  assert.deepEqual(Mapper.toProvider(null), { args: [] });

  // fromProvider
  assert.equal(Mapper.fromProvider(['--dangerously-skip-permissions']), 'bypassPermissions');
  assert.equal(Mapper.fromProvider(['--sandbox']), 'sandbox');
  assert.equal(Mapper.fromProvider(['--mode', 'plan']), 'plan');
  assert.equal(Mapper.fromProvider(['--mode', 'accept-edits']), 'acceptEdits');
  assert.equal(Mapper.fromProvider([]), 'default');
  assert.equal(Mapper.fromProvider({ args: ['--dangerously-skip-permissions'] }), 'bypassPermissions');
  assert.equal(Mapper.fromProvider({ args: ['--sandbox'] }), 'sandbox');
  assert.equal(Mapper.fromProvider({ args: ['--mode', 'plan'] }), 'plan');
  assert.equal(Mapper.fromProvider({ args: ['--mode', 'accept-edits'] }), 'acceptEdits');
  assert.equal(Mapper.fromProvider({ args: [] }), 'default');
  assert.equal(Mapper.fromProvider(null), 'default');
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

test('fromProvider defaults malformed or unrecognized input', () => {
  assert.equal(GeminiPermissionMapper.fromProvider(undefined), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider(null), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider([]), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider(['-p', 'hi', '--model', 'x']), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider(['--mode', 'bogus']), 'default');
  assert.equal(GeminiPermissionMapper.fromProvider({ args: 'not-an-array' }), 'default');
});
