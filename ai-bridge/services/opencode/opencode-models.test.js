import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listOpenCodeModelProviders,
  normalizeOpenCodeModels,
  parseOpenCodeModel,
  resolveOpenCodePromptModel,
  resolveLastUsedSessionModel,
  filterOpenCodeProvidersByConfig
} from './message-service.js';

test('opencode model discovery keeps CLI default placeholder first', () => {
  const models = normalizeOpenCodeModels({
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet-4-5': {
            id: 'claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            enabled: true,
            status: 'active',
          },
        },
      },
    ],
    default: {
      anthropic: 'claude-sonnet-4-5',
    },
  }, {
    model: 'anthropic/claude-sonnet-4-5',
  });

  assert.equal(models[0].id, 'opencode-default');
  assert.equal(models[0].isDefault, true);
  assert.equal(models[0].description, 'Uses anthropic/claude-sonnet-4-5 from opencode config.');
  assert.deepEqual(models[1], {
    id: 'anthropic/claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    description: 'Anthropic · provider default',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    providerName: 'Anthropic',
    isDefault: false,
    isProviderDefault: true,
  });
});

test('opencode model discovery filters disabled models', () => {
  const models = normalizeOpenCodeModels({
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          enabled: { id: 'gpt-5.5', name: 'GPT-5.5' },
          disabled: { id: 'old-model', name: 'Old Model', enabled: false },
        },
      },
    ],
  });

  assert.deepEqual(models.map((model) => model.id), [
    'opencode-default',
    'openai/gpt-5.5',
  ]);
});

test('opencode model discovery accepts provider list payloads', () => {
  const models = normalizeOpenCodeModels({
    all: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4' },
          'gpt-5.4-mini': { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
        },
      },
    ],
    default: {
      openai: 'gpt-5.4',
    },
  });

  assert.deepEqual(models.map((model) => model.id), [
    'opencode-default',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini',
  ]);
  assert.equal(models[1].isProviderDefault, true);
});

test('opencode provider discovery merges connected provider catalogs only', async () => {
  const providers = await listOpenCodeModelProviders({
    config: {
      providers: async () => ({
        data: {
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5.4-mini': { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
              },
            },
          ],
          default: { openai: 'gpt-5.4-mini' },
        },
      }),
    },
    provider: {
      list: async () => ({
        data: {
          all: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4' },
                'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' },
              },
            },
            {
              id: 'helicone',
              name: 'Helicone',
              models: {
                'gemini-3-pro-preview': {
                  id: 'gemini-3-pro-preview',
                  name: 'Gemini 3 Pro Preview',
                },
              },
            },
          ],
          connected: ['openai'],
          default: {
            helicone: 'gemini-3-pro-preview',
            openai: 'gpt-5.5',
          },
        },
      }),
    },
  });
  const models = normalizeOpenCodeModels(providers);

  assert.deepEqual(models.map((model) => model.id), [
    'opencode-default',
    'openai/gpt-5.4',
    'openai/gpt-5.5',
    'openai/gpt-5.4-mini',
  ]);
  assert.equal(models[0].description, 'Uses openai/gpt-5.4-mini provider default.');
});

test('opencode model discovery ignores stale configured default labels', () => {
  const models = normalizeOpenCodeModels({
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.5-pro': { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' },
        },
      },
    ],
    default: {
      openai: 'gpt-5.5-pro',
    },
  }, {
    model: 'openai/gpt-5.5',
  });

  assert.equal(models[0].description, 'Uses openai/gpt-5.5-pro provider default.');
});

test('opencode default model uses provider defaults in provider-list order', () => {
  const models = normalizeOpenCodeModels({
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4' },
        },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        },
      },
    ],
    default: {
      openai: 'gpt-5.4',
      anthropic: 'claude-sonnet-4-6',
    },
  });

  assert.equal(models[0].description, 'Uses openai/gpt-5.4 provider default.');
});

test('opencode default model falls back to first available model in provider-list order', () => {
  const models = normalizeOpenCodeModels({
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' },
        },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        },
      },
    ],
  });

  assert.equal(models[0].description, 'Uses openai/gpt-5.5 as first available model.');
});

test('opencode default placeholder is not parsed as a concrete model', () => {
  assert.equal(parseOpenCodeModel('opencode-default'), undefined);
});

test('opencode prompt omits model when opencode default is selected', async () => {
  assert.equal(await resolveOpenCodePromptModel(null, '/tmp', 'opencode-default'), undefined);
  assert.equal(await resolveOpenCodePromptModel(null, '/tmp', ''), undefined);
});

test('opencode provider discovery respects enabled_providers', () => {
  const models = normalizeOpenCodeModels({
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' } },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: { 'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' } },
      },
    ],
  }, {
    enabled_providers: ['anthropic'],
  });

  assert.deepEqual(models.map((model) => model.id), [
    'opencode-default',
    'anthropic/claude-sonnet-4-5',
  ]);
});

test('opencode provider discovery respects disabled_providers over enabled_providers', () => {
  const filtered = filterOpenCodeProvidersByConfig([
    { id: 'openai', models: {} },
    { id: 'anthropic', models: {} },
  ], {
    enabled_providers: ['openai', 'anthropic'],
    disabled_providers: ['openai'],
  });

  assert.deepEqual(filtered.map((provider) => provider.id), ['anthropic']);
});

test('opencode default model prefers last-used session model', async () => {
  const client = {
    session: {
      list: async () => ({
        data: [{ id: 'ses_1' }],
      }),
      messages: async () => ({
        data: [
          { info: { role: 'user', model: { providerID: 'openai', modelID: 'gpt-5.5' } } },
        ],
      }),
    },
  };
  const providers = [{
    id: 'openai',
    models: {
      'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' },
    },
  }];

  const lastUsed = await resolveLastUsedSessionModel(client, '/tmp', providers);
  assert.equal(lastUsed, 'openai/gpt-5.5');

  const models = normalizeOpenCodeModels({ providers }, {}, { id: lastUsed, source: 'last-used' });
  assert.equal(models[0].description, 'Uses openai/gpt-5.5 last used in this project.');
});
