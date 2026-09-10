import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
