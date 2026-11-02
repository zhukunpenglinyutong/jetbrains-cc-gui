import test from 'node:test';
import assert from 'node:assert/strict';
import * as grokUtils from './grok-utils.js';
import {
  buildGrokContextUsagePayload,
  extractUsedTokens,
  extractUsageFromAcpEnvelope,
  normalizeUsageToSnakeCase,
} from './grok-utils.js';
import {
  getContextUsagePersistent,
  getUsagePersistent,
  __testing,
} from './persistent-acp-service.js';

const { resetRegistry, createTestRuntime, forceSetActiveTurn } = __testing;

test('extractUsedTokens mirrors Java GrokContextUsageBuilder', () => {
  assert.equal(extractUsedTokens({ total_tokens: 42, input_tokens: 1 }), 42);
  // output_tokens and completion_tokens are aliases — count once (not 10+5+1)
  assert.equal(extractUsedTokens({ input_tokens: 10, output_tokens: 5, completion_tokens: 1 }), 15);
  assert.equal(extractUsedTokens({}), 0);
  // Grok ACP usage_update uses camelCase (fallback → normalized snake_case)
  assert.equal(extractUsedTokens({ totalTokens: 99, inputTokens: 1 }), 99);
  // Reasoning is part of output (Grok: totalTokens = inputTokens + outputTokens), so it is not added again
  assert.equal(extractUsedTokens({ inputTokens: 10, outputTokens: 5, thoughtTokens: 2 }), 15);
  assert.equal(extractUsedTokens({ thoughtTokens: 7 }), 7);
});

test('normalizeUsageToSnakeCase maps camelCase and prefers snake_case', () => {
  const fromCamel = normalizeUsageToSnakeCase({
    totalTokens: 50,
    inputTokens: 40,
    outputTokens: 10,
  });
  assert.deepEqual(fromCamel, {
    input_tokens: 40,
    output_tokens: 10,
    total_tokens: 50,
  });

  const preferSnake = normalizeUsageToSnakeCase({
    total_tokens: 99,
    totalTokens: 1,
    input_tokens: 80,
    inputTokens: 2,
  });
  assert.equal(preferSnake.total_tokens, 99);
  assert.equal(preferSnake.input_tokens, 80);

  assert.equal(normalizeUsageToSnakeCase(null), null);
  assert.equal(normalizeUsageToSnakeCase({}), null);
});

test('extractUsageFromAcpEnvelope reads Grok CLI turn_completed and prompt _meta', () => {
  // Live shape from grok agent stdio 0.2.x against antig
  const notifUsage = extractUsageFromAcpEnvelope('_x.ai/session_notification', {
    sessionId: 's1',
    update: {
      sessionUpdate: 'turn_completed',
      usage: {
        inputTokens: 17557,
        outputTokens: 14,
        totalTokens: 17571,
        cachedReadTokens: 128,
        reasoningTokens: 13,
      },
    },
  });
  assert.equal(extractUsedTokens(notifUsage), 17571);
  assert.equal(normalizeUsageToSnakeCase(notifUsage).total_tokens, 17571);
  assert.equal(normalizeUsageToSnakeCase(notifUsage).input_tokens, 17557);

  const promptUsage = extractUsageFromAcpEnvelope({
    stopReason: 'end_turn',
    _meta: {
      totalTokens: 17571,
      inputTokens: 17557,
      outputTokens: 14,
      usage: {
        inputTokens: 17557,
        outputTokens: 14,
        totalTokens: 17571,
      },
    },
  });
  assert.equal(extractUsedTokens(promptUsage), 17571);

  // Classic usage_update still works
  const classic = extractUsageFromAcpEnvelope('session/update', {
    update: { sessionUpdate: 'usage_update', usage: { total_tokens: 42 } },
  });
  assert.equal(extractUsedTokens(classic), 42);
});

test('GrokEventNormalizer emits [USAGE] from turn_completed and prompt _meta', async () => {
  const { GrokEventNormalizer } = await import('./grok-event-normalizer.js');
  const lines = [];
  const n = new GrokEventNormalizer({
    log: (s) => lines.push(String(s)),
    error: (s) => lines.push(String(s)),
  });
  n.begin();
  n.handleAcpEvent('notification', {
    method: '_x.ai/session_notification',
    params: {
      update: {
        sessionUpdate: 'turn_completed',
        usage: { totalTokens: 1234, inputTokens: 1000, outputTokens: 234 },
      },
    },
  });
  n.handleAcpEvent('prompt_result', {
    stopReason: 'end_turn',
    _meta: { usage: { totalTokens: 1234, inputTokens: 1000, outputTokens: 234 } },
  });
  n.finishSuccess('sid-1', 'pong');
  const usageLines = lines.filter((l) => l.startsWith('[USAGE]'));
  assert.ok(usageLines.length >= 1, 'expected [USAGE] tag, got: ' + lines.join('\n'));
  const payload = JSON.parse(usageLines[0].slice('[USAGE] '.length));
  assert.equal(payload.total_tokens, 1234);
  assert.equal(payload.input_tokens, 1000);
  // Final MESSAGE must carry usage so Java does not wipe the ring snapshot
  const msgLine = lines.find((l) => l.startsWith('[MESSAGE] '));
  assert.ok(msgLine, 'expected final [MESSAGE]');
  const msg = JSON.parse(msgLine.slice('[MESSAGE] '.length));
  assert.equal(msg.message.usage.total_tokens, 1234);
});

test('buildGrokContextUsagePayload synthesizes conversation + free space', () => {
  const payload = buildGrokContextUsagePayload({
    usedTokens: 50_000,
    maxTokens: 200_000,
    model: 'grok-2',
  });
  assert.equal(payload.success, true);
  assert.equal(payload.totalTokens, 50_000);
  assert.equal(payload.maxTokens, 200_000);
  assert.equal(payload.percentage, 25);
  assert.equal(payload.categories.length, 2);
  assert.equal(payload.categories[0].name, 'Conversation');
  assert.equal(payload.categories[1].tokens, 150_000);
  assert.equal(payload.source, 'grok-synthesized');
});

test('buildGrokContextUsagePayload clamps over-max usage', () => {
  const payload = buildGrokContextUsagePayload({ usedTokens: 999_999, maxTokens: 100 });
  assert.equal(payload.totalTokens, 100);
  assert.equal(payload.percentage, 100);
  assert.equal(payload.categories[1].tokens, 0);
});

test('getContextUsagePersistent uses Java-supplied used/max', async () => {
  resetRegistry();
  const payload = await getContextUsagePersistent({
    usedTokens: 1000,
    maxTokens: 10_000,
    model: 'grok-build',
  });
  assert.equal(payload.success, true);
  assert.equal(payload.totalTokens, 1000);
  assert.equal(payload.maxTokens, 10_000);
  assert.equal(payload.model, 'grok-build');
});

test('getContextUsagePersistent falls back to active runtime lastUsedTokens', async () => {
  resetRegistry();
  const rt = createTestRuntime('ctx-rt', { model: 'grok-2', permissionMode: 'default' });
  rt.lastUsedTokens = 777;
  forceSetActiveTurn(rt);

  const payload = await getContextUsagePersistent({ maxTokens: 500_000 });
  assert.equal(payload.totalTokens, 777);
  assert.equal(payload.model, 'grok-2');
});

test('getUsagePersistent returns structured unavailable on failure (does not throw)', async () => {
  resetRegistry();
  // Force failure path by using impossible cwd / no network expectations —
  // spawn may fail quickly without credentials.
  const payload = await getUsagePersistent({
    cwd: '/tmp',
    apiKey: '',
    authMethod: 'oauth',
  });
  assert.equal(payload.success, true);
  assert.ok(payload.data);
  // Either real CLI output or unavailable fallback
  if (payload.data.unavailable) {
    assert.equal(typeof payload.data.message, 'string');
    assert.ok(payload.data.message.length > 0);
  } else {
    assert.ok(payload.data.raw || payload.output || payload.data.config);
  }
});

test('normalizeGrokTurnUsage converts camelCase and snake_case Grok usage into Claude turnUsage schema', () => {
  assert.equal(typeof grokUtils.normalizeGrokTurnUsage, 'function', 'normalizeGrokTurnUsage must be exported');
  // camelCase with cachedReadTokens (cache-inclusive inputTokens)
  const fromCamel = grokUtils.normalizeGrokTurnUsage({
    totalTokens: 47330,
    inputTokens: 46915,
    cachedReadTokens: 24960,
    outputTokens: 415,
    reasoningTokens: 361,
  });
  assert.deepEqual(fromCamel, {
    input_tokens: 21955,
    cache_read_input_tokens: 24960,
    cache_creation_input_tokens: 0,
    output_tokens: 415,
    thinking_tokens: 361,
    total_tokens: 47330,
  });

  // snake_case (already cache-exclusive)
  const fromSnake = grokUtils.normalizeGrokTurnUsage({
    input_tokens: 554,
    cache_read_input_tokens: 23168,
    output_tokens: 356,
    total_tokens: 24086,
  });
  assert.deepEqual(fromSnake, {
    input_tokens: 554,
    cache_read_input_tokens: 23168,
    cache_creation_input_tokens: 0,
    output_tokens: 356,
    thinking_tokens: 0,
    total_tokens: 24086,
  });
});

test('multi-step turn (modelCalls > 1) keeps context ring at latest step occupancy and emits Claude-schema turnUsage on [RESULT]', async () => {
  const { GrokEventNormalizer } = await import('./grok-event-normalizer.js');
  const lines = [];
  const n = new GrokEventNormalizer({
    log: (s) => lines.push(String(s)),
    error: (s) => lines.push(String(s)),
  });
  n.begin();

  // Step 1: initial tool-calling step
  n.handleAcpEvent('notification', {
    method: '_x.ai/session_notification',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'response_completed',
        usage: {
          input_tokens: 500,
          cache_read_input_tokens: 20000,
          output_tokens: 200,
          total_tokens: 20700,
        },
      },
    },
  });

  // Step 2: final reply step
  n.handleAcpEvent('notification', {
    method: '_x.ai/session_notification',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'response_completed',
        usage: {
          input_tokens: 554,
          cache_read_input_tokens: 23168,
          output_tokens: 356,
          total_tokens: 24086,
        },
      },
    },
  });

  // Turn completed: multi-call cumulative usage
  n.handleAcpEvent('notification', {
    method: '_x.ai/session_notification',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'turn_completed',
        usage: {
          totalTokens: 47330,
          inputTokens: 46915,
          cachedReadTokens: 24960,
          outputTokens: 415,
          reasoningTokens: 361,
          modelCalls: 2,
        },
      },
    },
  });

  // Prompt result with top-level latest step _meta and multi-call _meta.usage
  n.handleAcpEvent('prompt_result', {
    stopReason: 'end_turn',
    _meta: {
      totalTokens: 24086,
      inputTokens: 23722,
      outputTokens: 356,
      cachedReadTokens: 23168,
      usage: {
        totalTokens: 47330,
        inputTokens: 46915,
        cachedReadTokens: 24960,
        outputTokens: 415,
        reasoningTokens: 361,
        modelCalls: 2,
      },
    },
  });

  n.finishSuccess('sid-1', 'multi-step done');

  // 1. Context ring usage snapshot on [MESSAGE] must reflect the latest step occupancy (24086), NOT 47330
  const msgLine = lines.filter((l) => l.startsWith('[MESSAGE] ')).pop();
  assert.ok(msgLine, 'expected final [MESSAGE]');
  const msg = JSON.parse(msgLine.slice('[MESSAGE] '.length));
  assert.equal(msg.message.usage.total_tokens, 24086);

  // 2. Whole-turn token accounting on [RESULT] must carry the normalized turnUsage
  const resLine = lines.find((l) => l.startsWith('[RESULT] '));
  assert.ok(resLine, 'expected [RESULT]');
  const res = JSON.parse(resLine.slice('[RESULT] '.length));
  assert.equal(res.usage.total_tokens, 47330);
  assert.equal(res.usage.cache_read_input_tokens, 24960);
  assert.equal(res.usage.input_tokens, 21955);
  assert.equal(res.usage.output_tokens, 415);
  assert.equal(res.usage.thinking_tokens, 361);
});

test('usage without a total does not count cache-inclusive input twice', () => {
  // camelCase inputTokens already includes cachedReadTokens.
  const camel = { inputTokens: 46915, cachedReadTokens: 24960, outputTokens: 415 };
  assert.equal(normalizeUsageToSnakeCase(camel).total_tokens, 47330);
  assert.equal(extractUsedTokens(camel), 47330);

  // Claude-style input_tokens excludes cache_read_input_tokens.
  const claudeStyle = { input_tokens: 554, cache_read_input_tokens: 23168, output_tokens: 356 };
  assert.equal(normalizeUsageToSnakeCase(claudeStyle).total_tokens, 24078);
  assert.equal(extractUsedTokens(claudeStyle), 24078);
});

test('normalized [USAGE] snapshots keep cache-inclusive input so turn usage can split it again', () => {
  // A step whose total is not exactly input + output must still be split correctly.
  const step = normalizeUsageToSnakeCase({
    input_tokens: 554,
    cache_read_input_tokens: 23168,
    output_tokens: 356,
    total_tokens: 24086,
  });
  assert.equal(step.input_tokens, 23722);
  assert.equal(step.cached_read_tokens, 23168);

  const fromMeta = normalizeUsageToSnakeCase({
    totalTokens: 24086,
    inputTokens: 23722,
    cachedReadTokens: 23168,
    outputTokens: 356,
  });
  for (const snapshot of [step, fromMeta]) {
    const turn = grokUtils.normalizeGrokTurnUsage(snapshot);
    assert.equal(turn.input_tokens, 554);
    assert.equal(turn.cache_read_input_tokens, 23168);
    assert.equal(turn.total_tokens, 24086);
  }
});

test('normalizeGrokTurnUsage reads the cacheReadTokens / cacheWriteTokens aliases used by usage.json', () => {
  const turn = grokUtils.normalizeGrokTurnUsage({
    totalTokens: 23686,
    inputTokens: 20000,
    outputTokens: 3686,
    cacheReadTokens: 1000,
    cacheWriteTokens: 500,
  });
  assert.equal(turn.input_tokens, 18500);
  assert.equal(turn.cache_read_input_tokens, 1000);
  assert.equal(turn.cache_creation_input_tokens, 500);
});

test('a usage without a total matches the whole-turn total, reasoning included', () => {
  const usage = { inputTokens: 46915, cachedReadTokens: 24960, outputTokens: 415, reasoningTokens: 361 };
  assert.equal(extractUsedTokens(usage), 47330);
  assert.equal(grokUtils.normalizeGrokTurnUsage(usage).total_tokens, 47330);
});
