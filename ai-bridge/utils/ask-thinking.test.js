import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseClaudeModelVersion,
  buildAskThinkingFields,
  isThinkingRejection,
  withoutThinking,
  createWithThinkingFallback,
} from './ask-thinking.js';

// Shaped like the Anthropic SDK 1.3.0 APIError: status, "<status> <json body>" message, parsed body.
function sdkError(status, message) {
  const body = { type: 'error', error: { type: 'invalid_request_error', message } };
  return { status, message: `${status} ${JSON.stringify(body)}`, error: body };
}

const SONNET_55_REJECTION = sdkError(400, 'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.');
const OPUS_55_REJECTION = sdkError(400, 'thinking.type.disabled is not supported for this model');
const MINIMAX_REJECTION = sdkError(400, 'invalid params, model "MiniMax-M3.1-Flash" requires adaptive thinking; thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)');

// ---------- parseClaudeModelVersion ----------

test('parseClaudeModelVersion reads family, major and minor from Claude ids', () => {
  assert.deepEqual(parseClaudeModelVersion('claude-sonnet-5-5[1m]'), { family: 'sonnet', major: 5, minor: 5 });
  assert.deepEqual(parseClaudeModelVersion('us.anthropic.claude-opus-5-5'), { family: 'opus', major: 5, minor: 5 });
  assert.deepEqual(parseClaudeModelVersion('anthropic.claude-fable-5-2'), { family: 'fable', major: 5, minor: 2 });
  assert.deepEqual(parseClaudeModelVersion('claude-mythos-5-1'), { family: 'mythos', major: 5, minor: 1 });
});

test('parseClaudeModelVersion does not read a date stamp as a minor version', () => {
  assert.deepEqual(parseClaudeModelVersion('claude-opus-4-5-20251101'), { family: 'opus', major: 4, minor: 5 });
  assert.deepEqual(parseClaudeModelVersion('claude-sonnet-5'), { family: 'sonnet', major: 5, minor: 0 });
  assert.deepEqual(parseClaudeModelVersion('claude-sonnet-5-20260101'), { family: 'sonnet', major: 5, minor: 0 });
});

test('parseClaudeModelVersion returns null for non-Claude or non-string input', () => {
  assert.equal(parseClaudeModelVersion('deepseek-reasoner'), null);
  assert.equal(parseClaudeModelVersion('MiniMax-M3.1-Flash'), null);
  assert.equal(parseClaudeModelVersion(null), null);
  assert.equal(parseClaudeModelVersion(42), null);
});

// ---------- buildAskThinkingFields ----------

test('buildAskThinkingFields keeps disabled for models that accept it', () => {
  for (const id of ['deepseek-reasoner', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'MiniMax-M3.1-Flash']) {
    const fields = buildAskThinkingFields(id, 2048);
    assert.deepEqual(fields, { max_tokens: 2048, thinking: { type: 'disabled' } }, id);
  }
});

test('buildAskThinkingFields uses between_tools for Sonnet 5.5', () => {
  for (const id of ['claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']) {
    const fields = buildAskThinkingFields(id, 2048);
    assert.deepEqual(fields, { max_tokens: 2048, thinking: { type: 'between_tools' } }, id);
  }
});

test('buildAskThinkingFields omits thinking and lowers effort for always-on models', () => {
  const ids = [
    'claude-opus-5-5',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-fable-5-2',
    'claude-mythos-5-1',
    'us.anthropic.claude-opus-5-5',
  ];
  for (const id of ids) {
    const fields = buildAskThinkingFields(id, 2048);
    assert.equal('thinking' in fields, false, id);
    assert.deepEqual(fields.output_config, { effort: 'low' }, id);
    assert.equal(fields.max_tokens, 4096, id);
    assert.equal(buildAskThinkingFields(id, 8192).max_tokens, 8192, id);
  }
});

// ---------- isThinkingRejection ----------

test('isThinkingRejection recognises thinking-related 400s from Anthropic and relays', () => {
  assert.equal(isThinkingRejection(SONNET_55_REJECTION), true);
  assert.equal(isThinkingRejection(OPUS_55_REJECTION), true);
  assert.equal(isThinkingRejection(MINIMAX_REJECTION), true);
});

test('isThinkingRejection ignores unrelated errors', () => {
  assert.equal(isThinkingRejection(sdkError(400, 'prompt is too long: 250000 tokens > 200000 maximum')), false);
  assert.equal(isThinkingRejection(sdkError(500, 'thinking service failed')), false);
  assert.equal(isThinkingRejection(sdkError(429, 'thinking rate limit')), false);
  assert.equal(isThinkingRejection(null), false);
});

// ---------- withoutThinking ----------

test('withoutThinking drops thinking, raises max_tokens and leaves the input alone', () => {
  const request = {
    model: 'MiniMax-M3.1-Flash',
    max_tokens: 2048,
    thinking: { type: 'disabled' },
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  };
  const snapshot = structuredClone(request);
  const retry = withoutThinking(request);
  assert.equal('thinking' in retry, false);
  assert.equal(retry.max_tokens, 4096);
  assert.equal(retry.model, 'MiniMax-M3.1-Flash');
  assert.equal(retry.system, 'sys');
  assert.deepEqual(retry.messages, request.messages);
  assert.deepEqual(request, snapshot);
  assert.notEqual(retry, request);
});

test('withoutThinking keeps a max_tokens that is already large and returns null without thinking', () => {
  assert.equal(withoutThinking({ model: 'm', max_tokens: 8192, thinking: { type: 'disabled' } }).max_tokens, 8192);
  assert.equal(withoutThinking({ model: 'm', max_tokens: 2048 }), null);
  assert.equal(withoutThinking(null), null);
});

// ---------- createWithThinkingFallback ----------

test('createWithThinkingFallback retries once without thinking on a thinking 400', async () => {
  const requests = [];
  const retries = [];
  const create = async (request) => {
    requests.push(request);
    if (requests.length === 1) throw MINIMAX_REJECTION;
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  const result = await createWithThinkingFallback(
    create,
    { model: 'MiniMax-M3.1-Flash', max_tokens: 2048, thinking: { type: 'disabled' }, messages: [] },
    { onRetry: (err) => retries.push(err) },
  );
  assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });
  assert.equal(requests.length, 2);
  assert.equal('thinking' in requests[1], false);
  assert.equal(requests[1].max_tokens, 4096);
  assert.deepEqual(retries, [MINIMAX_REJECTION]);
});

test('createWithThinkingFallback rethrows errors unrelated to thinking', async () => {
  let calls = 0;
  const error = sdkError(400, 'prompt is too long');
  let retried = false;
  await assert.rejects(
    createWithThinkingFallback(
      async () => { calls += 1; throw error; },
      { model: 'm', max_tokens: 2048, thinking: { type: 'disabled' } },
      { onRetry: () => { retried = true; } },
    ),
    (err) => err === error,
  );
  assert.equal(calls, 1);
  assert.equal(retried, false);
});

test('createWithThinkingFallback does not retry a request that has no thinking to remove', async () => {
  let calls = 0;
  await assert.rejects(
    createWithThinkingFallback(
      async () => { calls += 1; throw OPUS_55_REJECTION; },
      { model: 'claude-opus-5-5', max_tokens: 4096, output_config: { effort: 'low' } },
    ),
    (err) => err === OPUS_55_REJECTION,
  );
  assert.equal(calls, 1);
});

test('createWithThinkingFallback surfaces the retry error without a third attempt', async () => {
  let calls = 0;
  const second = sdkError(500, 'upstream down');
  await assert.rejects(
    createWithThinkingFallback(
      async () => { calls += 1; throw calls === 1 ? MINIMAX_REJECTION : second; },
      { model: 'm', max_tokens: 2048, thinking: { type: 'disabled' } },
    ),
    (err) => err === second,
  );
  assert.equal(calls, 2);
});
