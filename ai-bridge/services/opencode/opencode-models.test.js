import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOpenCodeModels } from './message-service.js';

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
