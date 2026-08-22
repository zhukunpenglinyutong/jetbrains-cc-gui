/**
 * ACP timeout must recycle the client — otherwise the next session/prompt hangs
 * on a still-busy agent (RuntimeException: ACP timeout waiting for session/prompt).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GrokAcpClient,
  resolveTurnPromptTimeoutMs,
  TURN_PROMPT_TIMEOUT_MS,
} from './grok-acp-client.js';
import {
  __testing,
  getContextUsagePersistent,
} from './persistent-acp-service.js';
import { extractUsedTokens } from './grok-utils.js';

const { resetRegistry, createTestRuntime, forceSetActiveTurn, getRuntimes } = __testing;

function mockClientForRequest() {
  const client = new GrokAcpClient({ env: {}, cwd: '/tmp' });
  let killed = false;
  client.proc = {
    stdin: { write: () => {} },
    get killed() {
      return killed;
    },
    // Mirror Node's ChildProcess: exitCode is null while the process is still
    // running and a number once it has exited. grok-acp-client gates kill() on
    // `exitCode === null` (real liveness), not on `killed` (which only signals
    // that kill() was *called*), so the mock must expose exitCode too.
    get exitCode() {
      return killed ? 0 : null;
    },
    kill() {
      killed = true;
    },
  };
  client.closed = false;
  return client;
}

test('request timeout rejects with ACP_TIMEOUT and marks client unhealthy', async () => {
  const client = mockClientForRequest();

  await assert.rejects(
    () => client.request('session/prompt', { sessionId: 's1', prompt: [] }, 30),
    (err) => {
      assert.match(err.message, /ACP timeout waiting for session\/prompt/);
      assert.equal(err.code, 'ACP_TIMEOUT');
      return true;
    },
  );

  assert.equal(client.closed, true, 'client must be closed after timeout');
  assert.equal(client.unhealthy, true, 'client must be unhealthy after timeout');
  assert.equal(client.pending.size, 0);
  assert.ok(client.proc.killed, 'agent process must be killed so next turn can recover');
  assert.equal(client.isUnhealthy(), true);
});

test('request soft timeout (recycleOnTimeout:false) does not kill the agent', async () => {
  const client = mockClientForRequest();

  await assert.rejects(
    () =>
      client.request(
        'session/prompt',
        { sessionId: 's1', prompt: [{ type: 'text', text: '/always-approve off' }] },
        30,
        { recycleOnTimeout: false },
      ),
    (err) => err.code === 'ACP_TIMEOUT',
  );

  assert.equal(client.closed, false, 'control-plane timeout must not close client');
  assert.equal(client.unhealthy, undefined);
  assert.equal(client.proc.killed, false, 'must not kill mid-turn agent');
  assert.equal(client.pending.size, 0);
});

test('markUnhealthy rejects other in-flight requests', async () => {
  const client = mockClientForRequest();

  const p1 = client.request('session/prompt', { sessionId: 's1', prompt: [] }, 60_000);
  const p2 = client.request('initialize', {}, 60_000);
  assert.equal(client.pending.size, 2);

  client.markUnhealthy('forced', { killProcess: true });

  await assert.rejects(p1, /forced|ACP/);
  await assert.rejects(p2, /forced|ACP/);
  assert.equal(client.pending.size, 0);
  assert.equal(client.closed, true);
});

test('extractUsedTokens prefers total_tokens then sums parts', () => {
  assert.equal(extractUsedTokens(null), 0);
  assert.equal(extractUsedTokens({ total_tokens: 99, input_tokens: 1 }), 99);
  assert.equal(extractUsedTokens({ input_tokens: 10, output_tokens: 5 }), 15);
  assert.equal(extractUsedTokens({ prompt_tokens: 3, completion_tokens: 2 }), 5);
});

test('getContextUsagePersistent reads runtime.lastUsedTokens after usage remember', async () => {
  resetRegistry();
  const rt = createTestRuntime('timeout-rt', { model: 'grok-4.6', permissionMode: 'default' });
  rt.lastUsedTokens = 12_345;
  forceSetActiveTurn(rt);

  const payload = await getContextUsagePersistent({ maxTokens: 500_000 });
  assert.equal(payload.totalTokens, 12_345);
  assert.equal(payload.maxTokens, 500_000);
  assert.equal(payload.model, 'grok-4.6');
  assert.equal(payload.source, 'grok-synthesized');
});

test('createTestRuntime can simulate unhealthy client for recycle path', () => {
  resetRegistry();
  const client = {
    activeSessionId: 's',
    closed: true,
    unhealthy: true,
    isUnhealthy: () => true,
  };
  const rt = createTestRuntime('dead-rt', { client, sessionId: 's' });
  assert.equal(getRuntimes().length, 1);
  assert.ok(rt.client.unhealthy);
});

test('default turn prompt timeout is at least 30 minutes (long agentic runs)', () => {
  assert.ok(
    TURN_PROMPT_TIMEOUT_MS >= 30 * 60 * 1000,
    `expected >= 30m, got ${TURN_PROMPT_TIMEOUT_MS}ms`,
  );
  assert.equal(resolveTurnPromptTimeoutMs({}), 60 * 60 * 1000);
});

test('resolveTurnPromptTimeoutMs honors GROK_ACP_TURN_TIMEOUT_MS with clamps', () => {
  assert.equal(resolveTurnPromptTimeoutMs({ GROK_ACP_TURN_TIMEOUT_MS: '900000' }), 900_000);
  // below 5m floor
  assert.equal(resolveTurnPromptTimeoutMs({ GROK_ACP_TURN_TIMEOUT_MS: '1000' }), 5 * 60 * 1000);
  // above 4h ceiling
  assert.equal(
    resolveTurnPromptTimeoutMs({ GROK_ACP_TURN_TIMEOUT_MS: String(99 * 60 * 60 * 1000) }),
    4 * 60 * 60 * 1000,
  );
  assert.equal(resolveTurnPromptTimeoutMs({ GROK_ACP_TURN_TIMEOUT_MS: 'nope' }), 60 * 60 * 1000);
});
