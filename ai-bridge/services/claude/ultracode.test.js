import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncStream } from '../../utils/async-stream.js';
import { assertUltracodeSupported, applyNativeFlagSettings, createUltracodeQuery, withUltracodeSetting } from './ultracode.js';
import { applyDynamicControls, buildRuntimeSignature, updateBackgroundTaskState } from './runtime-lifecycle.js';
import { __testing } from './persistent-query-service.js';
import { rememberRuntime, canDisposeIdleRuntime } from './runtime-registry.js';
import { createPreToolUseHook } from './permission-mode.js';

function nativeQuery(overrides = {}) {
  return {
    initializationResult: async () => ({ claude_code_version: '2.1.296', models: [{ value: 'opus', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }] }),
    applyFlagSettings: async () => {},
    getSettings: async () => ({ applied: { ultracode: true, ultracodeAvailable: true } }),
    ...overrides,
  };
}

test('Ultracode is an independent native setting, including explicit off', () => {
  const settings = { env: { EXAMPLE: 'kept' }, effortLevel: 'low' };
  assert.deepEqual(withUltracodeSetting(settings, true), { ...settings, ultracode: true });
  assert.deepEqual(withUltracodeSetting({ ...settings, ultracode: true }, false), { ...settings, ultracode: false });
  assert.deepEqual(withUltracodeSetting(settings, undefined), settings);
  assert.equal(buildRuntimeSignature({ model: 'opus', effort: 'low', settings: { ultracode: true } }),
    buildRuntimeSignature({ model: 'opus', effort: 'low', settings: { ultracode: false } }));
});

test('native Ultracode validates actual CLI version, SDK capability and workflow settings', async () => {
  await assertUltracodeSupported(nativeQuery(), { model: 'opus' });
  await assertUltracodeSupported(nativeQuery({ initializationResult: async () => ({ claude_code_version: '2.1.284' }) }));
  for (const version of ['2.1.283', '2.1.203', undefined]) {
    await assert.rejects(assertUltracodeSupported(nativeQuery({ initializationResult: async () => ({ claude_code_version: version }) })), /requires Claude Code 2\.1\.284/);
  }
  await assert.rejects(assertUltracodeSupported({}), /updated Claude Agent SDK/);
  await assert.rejects(assertUltracodeSupported(nativeQuery(), { env: { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' } }), /workflows are disabled/);
});

test('native applied Ultracode is authoritative even when model effort metadata lacks xhigh', async () => {
  for (const effortMetadata of [{ supportedEffortLevels: ['low', 'medium', 'high'] }, { supportsEffort: false }]) {
    const query = nativeQuery({ initializationResult: async () => ({
      claude_code_version: '2.1.296', models: [{ value: 'custom-model', ...effortMetadata }],
    }) });
    await assertUltracodeSupported(query, { model: 'custom-model[1m]' });
    await applyNativeFlagSettings(query, { ultracode: true, effortLevel: 'low' });
  }
});

test('native unavailable Ultracode produces an error instead of silently submitting a normal turn', async () => {
  await assert.rejects(applyNativeFlagSettings(nativeQuery({ getSettings: async () => ({ applied: { ultracode: false, ultracodeAvailable: false } }) }), { ultracode: true }), /unavailable for this session/);
  await assert.rejects(applyNativeFlagSettings(nativeQuery({ getSettings: async () => ({}) }), { ultracode: true }), /could not confirm/);
});

test('one-shot Ultracode validates before submitting user input and closes unsupported runtimes', async () => {
  const stream = new AsyncStream();
  const calls = [];
  const query = nativeQuery({ applyFlagSettings: async settings => calls.push(settings) });
  const message = { type: 'user', message: { role: 'user', content: 'review' } };
  const returned = await createUltracodeQuery(() => query, stream, message, { effort: 'low', settings: { ultracode: true } });
  assert.equal(returned, query);
  assert.deepEqual(calls, [{ ultracode: true }]);
  assert.deepEqual((await stream.next()).value, message);
  assert.equal((await stream.next()).done, true);
  const unsupportedStream = new AsyncStream();
  let closed = false;
  await assert.rejects(createUltracodeQuery(() => ({ close() { closed = true; } }), unsupportedStream, message, {}), /updated Claude Agent SDK/);
  assert.equal(closed, true);
  assert.equal((await unsupportedStream.next()).done, true);
});

test('warm Ultracode toggles preserve native background tasks and effort', async () => {
  const calls = [];
  const runtime = {
    closed: false, currentUltracode: false, currentPermissionMode: 'default', permissionModeState: { value: 'default' },
    currentModel: 'opus', currentResolvedModel: 'opus', currentMaxThinkingTokens: null,
    currentEffort: 'low',
    backgroundTaskIds: new Set(['workflow-1']), readerProgress: 0, cliTurnInFlight: false,
    query: nativeQuery({ applyFlagSettings: async settings => calls.push(settings) }),
  };
  const context = { permissionMode: 'default', sdkModelName: 'opus', resolvedModelId: 'opus', reasoningEffort: 'low', options: { model: 'opus', effort: 'low' } };
  await applyDynamicControls(runtime, { ...context, ultracode: true });
  await applyDynamicControls(runtime, { ...context, ultracode: false });
  assert.deepEqual(calls, [{ ultracode: true }, { ultracode: false }]);
  assert.deepEqual([...runtime.backgroundTaskIds], ['workflow-1']);
  assert.equal(runtime.closed, false);
});

test('a rejected native setting is resynchronized when the user turns Ultracode off', async () => {
  const calls = [];
  const runtime = {
    closed: false, currentUltracode: false, currentEffort: 'low', currentPermissionMode: 'default', permissionModeState: { value: 'default' },
    currentModel: 'opus', currentResolvedModel: 'opus', currentMaxThinkingTokens: null, backgroundTaskIds: new Set(['workflow']),
    query: nativeQuery({ applyFlagSettings: async settings => calls.push(settings),
      getSettings: async () => ({ applied: { ultracode: false, ultracodeAvailable: false } }) }),
  };
  const context = { permissionMode: 'default', sdkModelName: 'opus', resolvedModelId: 'opus', reasoningEffort: 'low', options: { model: 'opus', effort: 'low' } };
  await assert.rejects(applyDynamicControls(runtime, { ...context, ultracode: true }), /unavailable/);
  await applyDynamicControls(runtime, { ...context, ultracode: false });
  assert.deepEqual(calls, [{ ultracode: true }, { model: 'opus', effortLevel: 'low', ultracode: false }]);
  assert.equal(runtime.nativeSettingsUncertain, false);
  assert.equal(runtime.backgroundTaskIds.has('workflow'), true);
});

test('new and reused persistent runtime retain explicit Ultracode settings without relaunch', async () => {
  await __testing.resetState();
  const received = [];
  let launches = 0;
  const output = new AsyncStream();
  __testing.setQueryFn(({ options }) => {
    launches++;
    assert.equal(options.settings.ultracode, true);
    assert.equal(options.effort, 'low');
    return nativeQuery({ next: () => output.next(), close: () => output.done(), applyFlagSettings: async settings => received.push(settings) });
  });
  const context = {
    requestedSessionId: 'toggle-session', runtimeSessionEpoch: 'toggle-epoch', runtimeSignature: 'stable',
    permissionMode: 'default', sdkModelName: 'opus', resolvedModelId: 'opus', ultracode: true,
    options: { model: 'opus', effort: 'low', settings: { ultracode: true } },
  };
  try {
    const runtime = await __testing.acquireRuntime(context);
    runtime.backgroundTaskIds.add('workflow');
    const reused = await __testing.acquireRuntime({ ...context, ultracode: false, options: { ...context.options, settings: { ultracode: false } } });
    assert.equal(reused, runtime);
    assert.equal(launches, 1);
    assert.deepEqual(received, [{ ultracode: true }, { ultracode: false }]);
    assert.equal(reused.backgroundTaskIds.has('workflow'), true);
  } finally {
    await __testing.resetState();
  }
});

test('native model and effort updates preserve workflows and Ultracode in one control request', async () => {
  await __testing.resetState();
  const calls = [];
  const options = { model: 'opus', effort: 'low', settings: { ultracode: true } };
  const runtime = {
    closed: false, sessionId: 'live-flags', runtimeSessionEpoch: 'epoch', runtimeSignature: buildRuntimeSignature(options),
    currentModel: 'opus', currentResolvedModel: 'opus', currentEffort: 'low', currentUltracode: true,
    currentPermissionMode: 'default', permissionModeState: { value: 'default' }, currentMaxThinkingTokens: null,
    createdAt: Date.now(), lastUsedAt: Date.now(), backgroundTaskIds: new Set(['workflow']), inputStream: new AsyncStream(),
    query: nativeQuery({ applyFlagSettings: async settings => calls.push(settings) }),
  };
  rememberRuntime(runtime, { requestedSessionId: runtime.sessionId, runtimeSessionEpoch: 'epoch' });
  const nextOptions = { ...options, model: 'claude-opus-new', effort: 'max' };
  try {
    const acquired = await __testing.acquireRuntime({ requestedSessionId: runtime.sessionId, runtimeSessionEpoch: 'epoch',
      runtimeSignature: buildRuntimeSignature(nextOptions), permissionMode: 'default', sdkModelName: 'claude-opus-new',
      resolvedModelId: 'claude-opus-new', reasoningEffort: 'max', ultracode: true, options: nextOptions });
    assert.equal(acquired, runtime);
    assert.deepEqual(calls, [{ model: 'claude-opus-new', effortLevel: 'max', ultracode: true }]);
    assert.equal(runtime.backgroundTaskIds.has('workflow'), true);
    assert.equal(runtime.currentEffort, 'max');
  } finally {
    await __testing.resetState();
  }
});

test('background task snapshots replace edges, ignore ambient work and survive old-runtime cleanup', () => {
  const runtime = { closed: false, createdAt: 0, lastUsedAt: 0, backgroundTaskIds: new Set(['old-tool']) };
  updateBackgroundTaskState(runtime, { type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'workflow', task_type: 'local_workflow' },
    { task_id: 'watcher', ambient: true },
  ] });
  assert.deepEqual([...runtime.backgroundTaskIds], ['workflow']);
  updateBackgroundTaskState(runtime, { type: 'system', subtype: 'task_started', task_id: 'late-edge' });
  assert.deepEqual([...runtime.backgroundTaskIds], ['workflow']);
  assert.equal(canDisposeIdleRuntime(runtime, Date.now(), 1), false);
  updateBackgroundTaskState(runtime, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(canDisposeIdleRuntime(runtime, Date.now(), 1), true);
});

test('signature-changing sends do not kill live native workflows', async () => {
  await __testing.resetState();
  const runtime = {
    closed: false, sessionId: 'workflow-session', runtimeSessionEpoch: 'epoch', runtimeSignature: 'old',
    createdAt: Date.now(), lastUsedAt: Date.now(), backgroundTaskIds: new Set(['workflow']),
    query: {}, inputStream: new AsyncStream(),
  };
  rememberRuntime(runtime, { requestedSessionId: runtime.sessionId, runtimeSessionEpoch: 'epoch' });
  await assert.rejects(__testing.acquireRuntime({ requestedSessionId: runtime.sessionId, runtimeSessionEpoch: 'epoch', runtimeSignature: 'new' }), /still running background tasks/);
  assert.equal(runtime.closed, false);
  await __testing.resetState();
});

test('targeted stop interrupts only the matching idle session and retires its native tasks', async () => {
  await __testing.resetState();
  const calls = [];
  for (const id of ['first', 'second']) {
    const runtime = { closed: false, sessionId: id, runtimeSessionEpoch: `epoch-${id}`, createdAt: Date.now(), lastUsedAt: Date.now(),
      backgroundTaskIds: new Set(['workflow']), inputStream: new AsyncStream(),
      query: { interrupt: async () => calls.push(`interrupt:${id}`), close: () => calls.push(`close:${id}`) } };
    rememberRuntime(runtime, { requestedSessionId: id, runtimeSessionEpoch: runtime.runtimeSessionEpoch });
  }
  assert.deepEqual(await __testing.abortTurnPersistent({ sessionId: 'first', runtimeSessionEpoch: 'stale' }), { stopped: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(await __testing.abortTurnPersistent({ sessionId: 'first', runtimeSessionEpoch: 'epoch-first' }), { stopped: true });
  assert.deepEqual(calls, ['interrupt:first', 'close:first']);
  assert.equal(__testing.getRuntimeForSession('second').closed, false);
  await __testing.resetState();
});

test('a send arriving during native interrupt waits for the stopped runtime to retire', async () => {
  await __testing.resetState();
  let finishInterrupt;
  const interrupt = new Promise(resolve => { finishInterrupt = resolve; });
  let finishClose;
  const closing = new Promise(resolve => { finishClose = resolve; });
  const order = [];
  const runtime = {
    closed: false, sessionId: 'stop-send', runtimeSessionEpoch: 'epoch', runtimeSignature: 'stable',
    createdAt: Date.now(), lastUsedAt: Date.now(), backgroundTaskIds: new Set(['workflow']), inputStream: new AsyncStream(),
    query: { interrupt: () => interrupt, close: async () => { await closing; order.push('old closed'); } },
  };
  rememberRuntime(runtime, { requestedSessionId: runtime.sessionId, runtimeSessionEpoch: 'epoch' });
  const output = new AsyncStream();
  __testing.setQueryFn(() => {
    order.push('new created');
    return { next: () => output.next(), close: () => output.done() };
  });
  try {
    const stop = __testing.abortTurnPersistent({ sessionId: 'stop-send', runtimeSessionEpoch: 'epoch' });
    const acquire = __testing.acquireRuntime({ requestedSessionId: 'stop-send', runtimeSessionEpoch: 'epoch', runtimeSignature: 'stable',
      permissionMode: 'default', sdkModelName: 'opus', resolvedModelId: 'opus', options: { model: 'opus', settings: { ultracode: false } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, []);
    finishInterrupt();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, []);
    finishClose();
    await stop;
    assert.notEqual(await acquire, runtime);
    assert.deepEqual(order, ['old closed', 'new created']);
  } finally {
    finishInterrupt();
    finishClose();
    await __testing.resetState();
  }
});

test('Workflow preserves native plan/auto checks and explicit execution approvals', async () => {
  for (const mode of ['plan', 'auto']) {
    assert.deepEqual(await createPreToolUseHook({ value: mode }, '/workspace')({ tool_name: 'Workflow' }), { continue: true });
  }
  for (const mode of ['default', 'acceptEdits']) {
    assert.equal((await createPreToolUseHook({ value: mode }, '/workspace')({ tool_name: 'Workflow' })).hookSpecificOutput.permissionDecision, 'ask');
  }
});
