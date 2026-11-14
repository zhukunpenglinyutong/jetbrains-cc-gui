import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOmpUsage } from './usage.js';

test('maps an OMP step onto the Claude usage schema with OMP\'s own cost', () => {
  const usage = normalizeOmpUsage({
    input: 4,
    output: 179,
    cacheRead: 0,
    cacheWrite: 14888,
    totalTokens: 15071,
    cost: { input: 0.000016, output: 0.00358, cacheRead: 0, cacheWrite: 0.119104, total: 0.1227 },
  }, 1_000_000);
  assert.deepEqual(usage, {
    input_tokens: 4,
    output_tokens: 179,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 14888,
    total_tokens: 15071,
    cost_usd: 0.1227,
    model_context_window: 1_000_000,
  });
});

test('a free step keeps its zero cost so the plugin does not price it from a table', () => {
  const usage = normalizeOmpUsage({ input: 10, output: 5, totalTokens: 15, cost: { total: 0 } });
  assert.equal(usage.cost_usd, 0);
});

test('omits cost and context window when OMP reports neither', () => {
  const usage = normalizeOmpUsage({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
  assert.deepEqual(usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 3,
    total_tokens: 20,
  });
});

test('ignores a cost that is not a non-negative number', () => {
  for (const total of [-1, Number.NaN, '0.5', null]) {
    assert.equal('cost_usd' in normalizeOmpUsage({ input: 1, output: 1, cost: { total } }), false, String(total));
  }
});

test('returns null for a step without token figures', () => {
  assert.equal(normalizeOmpUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }), null);
  assert.equal(normalizeOmpUsage(null), null);
  assert.equal(normalizeOmpUsage('nope'), null);
});
