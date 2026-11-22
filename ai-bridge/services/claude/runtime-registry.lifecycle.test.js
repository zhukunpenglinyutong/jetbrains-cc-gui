import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_MAX_ABSOLUTE_LIFETIME_MS,
  RUNTIME_STUCK_SILENCE_MS,
  SESSION_RUNTIME_MAX_IDLE_MS,
  canDisposeIdleRuntime,
  cleanupStaleAnonymousRuntimes,
  cleanupStaleSessionRuntimes,
  rememberRuntime,
  resetRegistryState,
} from './runtime-registry.js';
import { updateBackgroundTaskState } from './runtime-lifecycle.js';

function staleRuntime(overrides = {}) {
  const old = Date.now() - 10 * 60 * 1000;
  return {
    closed: false,
    createdAt: old,
    lastUsedAt: old,
    activeTurnCount: 0,
    cliTurnInFlight: false,
    backgroundTaskIds: new Set(),
    ...overrides,
  };
}

test.afterEach(() => resetRegistryState());

test('cleanup reaps both anonymous and session runtimes', async () => {
  const anonymous = staleRuntime();
  const session = staleRuntime({ sessionId: 'session-1' });
  rememberRuntime(anonymous, { runtimeSignature: 'anonymous' });
  rememberRuntime(session, { requestedSessionId: 'session-1' });

  const disposed = [];
  await cleanupStaleAnonymousRuntimes(async (runtime) => disposed.push(runtime));
  await cleanupStaleSessionRuntimes(async (runtime) => disposed.push(runtime));

  assert.deepEqual(new Set(disposed), new Set([anonymous, session]));
});

test('cleanup preserves active turns and CLI output still in flight', async () => {
  const activeTurn = staleRuntime({ activeTurnCount: 1 });
  const cliBusy = staleRuntime({ cliTurnInFlight: true });
  rememberRuntime(activeTurn, { runtimeSignature: 'active-turn' });
  rememberRuntime(cliBusy, { runtimeSignature: 'cli-busy' });

  const disposed = [];
  await cleanupStaleAnonymousRuntimes(async (runtime) => disposed.push(runtime));

  assert.deepEqual(disposed, []);
});

test('background Agent protects runtime until its terminal notification', async () => {
  const runtime = staleRuntime();
  rememberRuntime(runtime, { runtimeSignature: 'background-agent' });

  updateBackgroundTaskState(runtime, {
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Agent',
        input: { run_in_background: true },
      }],
    },
  });

  const disposed = [];
  await cleanupStaleAnonymousRuntimes(async (item) => disposed.push(item));
  assert.deepEqual(disposed, []);

  updateBackgroundTaskState(runtime, {
    type: 'system',
    subtype: 'task_notification',
    tool_use_id: 'tool-1',
    status: 'completed',
  });
  await cleanupStaleAnonymousRuntimes(async (item) => disposed.push(item));

  assert.deepEqual(disposed, [runtime]);
});

function oldRuntime(overrides = {}) {
  const now = Date.now();
  return staleRuntime({
    createdAt: now - RUNTIME_MAX_ABSOLUTE_LIFETIME_MS - 60 * 1000,
    lastUsedAt: now - SESSION_RUNTIME_MAX_IDLE_MS - 60 * 1000,
    ...overrides,
  });
}

async function sweepAsAnonymousAndSession(makeRuntime) {
  const anonymous = makeRuntime();
  const session = makeRuntime();
  session.sessionId = 'session-old';
  rememberRuntime(anonymous, { runtimeSignature: 'anonymous-old' });
  rememberRuntime(session, { requestedSessionId: 'session-old' });

  const disposed = [];
  await cleanupStaleAnonymousRuntimes(async (runtime) => disposed.push(runtime));
  await cleanupStaleSessionRuntimes(async (runtime) => disposed.push(runtime));
  return { anonymous, session, disposed };
}

test('runtime past the absolute lifetime is not disposable while a turn, CLI output and a background task are active', () => {
  const now = Date.now();
  const runtime = {
    closed: false,
    createdAt: now - RUNTIME_MAX_ABSOLUTE_LIFETIME_MS - 1,
    lastUsedAt: now,
    activeTurnCount: 1,
    cliTurnInFlight: true,
    backgroundTaskIds: new Set(['running-task']),
  };

  assert.equal(canDisposeIdleRuntime(runtime, now, 60_000), false);
});

for (const [name, overrides] of [
  ['an active turn', { activeTurnCount: 1 }],
  ['CLI output in flight', { cliTurnInFlight: true }],
  ['a tracked background task', { backgroundTaskIds: new Set(['task-1']) }],
]) {
  test(`cleanup keeps anonymous and session runtimes past the absolute lifetime while they have ${name}`, async () => {
    const { disposed } = await sweepAsAnonymousAndSession(() => oldRuntime(overrides));

    assert.deepEqual(disposed, []);
  });
}

test('cleanup reaps idle anonymous and session runtimes past the absolute lifetime', async () => {
  const { anonymous, session, disposed } = await sweepAsAnonymousAndSession(() => oldRuntime());

  assert.deepEqual(new Set(disposed), new Set([anonymous, session]));
});

test('cleanup reaps busy runtimes past the absolute lifetime that have been silent beyond the stuck threshold', async () => {
  const { anonymous, session, disposed } = await sweepAsAnonymousAndSession(() => oldRuntime({
    activeTurnCount: 1,
    cliTurnInFlight: true,
    backgroundTaskIds: new Set(['leaked-task']),
    lastUsedAt: Date.now() - RUNTIME_STUCK_SILENCE_MS - 60 * 1000,
  }));

  assert.deepEqual(new Set(disposed), new Set([anonymous, session]));
});

test('cleanup keeps busy runtimes past the absolute lifetime that are silent for less than the stuck threshold', async () => {
  const { disposed } = await sweepAsAnonymousAndSession(() => oldRuntime({
    activeTurnCount: 1,
    lastUsedAt: Date.now() - RUNTIME_STUCK_SILENCE_MS + 60 * 1000,
  }));

  assert.deepEqual(disposed, []);
});

test('a leaked legacy task edge is reaped once stuck, while live snapshots and pending Stops are kept', async () => {
  const createdAt = Date.now() - RUNTIME_MAX_ABSOLUTE_LIFETIME_MS - 1000;
  const lastUsedAt = Date.now() - RUNTIME_STUCK_SILENCE_MS - 1000;
  const legacy = staleRuntime({ createdAt, lastUsedAt, backgroundTaskIds: new Set(['lost-terminal-edge']) });
  const streaming = staleRuntime({ createdAt, backgroundTaskIds: new Set(['still-writing']) });
  const stopping = staleRuntime({ createdAt, lastUsedAt, abortPromise: new Promise(() => {}) });
  const authoritative = staleRuntime({ createdAt });
  updateBackgroundTaskState(authoritative, {
    type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'long-workflow', task_type: 'local_workflow' }],
  });
  for (const [signature, runtime] of Object.entries({ legacy, streaming, stopping, authoritative })) {
    rememberRuntime(runtime, { runtimeSignature: signature });
  }
  const disposed = [];
  await cleanupStaleAnonymousRuntimes(async runtime => disposed.push(runtime));
  assert.deepEqual(disposed, [legacy]);

  // An authoritative empty snapshot releases the old runtime at the idle limit.
  updateBackgroundTaskState(authoritative, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  legacy.closed = true;
  await cleanupStaleAnonymousRuntimes(async runtime => disposed.push(runtime));
  assert.deepEqual(disposed, [legacy, authoritative]);
});
