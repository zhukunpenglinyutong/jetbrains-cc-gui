import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveActiveProvider,
  providerModels,
  buildZcodeCredentialEnv,
  buildRuntimeModel,
} from './zcode-config.js';

const CONFIG = {
  provider: {
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      name: 'BigModel - Coding Plan',
      enabled: true,
      options: { baseURL: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'k-plan' },
      models: {
        'GLM-5.3': { name: 'GLM-5.3', limit: { context: 1000000, output: 128000 }, modalities: { input: ['text'] } },
        'GLM-5-Turbo': { name: 'glm-5-turbo', limit: { context: 200000, output: 128000 } },
      },
    },
    'builtin:zai': {
      kind: 'anthropic',
      enabled: false,
      options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: '' },
      models: { 'GLM-5.3': {} },
    },
  },
};

const SETTINGS = {
  providerFamilyDomain: 'bigmodel',
  modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:bigmodel-coding-plan' },
};

test('active provider follows the family-selected key', () => {
  const active = resolveActiveProvider(CONFIG, SETTINGS);
  assert.equal(active.providerId, 'builtin:bigmodel-coding-plan');
  assert.equal(active.apiKey, 'k-plan');
  assert.equal(active.baseURL, 'https://open.bigmodel.cn/api/anthropic');
});

test('disabled selected provider falls back to first enabled with key', () => {
  const config = structuredClone(CONFIG);
  config.provider['builtin:bigmodel-coding-plan'].enabled = false;
  config.provider['builtin:zai'].enabled = true;
  config.provider['builtin:zai'].options.apiKey = 'k-zai';
  const active = resolveActiveProvider(config, SETTINGS);
  assert.equal(active.providerId, 'builtin:zai');
  assert.equal(active.apiKey, 'k-zai');
});

test('oauth-only provider (no key) yields no credential env', () => {
  const config = structuredClone(CONFIG);
  config.provider['builtin:bigmodel-coding-plan'].options.apiKey = '';
  const active = resolveActiveProvider(config, SETTINGS);
  // selected provider has no key; fallback loop also finds none with a key
  assert.equal(buildZcodeCredentialEnv(active).ANTHROPIC_API_KEY, undefined);
});

test('credential env carries model/base/key when a key exists', () => {
  const env = buildZcodeCredentialEnv(resolveActiveProvider(CONFIG, SETTINGS));
  assert.equal(env.ZCODE_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(env.ANTHROPIC_API_KEY, 'k-plan');
  assert.equal(env.ZCODE_MODEL, 'GLM-5.3');
});

test('providerModels maps limit/modalities', () => {
  const active = resolveActiveProvider(CONFIG, SETTINGS);
  const models = providerModels(active);
  assert.equal(models.length, 2);
  const glm = models.find((m) => m.id === 'GLM-5.3');
  assert.equal(glm.contextWindow, 1000000);
  assert.equal(glm.supportsImages, false);
});

test('no config yields null active provider', () => {
  assert.equal(resolveActiveProvider(null, null), null);
});

test('runtimeModel carries the full provider definition', () => {
  const active = resolveActiveProvider(CONFIG, SETTINGS);
  const rt = buildRuntimeModel('GLM-5-Turbo', active);
  assert.equal(rt.model.providerId, 'builtin:bigmodel-coding-plan');
  assert.equal(rt.model.modelId, 'GLM-5-Turbo');
  assert.equal(rt.provider.kind, 'anthropic');
  assert.equal(rt.provider.source, 'builtin');
  assert.equal(rt.provider.baseURL, 'https://open.bigmodel.cn/api/anthropic');
  assert.deepEqual(rt.provider.apiKey, { source: 'inline', value: 'k-plan' });
  // every model of the provider embedded with limits (context window must not zero out)
  const turbo = rt.provider.models.find((m) => m.modelId === 'GLM-5-Turbo');
  assert.equal(turbo.contextWindow, 200000);
  assert.equal(rt.provider.models.length, 2);
});

test('runtimeModel source is custom for non-builtin providers', () => {
  const active = { providerId: 'thirdparty:abc', name: 'X', baseURL: 'https://x', apiKey: 'k', models: { M1: {} } };
  const rt = buildRuntimeModel('M1', active);
  assert.equal(rt.provider.source, 'custom');
});

test('runtimeModel is null without provider or model', () => {
  assert.equal(buildRuntimeModel('GLM-5.3', null), null);
  const active = resolveActiveProvider(CONFIG, SETTINGS);
  assert.equal(buildRuntimeModel('', active), null);
  assert.equal(buildRuntimeModel('GLM-5.3', { ...active, models: {} }), null);
});
