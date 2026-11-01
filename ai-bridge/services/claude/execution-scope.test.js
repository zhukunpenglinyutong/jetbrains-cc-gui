import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireRuntime, disposeRuntime, setCachedQueryFn, resetCachedQueryFn } from './runtime-lifecycle.js';
import { resetRegistryState } from './runtime-registry.js';
import { currentExecutionScope, withExecutionScope } from '../../utils/execution-scope.js';

test('reused Claude query callbacks use their own current turn and suppress inter-turn inheritance', async () => {
  resetRegistryState();
  let options;
  let finishReader;
  setCachedQueryFn(input => {
    options = input.options;
    return {
      next() { return new Promise(resolve => { finishReader = () => resolve({ done: true }); }); },
      [Symbol.asyncIterator]() { return this; },
      close() { finishReader?.(); },
    };
  });
  let runtime;
  try {
    runtime = await acquireRuntime({
      requestedSessionId: 'scope-test', runtimeSessionEpoch: randomUUID(), runtimeSignature: randomUUID(),
      sdkModelName: 'claude-sonnet-5', modelId: 'claude-sonnet-5', permissionMode: 'default',
      options: { cwd: process.cwd(), canUseTool: async () => currentExecutionScope() },
    }, {});
    const first = `${randomUUID()}/${randomUUID()}`;
    const second = `${randomUUID()}/${randomUUID()}`;
    runtime.permissionModeState.executionScope = first;
    assert.equal(await options.canUseTool('Bash', {}), first);
    runtime.permissionModeState.executionScope = second;
    assert.equal(await options.canUseTool('Bash', {}), second);
    runtime.permissionModeState.executionScope = '';
    await withExecutionScope(first, async () => assert.equal(await options.canUseTool('Bash', {}), ''));
    assert.equal(currentExecutionScope(), '');
  } finally {
    await disposeRuntime(runtime, {});
    resetCachedQueryFn();
    resetRegistryState();
  }
});
