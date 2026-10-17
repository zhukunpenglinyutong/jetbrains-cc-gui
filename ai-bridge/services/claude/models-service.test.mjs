import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeModelPicker, parseClaudeModelMapping } from './models-service.js';

test('route mode reads display names separately from client-side model aliases without a picker', () => {
  const settings = { env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5[1M]', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'GLM Flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5[1M]', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'GLM Pro',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5[1M]', ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'GLM Pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5', ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'GLM Flash',
    ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'http://example.test',
  } };
  assert.deepEqual(parseClaudeModelPicker(settings).models, []);
  assert.deepEqual(parseClaudeModelMapping(settings), {
    sonnet: 'claude-sonnet-5[1M]', sonnetName: 'GLM Flash',
    opus: 'claude-opus-5[1M]', opusName: 'GLM Pro',
    fable: 'claude-fable-5[1M]', fableName: 'GLM Pro',
    haiku: 'claude-haiku-4-5', haikuName: 'GLM Flash',
  });
});

test('direct mode reads upstream ids and optional names; missing settings clear the mapping', () => {
  assert.deepEqual(parseClaudeModelMapping({ env: {
    ANTHROPIC_MODEL: ' glm-pro ', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: ' Fast model ',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 123, ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: ' ',
  } }), { main: 'glm-pro', sonnet: 'glm-flash', sonnetName: 'Fast model' });
  assert.deepEqual(parseClaudeModelMapping(null), {});
  assert.deepEqual(parseClaudeModelMapping({ env: {} }), {});
});

test('reads cc-switch routes, labels, descriptions and the configured default', () => {
  const result = parseClaudeModelPicker({
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccs-claude-provider-b--glm-5.3[1M]', ANTHROPIC_AUTH_TOKEN: 'secret' },
    modelPicker: {
      replaceBuiltInOptions: true,
      options: [
        { model: 'ccs-claude-provider-a--grok-4.7[1M]', label: 'grok-4.7（供应商 A）', description: 'grok-4.7 · 1M' },
        { model: 'ccs-claude-provider-b--glm-5.3[1M]', label: 'glm-5.3（供应商 B）', description: 'glm-5.3 · 1M' },
        { model: 'ccs-claude-provider-b--glm-5.3-flash[1M]', label: 'glm-5.3-flash（供应商 B）' },
      ],
    },
  });
  assert.equal(result.replaceBuiltInOptions, true);
  assert.equal(result.defaultModel, 'ccs-claude-provider-b--glm-5.3');
  assert.deepEqual(result.models[0], { id: 'ccs-claude-provider-a--grok-4.7', label: 'grok-4.7（供应商 A）', description: 'grok-4.7 · 1M', supports1MContext: true });
  assert.equal(result.models.length, 3);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('keeps different provider routes for the same upstream, dedupes context variants', () => {
  const result = parseClaudeModelPicker({ modelPicker: { options: [
    null, {}, { model: 123 }, { model: ' ' },
    { model: ' ccs-claude-a--opus[1M] ', label: 'A' },
    { model: 'ccs-claude-a--opus', label: 'duplicate' },
    { model: 'ccs-claude-b--opus', label: '' },
  ] } });
  assert.deepEqual(result.models, [
    { id: 'ccs-claude-a--opus', label: 'A', supports1MContext: true },
    { id: 'ccs-claude-b--opus', label: 'ccs-claude-b--opus', supports1MContext: false },
  ]);
  assert.equal(result.replaceBuiltInOptions, false);
});

test('missing or malformed picker keeps built-ins; explicit empty replacement is honored', () => {
  for (const settings of [null, {}, { modelPicker: { replaceBuiltInOptions: true, options: {} } }]) {
    assert.deepEqual(parseClaudeModelPicker(settings), { models: [], replaceBuiltInOptions: false, defaultModel: null });
  }
  assert.deepEqual(parseClaudeModelPicker({ modelPicker: { replaceBuiltInOptions: true, options: [] } }),
    { models: [], replaceBuiltInOptions: true, defaultModel: null });
});

test('preserves explicit context capability independently of model and provider names', () => {
  const models = parseClaudeModelPicker({ modelPicker: { options: [
    { model: 'ccs-claude-a--glm-flash' },
    { model: 'ccs-claude-haiku-provider--glm-pro[1m]' },
    { model: 'ccs-claude-b--gemini[1M]' },
  ] } }).models;
  assert.deepEqual(models.map(m => m.supports1MContext), [false, true, true]);
  assert.ok(models.every(m => !/\[1m\]$/i.test(m.id)));
});
