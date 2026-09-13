import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGrokModelId } from './grok-utils.js';

test('normalizeGrokModelId maps sentinel values to grok-4.6', () => {
  assert.equal(normalizeGrokModelId('grok'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('Grok'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('default'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('(default)'), 'grok-4.6');
  assert.equal(normalizeGrokModelId(''), 'grok-4.6');
  assert.equal(normalizeGrokModelId('   '), 'grok-4.6');
  assert.equal(normalizeGrokModelId(null), 'grok-4.6');
  assert.equal(normalizeGrokModelId(undefined), 'grok-4.6');
  // Sentinels shared with cli-ask isDefaultModelToken must not leak through
  // as literal model ids (would split persistent runtimes / break session/new).
  assert.equal(normalizeGrokModelId('auto'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('AUTO'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('__config_default__'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('config-default'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('config_default'), 'grok-4.6');
  // Legacy default id upgrades to the current default.
  assert.equal(normalizeGrokModelId('grok-4.5'), 'grok-4.6');
});

test('normalizeGrokModelId passes through real model ids, trimmed', () => {
  assert.equal(normalizeGrokModelId('grok-4.6'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('  grok-3  '), 'grok-3');
  assert.equal(normalizeGrokModelId('grok-beta'), 'grok-beta');
});
