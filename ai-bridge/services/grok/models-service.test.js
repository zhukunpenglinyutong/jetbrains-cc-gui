import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelsCacheJson,
  parseGrokProfilesFromToml,
  resolveGrokPickerModels,
  GROK_STATIC_FALLBACK_MODELS,
} from './models-service.js';

test('parseModelsCacheJson extracts models from models_cache.json payload', () => {
  const json = JSON.stringify({
    fetched_at: '2026-08-09T12:04:19Z',
    models: {
      'grok-4.6': {
        info: {
          id: 'grok-4.6',
          name: 'Grok 4.6',
          description: "SpaceXAI's new frontier model",
        },
      },
      'grok-3': {
        info: {
          id: 'grok-3',
          name: 'Grok 3',
          description: 'Grok 3 reasoning model',
          hidden: false,
        },
      },
      'hidden-model': {
        info: {
          id: 'hidden-model',
          name: 'Hidden Model',
          hidden: true,
        },
      },
    },
  });

  const { models, seen } = parseModelsCacheJson(json);
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], { id: 'grok-4.6', label: 'Grok 4.6', description: "SpaceXAI's new frontier model" });
  assert.deepEqual(models[1], { id: 'grok-3', label: 'Grok 3', description: 'Grok 3 reasoning model' });
  assert.ok(seen.has('grok-4.6'));
  assert.ok(seen.has('grok-3'));
});

test('parseModelsCacheJson skips scalar metadata keys in root-map layout', () => {
  const json = JSON.stringify({
    fetched_at: '2026-08-09T12:04:19Z',
    'grok-4.6': {
      id: 'grok-4.6',
      name: 'Grok 4.6',
    },
  });

  const { models } = parseModelsCacheJson(json);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], { id: 'grok-4.6', label: 'Grok 4.6', description: 'grok-4.6' });
});

test('parseGrokProfilesFromToml extracts custom profiles from config.toml', () => {
  const toml = `
[models]
default = "grok-custom"

[model."grok-custom"]
model = "grok-4.6"
base_url = "https://example.com/v1"
`;

  const { models, defaultModel } = parseGrokProfilesFromToml(toml);
  assert.equal(defaultModel, 'grok-custom');
  assert.equal(models.length, 1);
  // Nested model id is used as label when name is absent.
  assert.deepEqual(models[0], { id: 'grok-custom', label: 'grok-4.6', description: 'grok-4.6' });
});

test('parseGrokProfilesFromToml prefers name field for display label', () => {
  const toml = `
[models]
default = "grok"

[model.grok]
model = "grok-4.6"
name = "Grok 4.6"
base_url = "https://example.com/v1"
`;

  const { models, defaultModel } = parseGrokProfilesFromToml(toml);
  assert.equal(defaultModel, 'grok');
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], { id: 'grok', label: 'Grok 4.6', description: 'grok-4.6' });
});

test('parseGrokProfilesFromToml ignores default keys inside model profiles', () => {
  const toml = `
[model."grok-custom"]
model = "grok-4.6"
default = "not-the-global-default"

[models]
default = "grok-real"
`;

  const { defaultModel } = parseGrokProfilesFromToml(toml);
  assert.equal(defaultModel, 'grok-real');
});

test('parseGrokProfilesFromToml accepts a top-level default without [models]', () => {
  const toml = `
default = "grok-top"

[model.grok]
model = "grok-4.6"
`;

  const { defaultModel } = parseGrokProfilesFromToml(toml);
  assert.equal(defaultModel, 'grok-top');
});

test('resolveGrokPickerModels prefers config profiles over models_cache dump', () => {
  const profiles = [{ id: 'grok', label: 'Grok 4.6', description: 'grok-4.6' }];
  const cache = [
    { id: 'gpt-5.2', label: 'gpt-5.2', description: 'gpt-5.2' },
    { id: 'codex-auto-review', label: 'codex-auto-review', description: 'codex-auto-review' },
    { id: 'grok', label: 'Grok (cache)', description: 'from-cache' },
  ];
  const { models, defaultModel } = resolveGrokPickerModels({
    profileModels: profiles,
    cacheModels: cache,
    defaultModel: 'grok',
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'grok');
  assert.equal(models[0].label, 'Grok 4.6');
  assert.equal(defaultModel, 'grok');
  // Must not leak gateway catalog noise into the picker.
  assert.equal(models.some((m) => m.id.startsWith('gpt-')), false);
});

test('resolveGrokPickerModels falls back to cache when no profiles', () => {
  const cache = [
    { id: 'grok-4.6', label: 'Grok 4.6', description: 'frontier' },
    { id: 'grok-3', label: 'Grok 3', description: 'legacy' },
  ];
  const { models, defaultModel } = resolveGrokPickerModels({
    profileModels: [],
    cacheModels: cache,
  });
  assert.deepEqual(models, cache);
  assert.equal(defaultModel, 'grok-4.6');
});

test('resolveGrokPickerModels uses static fallback when nothing is configured', () => {
  const { models, defaultModel } = resolveGrokPickerModels({
    profileModels: [],
    cacheModels: [],
  });
  assert.deepEqual(models, GROK_STATIC_FALLBACK_MODELS);
  assert.equal(defaultModel, 'grok-4.6');
});
