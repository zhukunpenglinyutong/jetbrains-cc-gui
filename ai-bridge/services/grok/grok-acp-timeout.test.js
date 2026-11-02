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
import { AcpTerminalHost } from './acp-terminal-host.js';
import {
  __testing,
  getContextUsagePersistent,
} from './persistent-acp-service.js';
import { extractUsedTokens } from './grok-utils.js';

const { resetRegistry, createTestRuntime, forceSetActiveTurn, getRuntimes } = __testing;

function mockClientForRequest(options = {}) {
  const client = new GrokAcpClient({ env: {}, cwd: '/tmp', ...options });
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

test('Story 013 AC-1: GrokAcpClient.request resets timeout when streaming notifications or stderr arrive, allowing active turn to exceed single timeoutMs window', async () => {
  const client = mockClientForRequest();
  assert.equal(typeof client.touchActivity, 'function', 'client must expose touchActivity() method');

  // Start request with a 60ms timeout
  let timedOut = false;
  const reqPromise = client.request('session/prompt', { sessionId: 's1', prompt: [] }, 60).catch((err) => {
    timedOut = true;
    throw err;
  });
  assert.equal(client.pending.size, 1);

  const pendingEntry = client.pending.get(1);
  assert.equal(typeof pendingEntry?.refreshTimeout, 'function', 'pending entry must have refreshTimeout callback');

  // At 35ms (before 60ms window expires), touch activity
  await new Promise((r) => setTimeout(r, 35));
  client.touchActivity();

  // At 70ms (total elapsed 70ms > original 60ms timeout), touch activity again
  await new Promise((r) => setTimeout(r, 35));
  client.touchActivity();

  // At 95ms (total elapsed 95ms > original 60ms), request must still be pending and healthy
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(timedOut, false, 'request must not have timed out after 95ms when refreshed at 35ms and 70ms');
  assert.equal(client.pending.size, 1, 'request should remain pending beyond initial timeout window');
  assert.equal(client.closed, false);
  assert.equal(client.isUnhealthy(), false);

  // Fulfill request
  pendingEntry.resolve({ stopReason: 'end_turn' });
  const result = await reqPromise;
  assert.deepEqual(result, { stopReason: 'end_turn' });
});

test('Story 013 AC-2: GrokAcpClient.request does not time out while an onServerRequest permission prompt or AcpTerminalHost command is active', async () => {
  let terminalRunning = false;
  const mockTerminalHost = {
    hasRunningTerminals: () => terminalRunning,
  };
  const client = mockClientForRequest({ terminalHost: mockTerminalHost });

  assert.equal(typeof client.hasActiveWork, 'function', 'client must expose hasActiveWork() method');
  assert.equal(client.activeServerRequests, 0, 'activeServerRequests must initialize to 0');
  assert.equal(client.hasActiveWork(), false);

  // 1. When activeServerRequests > 0, request re-arms timeout instead of failing
  client.activeServerRequests = 1;
  assert.equal(client.hasActiveWork(), true);

  let timedOut1 = false;
  const req1 = client.request('session/prompt', { sessionId: 's1', prompt: [] }, 40).catch((err) => {
    timedOut1 = true;
    throw err;
  });

  // Wait 60ms (> 40ms timeout window)
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(timedOut1, false, 'request must not time out while activeServerRequests > 0');
  assert.equal(client.pending.size, 1, 'request must remain pending while activeServerRequests > 0');
  assert.equal(client.closed, false);

  // Resolve req1 successfully
  const pending1 = client.pending.get(1);
  pending1.resolve({ ok: true });
  await req1;
  client.activeServerRequests = 0;

  // 2. When terminalHost.hasRunningTerminals() is true, request re-arms timeout instead of failing
  terminalRunning = true;
  assert.equal(client.hasActiveWork(), true);

  let timedOut2 = false;
  const req2 = client.request('session/prompt', { sessionId: 's2', prompt: [] }, 40).catch((err) => {
    timedOut2 = true;
    throw err;
  });

  // Wait 60ms (> 40ms timeout window)
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(timedOut2, false, 'request must not time out while terminalHost has running terminals');
  assert.equal(client.pending.size, 1, 'request must remain pending while terminalHost has running terminals');
  assert.equal(client.closed, false);

  // When terminal finishes and active work drops to 0, timeout fires on next expiration
  terminalRunning = false;
  assert.equal(client.hasActiveWork(), false);

  await assert.rejects(
    () => req2,
    (err) => {
      assert.equal(err.code, 'ACP_TIMEOUT');
      return true;
    },
  );
  assert.equal(client.closed, true);
  assert.equal(client.isUnhealthy(), true);
});

test('Story 013 AC-3: AcpTerminalHost.hasRunningTerminals tracks live commands and kill/release safely handle process-group EPERM/ESRCH', async (t) => {
  const host = new AcpTerminalHost({
    defaultCwd: process.cwd(),
    authorizeCreate: async () => true,
  });
  t.after(() => host.disposeAll());

  assert.equal(typeof host.hasRunningTerminals, 'function', 'host must expose hasRunningTerminals() method');
  assert.equal(host.hasRunningTerminals(), false, 'should be false initially');

  const events = [];
  host.onEvent = (type, payload) => events.push({ type, payload });

  // Create a command that emits output and stays alive
  const { terminalId } = await host.create({
    sessionId: 's1',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("hello\\n"); setInterval(()=>{}, 1000);'],
  });

  // Check that running terminals are tracked
  assert.equal(host.hasRunningTerminals(), true, 'should be true while child process is running');

  // Wait for output event
  const deadline = Date.now() + 1500;
  while (events.filter((e) => e.type === 'output').length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const outputEvents = events.filter((e) => e.type === 'output');
  assert.ok(outputEvents.length > 0, 'AcpTerminalHost must emit output events on child stdout/stderr');
  assert.equal(outputEvents[0].payload.terminalId, terminalId);

  // Test safe process-group kill handling: mock process.kill to verify negative pid signal and error swallowing
  const origProcessKill = process.kill;
  let killedNegativePid = null;
  try {
    process.kill = (pid, sig) => {
      if (typeof pid === 'number' && pid < 0) {
        killedNegativePid = pid;
        // Simulate ESRCH or EPERM to verify safe error handling
        const err = new Error('ESRCH: no such process');
        err.code = 'ESRCH';
        throw err;
      }
      return origProcessKill.call(process, pid, sig);
    };

    // kill should catch ESRCH/EPERM and fallback safely without throwing
    await host.kill({ terminalId });
    if (process.platform !== 'win32') {
      assert.ok(killedNegativePid !== null, 'must attempt process.kill with negative pid on POSIX');
    }
  } finally {
    process.kill = origProcessKill;
  }

  // Release terminal
  await host.release({ terminalId });
  assert.equal(host.hasRunningTerminals(), false, 'should be false after terminal release');
});

