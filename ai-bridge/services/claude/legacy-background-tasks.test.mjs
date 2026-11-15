import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing, sendMessagePersistent } from './persistent-query-service.js';
import { updateBackgroundTaskState } from './runtime-lifecycle.js';
import { canDisposeIdleRuntime, RUNTIME_MAX_ABSOLUTE_LIFETIME_MS } from './runtime-registry.js';
import { createScriptedQuery, RESULT_OK, settleReader } from './testing/scripted-query.js';

test.afterEach(async () => __testing.resetState());

test('a legacy dev server stays visible between turns and can be stopped before applying new effort', async () => {
  const events = [];
  const previousWrite = process.stdout._originalStdoutWrite;
  process.stdout._originalStdoutWrite = line => { events.push(JSON.parse(line)); return true; };
  const queries = [];
  const params = { sessionId: 'legacy-server', runtimeSessionEpoch: 'legacy-epoch', message: 'start dev server',
    cwd: process.cwd(), model: 'opus', reasoningEffort: 'high' };
  const task = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-dev', name: 'Bash',
    input: { command: 'npm run dev', description: 'Start local development server', run_in_background: true } }] } };
  __testing.setQueryFn(args => {
    const query = createScriptedQuery(args, [[...(queries.length ? [] : [task]), RESULT_OK]]);
    query.initializationResult = async () => ({ claude_code_version: '2.1.200' });
    query.interrupt = async () => {};
    queries.push(query);
    return query;
  });
  try {
    assert.deepEqual(await sendMessagePersistent(params), { outcome: 'completed' });
    await settleReader();
    const snapshot = events.find(event => event.taskEvent?.source === 'legacy');
    assert.equal(snapshot.sessionId, params.sessionId);
    assert.equal(snapshot.runtimeSessionEpoch, params.runtimeSessionEpoch);
    assert.deepEqual(snapshot.taskEvent.tasks, [{ task_id: 'tool-dev', task_type: 'legacy_task', description: 'Start local development server' }]);
    const runtime = __testing.getRuntimeForSession(params.sessionId);
    assert.equal(runtime.hasBackgroundTaskSnapshot, undefined, 'derived UI state cannot disable the legacy lifetime limit');
    const changed = { ...params, reasoningEffort: 'max', message: 'continue at max effort' };
    assert.match((await sendMessagePersistent(changed)).error, /still running background tasks/);
    assert.equal(queries.length, 1, 'settings must not silently kill the server');
    assert.deepEqual(await __testing.abortTurnPersistent(params), { stopped: true });
    assert.deepEqual(events.at(-1).taskEvent.tasks, []);
    assert.equal(events.at(-1).taskEvent.source, 'legacy');
    assert.deepEqual(await sendMessagePersistent(changed), { outcome: 'completed' });
    assert.equal(queries.length, 2);
    assert.equal(queries[1].options.effort, 'max');
  } finally {
    process.stdout._originalStdoutWrite = previousWrite;
  }
});

test('legacy task aliases produce one visible task and terminal edges clear it', () => {
  const runtime = { sessionId: 'legacy', createdAt: 0, lastUsedAt: 0 };
  let snapshot = updateBackgroundTaskState(runtime, { type: 'system', subtype: 'task_started', task_id: 'native-task', description: 'Agent' });
  assert.equal(snapshot.tasks.length, 1);
  snapshot = updateBackgroundTaskState(runtime, { type: 'system', subtype: 'task_started', task_id: 'native-task', tool_use_id: 'tool-agent', description: 'Review files' });
  assert.deepEqual(snapshot.tasks, [{ task_id: 'tool-agent', task_type: 'legacy_task', description: 'Review files' }]);
  assert.equal(canDisposeIdleRuntime(runtime, RUNTIME_MAX_ABSOLUTE_LIFETIME_MS + 1, 1000), true);
  assert.equal(updateBackgroundTaskState(runtime, { type: 'system', subtype: 'task_progress', task_id: 'native-task' }), undefined);
  snapshot = updateBackgroundTaskState(runtime, { type: 'system', subtype: 'task_notification', task_id: 'native-task', status: 'completed' });
  assert.deepEqual(snapshot.tasks, []);
  assert.equal(runtime.backgroundTaskIds.size, 0);
});

test('native snapshots supersede legacy UI state and late edges never reconstruct them', () => {
  const runtime = { sessionId: 'mixed' };
  assert.equal(updateBackgroundTaskState(runtime, { type: 'system', subtype: 'task_started', task_id: 'legacy' }).source, 'legacy');
  assert.equal(updateBackgroundTaskState(runtime, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'workflow' }] }), undefined);
  assert.equal(updateBackgroundTaskState(runtime, { type: 'system', subtype: 'task_started', task_id: 'late' }), undefined);
  assert.deepEqual([...runtime.backgroundTaskIds], ['workflow']);
  updateBackgroundTaskState(runtime, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(updateBackgroundTaskState(runtime, { type: 'system', subtype: 'task_started', task_id: 'later' }), undefined);
  assert.deepEqual([...runtime.backgroundTaskIds], []);
});

test('legacy completion XML clears the panel through the perpetual reader after the foreground result', async () => {
  const events = [];
  const previousWrite = process.stdout._originalStdoutWrite;
  process.stdout._originalStdoutWrite = line => { events.push(JSON.parse(line)); return true; };
  let query;
  __testing.setQueryFn(args => (query = createScriptedQuery(args, [[
    { type: 'system', subtype: 'task_started', task_id: 'task', tool_use_id: 'tool', description: 'Review' }, RESULT_OK,
  ]])));
  try {
    assert.deepEqual(await sendMessagePersistent({ sessionId: 'xml', runtimeSessionEpoch: 'epoch', message: 'review' }), { outcome: 'completed' });
    query.channel.enqueue({ type: 'user', message: { content: '<task-notification><task-id>task</task-id><tool-use-id>tool</tool-use-id><status>completed</status><summary>Done</summary></task-notification>' } });
    await settleReader();
    const snapshots = events.filter(event => event.taskEvent?.source === 'legacy');
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].taskEvent.tasks.length, 1);
    assert.deepEqual(snapshots[1].taskEvent.tasks, []);
    assert.equal(snapshots[1].runtimeSessionEpoch, 'epoch');
  } finally {
    process.stdout._originalStdoutWrite = previousWrite;
  }
});
