import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveZcodePickerModels,
  ZCODE_STATIC_FALLBACK_MODELS,
} from './models-service.js';

test('models come from the active provider entry', () => {
  const { models, defaultModel } = resolveZcodePickerModels({
    config: {
      provider: {
        'builtin:bigmodel-coding-plan': {
          kind: 'anthropic',
          name: 'BigModel',
          enabled: true,
          options: { baseURL: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'k' },
          models: { 'GLM-5.3': { name: 'GLM-5.3' }, 'GLM-5-Turbo': {} },
        },
      },
    },
    settings: {
      providerFamilyDomain: 'bigmodel',
      modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:bigmodel-coding-plan' },
    },
  });
  assert.deepEqual(models.map((m) => m.id), ['GLM-5.3', 'GLM-5-Turbo']);
  assert.equal(defaultModel, 'GLM-5.3');
});

test('missing config falls back to the static list', () => {
  const { models, defaultModel } = resolveZcodePickerModels({ config: null, settings: null });
  assert.deepEqual(models, ZCODE_STATIC_FALLBACK_MODELS);
  assert.equal(defaultModel, ZCODE_STATIC_FALLBACK_MODELS[0].id);
});
