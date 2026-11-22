import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOpenCodeUsage } from './usage.js';

test('extractOpenCodeUsage normalizes OpenAI-compatible usage with cached_tokens', () => {
  const usage = extractOpenCodeUsage({
    type: 'step_finish',
    usage: {
      prompt_tokens: 19009,
      completion_tokens: 108,
      total_tokens: 19117,
      prompt_tokens_details: {
        cached_tokens: 14189,
      },
    },
  });
  assert.deepEqual(usage, {
    input_tokens: 4820,
    output_tokens: 108,
    cache_read_input_tokens: 14189,
    cache_creation_input_tokens: 0,
    total_tokens: 19117,
  });
});

test('extractOpenCodeUsage sums OpenCode 2.x tokens that carry no total', () => {
  const usage = extractOpenCodeUsage({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      cost: 0.0123,
      tokens: { input: 116, output: 1368, reasoning: 212, cache: { read: 7844, write: 0 } },
    },
  });
  assert.deepEqual(usage, {
    input_tokens: 116,
    output_tokens: 1368,
    cache_read_input_tokens: 7844,
    cache_creation_input_tokens: 0,
    total_tokens: 9540,
    thinking_tokens: 212,
    cost_usd: 0.0123,
  });
});

test('extractOpenCodeUsage omits cost_usd when OpenCode reports no numeric cost', () => {
  const usage = extractOpenCodeUsage({
    part: { type: 'step-finish', tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } } },
  });
  assert.equal(Object.hasOwn(usage, 'cost_usd'), false);
});

test('extractOpenCodeUsage keeps Claude-schema usage that also carries total_tokens', () => {
  const usage = extractOpenCodeUsage({
    type: 'usage',
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 50,
      total_tokens: 160,
    },
  });
  assert.deepEqual(usage, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 0,
    total_tokens: 160,
  });
});

test('extractOpenCodeUsage returns null for an all-zero step', () => {
  assert.equal(extractOpenCodeUsage({
    part: { type: 'step-finish', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  }), null);
});
