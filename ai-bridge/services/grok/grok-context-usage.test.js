import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(extractUsedTokens({ inputTokens: 10, outputTokens: 5, thoughtTokens: 2 }), 17);
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
