import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOmpModelsJson } from './models-service.js';

test('a model carries the thinking levels omp accepts for it', () => {
  const models = parseOmpModelsJson(JSON.stringify({
    models: [
      {
        selector: 'anthropic/claude-opus-5-5',
        contextWindow: 1000000,
        reasoning: true,
        thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
        input: ['text', 'image'],
      },
      { selector: 'opencode-go/deepseek-v4.1-flash', reasoning: true, thinking: ['low', 'high', 'max'] },
    ],
  }));
  assert.deepEqual(models, [
    {
      id: 'anthropic/claude-opus-5-5',
      label: 'anthropic/claude-opus-5-5',
      description: 'ctx 1000K · thinking · vision',
      contextWindow: 1000000,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'opencode-go/deepseek-v4.1-flash',
      label: 'opencode-go/deepseek-v4.1-flash',
      description: 'thinking',
      supportedReasoningEfforts: ['low', 'high', 'max'],
    },
  ]);
});

test('a model without thinking levels has no effort list', () => {
  const models = parseOmpModelsJson(JSON.stringify({
    models: [
      { selector: 'local/plain', reasoning: false, thinking: null },
      { selector: 'local/empty', thinking: [] },
      { selector: 'local/garbage', thinking: [null, 3, ''] },
    ],
  }));
  for (const model of models) {
    assert.equal('supportedReasoningEfforts' in model, false, model.id);
  }
});

test('contextWindow is carried only when omp reports a positive finite number', () => {
  const models = parseOmpModelsJson(JSON.stringify({
    models: [
      { selector: 'a/ok', contextWindow: 200000 },
      { selector: 'a/zero', contextWindow: 0 },
      { selector: 'a/negative', contextWindow: -5 },
      { selector: 'a/text', contextWindow: '1000' },
      { selector: 'a/null', contextWindow: null },
      { selector: 'a/missing' },
    ],
  }));
  const withWindow = models.filter((model) => 'contextWindow' in model).map((model) => [model.id, model.contextWindow]);
  assert.deepEqual(withWindow, [['a/ok', 200000]]);
});
