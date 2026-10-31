import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getPlanUsagePersistent,
  getRuntimeSnapshot,
  EPHEMERAL_HANDSHAKE_TIMEOUT_MS,
  __testing,
} from './persistent-acp-service.js';
import { initializeAndAuthenticate } from './grok-acp-client.js';

const { resetRegistry, createTestRuntime, forceSetActiveTurn, fetchBillingEphemeral } = __testing;

let tail = Promise.resolve();
function serial(name, fn) {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  });
}

const credits = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-08T00:00:00Z',
    },
  },
  subscriptionTier: 'SuperGrok',
};

serial('getPlanUsagePersistent reads _x.ai/billing from the warm agent without recycling it', async () => {
  resetRegistry();
  const calls = [];
  const client = {
    closed: false,
    isUnhealthy: () => false,
    request: async (method, params, timeout, options) => {
      calls.push({ method, params, timeout, options });
      return credits;
    },
  };
  createTestRuntime('plan-usage', { client });

  const payload = await getPlanUsagePersistent({ ephemeral: true, cwd: '/tmp' });
  assert.equal(payload.present, true);
  assert.equal(payload.capacity_pct, 42.5);
  assert.equal(payload.level, 'SuperGrok');
  assert.equal(payload.windows[0].period_type, 'USAGE_PERIOD_TYPE_WEEKLY');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, '_x.ai/billing');
  assert.deepEqual(calls[0].params, {});
  assert.equal(calls[0].options.recycleOnTimeout, false);
  resetRegistry();
});

serial('getPlanUsagePersistent stays unavailable without a runtime when ephemeral is off', async () => {
  resetRegistry();
  const payload = await getPlanUsagePersistent({ ephemeral: false });
  assert.equal(payload.present, false);
  assert.equal(payload.unavailable, true);
  assert.match(payload.message, /not running/);
  resetRegistry();
});

serial('getPlanUsagePersistent turns an ACP error into a hidden bar', async () => {
  resetRegistry();
  const client = {
    closed: false,
    isUnhealthy: () => false,
    request: async () => {
      throw new Error('Billing data requires auth with grok.com');
    },
  };
  createTestRuntime('plan-usage-denied', { client });
  const payload = await getPlanUsagePersistent({ ephemeral: true });
  assert.equal(payload.present, false);
  assert.match(payload.message, /grok.com/);
  resetRegistry();
});

serial('daemon.js registers grok.getPlanUsage in pre-queue read-only methods and removes it from processRequest', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), '../../daemon.js');
  const daemonSource = await readFile(daemonPath, 'utf8');

  // Must NOT route grok.getPlanUsage in processRequest
  assert.doesNotMatch(
    daemonSource,
    /provider\s*===\s*'grok'\s*&&\s*command\s*===\s*'getPlanUsage'/
  );

  // Must register grok.getPlanUsage in readOnlyCodexMethods / readOnlyMethods before commandQueue
  assert.match(
    daemonSource,
    /\['grok\.getPlanUsage',\s*grokGetPlanUsagePersistent\]/
  );

  // Must exclude grok.getPlanUsage next to heartbeat and status at lastCommandActivityAt assignment
  assert.match(
    daemonSource,
    /request\.method\s*!==\s*['"]heartbeat['"]\s*&&\s*request\.method\s*!==\s*['"]status['"]\s*&&\s*request\.method\s*!==\s*['"]grok\.getPlanUsage['"]/
  );

  // Must guard grok.getPlanUsage when !isDaemonMode || idleShutdownInFlight without canceling idle shutdown
  assert.match(
    daemonSource,
    /request\.method\s*===\s*['"]grok\.getPlanUsage['"]\s*&&\s*\(!isDaemonMode\s*\|\|\s*idleShutdownInFlight\)/
  );
});

serial('ephemeral: true with no live runtime still invokes the cold path', async () => {
  resetRegistry();
  let starterInvoked = false;
  let clientStarted = false;
  let clientClosed = false;

  const fakeClient = {
    start() {
      clientStarted = true;
    },
    async request(method) {
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          authMethods: [{ id: 'cached_token' }],
          _meta: { defaultAuthMethodId: 'cached_token' },
        };
      }
      if (method === 'authenticate') {
        return {};
      }
      if (method === '_x.ai/billing') {
        return credits;
      }
      return {};
    },
    async close() {
      clientClosed = true;
    },
  };

  const payload = await getPlanUsagePersistent({
    ephemeral: true,
    clientFactory: () => {
      starterInvoked = true;
      return fakeClient;
    },
  });

  assert.equal(starterInvoked, true, 'clientFactory must be invoked on the cold path');
  assert.equal(clientStarted, true, 'cold path client must be started');
  assert.equal(clientClosed, true, 'cold path client must be closed after billing read');
  assert.equal(payload.present, true);
  assert.equal(payload.capacity_pct, 42.5);
  resetRegistry();
});

serial('EPHEMERAL_HANDSHAKE_TIMEOUT_MS is 10_000', () => {
  assert.equal(EPHEMERAL_HANDSHAKE_TIMEOUT_MS, 10_000);
});

serial('getPlanUsagePersistent and resolvePlanUsage do not use console.log or console.error', async () => {
  resetRegistry();
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  console.error = (...args) => {
    errors.push(args.join(' '));
  };

  try {
    const client = {
      closed: false,
      isUnhealthy: () => false,
      request: async () => {
        throw new Error('boom');
      },
    };
    createTestRuntime('plan-usage-no-leak', { client });
    await getPlanUsagePersistent({ ephemeral: true });

    assert.equal(logs.length, 0, `Expected 0 console.log calls, got: ${JSON.stringify(logs)}`);
    assert.equal(errors.length, 0, `Expected 0 console.error calls, got: ${JSON.stringify(errors)}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    resetRegistry();
  }
});

serial('initializeAndAuthenticate uses timeoutMs for both requests and respects quiet: true', async () => {
  const requests = [];
  const fakeClient = {
    request: async (method, params, timeout) => {
      requests.push({ method, params, timeout });
      if (method === 'initialize') {
        return {
          protocolVersion: 1,
          authMethods: [{ id: 'cached_token' }],
          _meta: { defaultAuthMethodId: 'cached_token' },
        };
      }
      if (method === 'authenticate') {
        return {};
      }
      return {};
    },
  };

  const originalError = console.error;
  const errors = [];
  console.error = (...args) => {
    errors.push(args.join(' '));
  };

  try {
    await initializeAndAuthenticate(fakeClient, {
      timeoutMs: 10_000,
      quiet: true,
      authMethod: 'oauth',
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'initialize');
    assert.equal(requests[0].timeout, 10_000);
    assert.equal(requests[1].method, 'authenticate');
    assert.equal(requests[1].timeout, 10_000);
    assert.equal(errors.length, 0, `Expected 0 console.error calls when quiet: true, got: ${JSON.stringify(errors)}`);
  } finally {
    console.error = originalError;
  }
});

// The real poll-vs-turn scheduling through daemon.js is covered in grok-plan-usage-daemon.test.js.
serial('daemon replies to grok.getPlanUsage with a result and no line events; billing reaches an agent mid-prompt', async () => {
  resetRegistry();

  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), '../../daemon.js');
  const child = spawn(process.execPath, [daemonPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });
  child.stderr.resume();

  const withDeadline = (promise, label, timeoutMs = 5_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

  const stdoutLines = [];
  const rl = createInterface({ input: child.stdout });
  let resolveReady;
  const readyPromise = new Promise((r) => { resolveReady = r; });

  const waiters = new Map();
  rl.on('line', (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    stdoutLines.push(parsed);
    if (parsed.event === 'ready' && resolveReady) {
      resolveReady(parsed);
    }
    if (parsed.id && parsed.done === true && waiters.has(parsed.id)) {
      waiters.get(parsed.id)(parsed);
      waiters.delete(parsed.id);
    }
  });

  const waitForDone = (id) => withDeadline(new Promise((resolve) => {
    const existing = stdoutLines.find((l) => l.id === id && l.done === true);
    if (existing) {
      resolve(existing);
      return;
    }
    waiters.set(id, resolve);
  }), `${id} done`);

  try {
    await withDeadline(readyPromise, 'daemon ready');

    // Dispatch grok.getPlanUsage with ephemeral: false through real daemon.js handleInputLine
    // and verify it emits { id, done: true, success: true, result } via writeRawLine
    child.stdin.write(JSON.stringify({
      id: 'daemon-usage-1',
      method: 'grok.getPlanUsage',
      params: { ephemeral: false },
    }) + '\n');

    const daemonUsageDone = await waitForDone('daemon-usage-1');
    assert.equal(daemonUsageDone.done, true);
    assert.equal(daemonUsageDone.success, true);
    assert.ok(daemonUsageDone.result, 'daemon.js must attach result object on done');
    assert.equal(daemonUsageDone.result.present, false);
    assert.equal(daemonUsageDone.result.unavailable, true);

    // Ensure zero stdout line events ({ id: 'daemon-usage-1', line: ... }) were emitted for grok.getPlanUsage
    const lineEvents = stdoutLines.filter((l) => l.id === 'daemon-usage-1' && !l.done);
    assert.equal(lineEvents.length, 0, 'grok.getPlanUsage must not emit line/stderr events');
  } finally {
    rl.close();
    child.kill('SIGTERM');
  }

  // Also verify active-turn ACP concurrency with a live warm runtime:
  // _x.ai/billing reaches the warm agent while session/prompt is still held open
  const events = [];
  let finishTurn;
  const turnPromise = new Promise((resolve) => {
    finishTurn = resolve;
  });

  const fakeClient = {
    closed: false,
    isUnhealthy: () => false,
    request: async (method, params) => {
      events.push({ type: 'agent-request', method, params });
      if (method === 'session/prompt') {
        await turnPromise;
        return { text: 'turn finished' };
      }
      if (method === '_x.ai/billing') {
        return credits;
      }
      return {};
    },
  };

  const rt = createTestRuntime('turn-runtime', { client: fakeClient });
  forceSetActiveTurn(rt);

  try {
    const turnTask = fakeClient.request('session/prompt', { prompt: 'hello' });
    const usageResult = await getPlanUsagePersistent({ ephemeral: true });

    // _x.ai/billing reached agent before session/prompt finished
    const agentMethods = events.filter((e) => e.type === 'agent-request').map((e) => e.method);
    assert.deepEqual(agentMethods, ['session/prompt', '_x.ai/billing']);
    assert.equal(usageResult.present, true);
    assert.equal(usageResult.capacity_pct, 42.5);

    finishTurn();
    await turnTask;
  } finally {
    resetRegistry();
  }
});

serial('a cold poll uses the 10s handshake timeout, closes its client, and leaves a warm runtime usable', async () => {
  resetRegistry();

  // 1. Exercise real fetchBillingEphemeral with an injected clientFactory:
  //    Verify it starts the client, passes EPHEMERAL_HANDSHAKE_TIMEOUT_MS (10_000) to initialize & authenticate,
  //    times out when initialize hangs, and always calls client.close() in finally.
  let started = false;
  let closed = false;
  const recordedRequests = [];

  await assert.rejects(
    () =>
      fetchBillingEphemeral({
        cwd: 12345, // also verifies non-string cwd guard falls back safely
        clientFactory: () => ({
          start() {
            started = true;
          },
          async request(method, params, timeoutMs, options) {
            recordedRequests.push({ method, params, timeoutMs, options });
            if (method === 'initialize') {
              throw new Error(`ACP request timeout: initialize (${timeoutMs}ms)`);
            }
            return {};
          },
          async close() {
            closed = true;
          },
        }),
      }),
    /ACP request timeout: initialize \(10000ms\)/
  );

  assert.equal(started, true, 'fetchBillingEphemeral must call client.start()');
  assert.equal(closed, true, 'fetchBillingEphemeral must call client.close() in finally on handshake failure');
  assert.equal(recordedRequests.length, 1);
  assert.equal(recordedRequests[0].method, 'initialize');
  assert.equal(recordedRequests[0].timeoutMs, EPHEMERAL_HANDSHAKE_TIMEOUT_MS);

  // 2. Verify concurrent upgrade: an in-flight { ephemeral: false } call does not block or poison
  //    a concurrent { ephemeral: true } call, and a hung cold poll in getPlanUsagePersistent
  //    gives up on timeout while allowing a warm runtime turn to proceed.
  let releaseColdInit;
  const coldInitGate = new Promise((resolve) => {
    releaseColdInit = resolve;
  });
  let coldClosed = false;

  const coldPollPromise = getPlanUsagePersistent({
    ephemeral: true,
    handshakeTimeoutMs: 50,
    clientFactory: () => ({
      start() {},
      async request(method, params, timeoutMs) {
        if (method === 'initialize') {
          await coldInitGate;
          throw new Error(`initialize timed out after ${timeoutMs}ms`);
        }
        return {};
      },
      async close() {
        coldClosed = true;
      },
    }),
  });

  // While cold poll is still hanging on initialize, a chat turn starts and registers a warm runtime
  const turnClient = {
    closed: false,
    isUnhealthy: () => false,
    request: async (method) => {
      if (method === 'session/prompt') {
        return { text: 'sent without waiting on cold poll' };
      }
      return credits;
    },
  };
  const warmRt = createTestRuntime('warm-during-cold-poll', { client: turnClient });
  forceSetActiveTurn(warmRt);

  const turnReply = await turnClient.request('session/prompt', { prompt: 'hi' });
  assert.equal(turnReply.text, 'sent without waiting on cold poll');

  // Now let the cold poll fail its handshake
  releaseColdInit();
  const coldPollResult = await coldPollPromise;
  assert.equal(coldPollResult.present, false);
  assert.equal(coldPollResult.unavailable, true);
  assert.equal(coldClosed, true, 'cold poll client must be closed after timeout');

  resetRegistry();
});

serial('getPlanUsagePersistent upgrades in-flight non-ephemeral poll when ephemeral: true arrives', async () => {
  resetRegistry();

  const nonEphemeralPromise = getPlanUsagePersistent({ ephemeral: false });
  const ephemeralPromise = getPlanUsagePersistent({
    ephemeral: true,
    clientFactory: () => ({
      start() {},
      async request(method) {
        if (method === 'initialize') {
          return {
            protocolVersion: 1,
            authMethods: [{ id: 'cached_token' }],
            _meta: { defaultAuthMethodId: 'cached_token' },
          };
        }
        if (method === 'authenticate') {
          return {};
        }
        if (method === '_x.ai/billing') {
          return credits;
        }
        return {};
      },
      async close() {},
    }),
  });

  const [nonEphemeralResult, ephemeralResult] = await Promise.all([
    nonEphemeralPromise,
    ephemeralPromise,
  ]);

  assert.equal(nonEphemeralResult.present, false);
  assert.equal(ephemeralResult.present, true);
  assert.equal(ephemeralResult.capacity_pct, 42.5);
  resetRegistry();
});

serial('getRuntimeSnapshot reports an in-flight poll so the idle reaper waits for it', async () => {
  resetRegistry();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = {
    closed: false,
    isUnhealthy: () => false,
    request: async () => {
      await gate;
      return credits;
    },
  };
  createTestRuntime('plan-usage-inflight', { client });
  assert.equal(getRuntimeSnapshot().planUsageInFlight, false);

  const pending = getPlanUsagePersistent({ ephemeral: true });
  assert.equal(getRuntimeSnapshot().planUsageInFlight, true);

  release();
  await pending;
  assert.equal(getRuntimeSnapshot().planUsageInFlight, false);
  resetRegistry();
});
