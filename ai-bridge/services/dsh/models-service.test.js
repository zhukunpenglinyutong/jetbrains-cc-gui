import test from 'node:test';
import assert from 'node:assert/strict';

// flattenLlmModels lives in session.js (the RPC layer); models-service.js
// only drives the host round-trip.
import { flattenLlmModels } from './session.js';

test('flattenLlmModels flattens groups into provider/model rows', () => {
  const catalog = {
    groups: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'gpt-5', name: 'GPT-5', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
          { id: 'gpt-5-mini' },
        ],
      },
      { id: 'deepseek', models: [{ id: 'deepseek-chat' }] },
    ],
  };
  const models = flattenLlmModels(catalog);
  assert.deepEqual(
    models.map((model) => model.id),
    ['openai/gpt-5', 'openai/gpt-5-mini', 'deepseek/deepseek-chat']
  );
  assert.equal(models[0].label, 'OpenAI / GPT-5');
  assert.equal(models[0].description, 'effort: low / high');
  // No display name → fall back to the model id; no efforts → provider.
  assert.equal(models[1].label, 'OpenAI / gpt-5-mini');
  assert.equal(models[2].description, 'deepseek');
});

test('flattenLlmModels dedupes provider/model ids and skips blank rows', () => {
  const catalog = {
    groups: [
      { id: 'p1', models: [{ id: 'm1' }, { id: 'm1' }, { id: '   ' }, {}] },
      { id: 'p1', models: [{ id: 'm1' }, { id: 'm2' }] },
    ],
  };
  const models = flattenLlmModels(catalog);
  assert.deepEqual(
    models.map((model) => model.id),
    ['p1/m1', 'p1/m2']
  );
});

test('flattenLlmModels tolerates a missing/empty catalog', () => {
  assert.deepEqual(flattenLlmModels(null), []);
  assert.deepEqual(flattenLlmModels({}), []);
  assert.deepEqual(flattenLlmModels({ groups: [{ models: [{ id: 'm' }] }] }), [
    { id: 'unknown/m', label: 'unknown / m', description: 'unknown' },
  ]);
});
