import assert from 'node:assert/strict';
import test from 'node:test';
import { readNativeSubagent } from './codex-native-subagents.js';

function fixture({ parent = 'root', status = 'idle', turnStatus = 'completed', turnId = 'turn' } = {}) {
  const calls = [];
  const read = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, parentThreadId: parent, status: { type: status } } };
    if (method === 'thread/turns/list') return { data: [{ id: turnId, status: turnStatus, itemsView: 'full',
      items: [{ id: 'reason', type: 'reasoning', summary: ['child thinks'] },
        { id: 'command', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/fixture' }] }], nextCursor: null };
    throw new Error(`Unexpected method ${method}`);
  };
  return { read, calls };
}

test('verified child history shows tools and thinking without resuming a writer', async () => {
  const { read, calls } = fixture();
  const result = await readNativeSubagent(read, { rootThreadId: 'root', agentId: 'child', includeHistory: true });
  assert.equal(result.completed, true);
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0].raw.message.content[0].thinking, 'child thinks');
  assert.equal(result.messages[1].raw.codexThreadId, 'child');
  assert.ok(calls.every(({ method }) => ['thread/read', 'thread/turns/list'].includes(method)));
});

test('active child is running even if its most recent persisted turn completed', async () => {
  const { read } = fixture({ status: 'active' });
  const result = await readNativeSubagent(read, { rootThreadId: 'root', agentId: 'child' });
  assert.equal(result.status, 'running');
  assert.equal(result.completed, false);
  assert.equal(result.messages, undefined);
});

test('a followup keeps excluding the proven prior completed turn across repeated reads', async () => {
  const { read } = fixture({ turnId: 'previous-turn' });
  let nativeTaskPreviousTurnId = 'previous-turn';
  for (let poll = 0; poll < 2; poll += 1) {
    const result = await readNativeSubagent(read, { rootThreadId: 'root', agentId: 'child',
      includeHistory: true, nativeTaskPreviousTurnId });
    assert.equal(result.latestTurnId, 'previous-turn');
    assert.equal(result.status, 'running');
    assert.equal(result.completed, false);
    assert.deepEqual(result.messages, []);
    assert.equal(result.nativeTaskPreviousTurnId, 'previous-turn');
    nativeTaskPreviousTurnId = result.nativeTaskPreviousTurnId;
  }
});

test('a followup does not inherit an earlier failed or interrupted native turn', async () => {
  for (const turnStatus of ['failed', 'interrupted']) {
    const { read } = fixture({ turnId: 'previous-turn', turnStatus });
    const result = await readNativeSubagent(read, { rootThreadId: 'root', agentId: 'child',
      includeHistory: true, nativeTaskPreviousTurnId: 'previous-turn' });
    assert.equal(result.status, 'running');
    assert.equal(result.completed, false);
    assert.deepEqual(result.messages, []);
    assert.equal(result.nativeTaskPreviousTurnId, 'previous-turn');
  }
});

test('a different completed turn clears the prior baseline even when its id is UUIDv4', async () => {
  const { read } = fixture({ turnId: 'df06a20e-9726-421a-9b3d-cef0611bab77' });
  const result = await readNativeSubagent(read, { rootThreadId: 'root', agentId: 'child',
    includeHistory: true, nativeTaskPreviousTurnId: 'previous-turn' });
  assert.equal(result.completed, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.latestTurnId, 'df06a20e-9726-421a-9b3d-cef0611bab77');
  assert.equal(result.nativeTaskPreviousTurnId, null);
  assert.equal(result.messages.length, 3);
});

test('a followup steered into a running turn accepts that same turn when it completes', async () => {
  const first = fixture({ status: 'active', turnStatus: 'inProgress', turnId: 'steered-turn' });
  const running = await readNativeSubagent(first.read, { rootThreadId: 'root', agentId: 'child' });
  assert.equal(running.completed, false);
  const final = fixture({ turnId: 'steered-turn' });
  const result = await readNativeSubagent(final.read, { rootThreadId: 'root', agentId: 'child', includeHistory: true,
    nativeTaskPreviousTurnId: running.nativeTaskPreviousTurnId });
  assert.equal(result.latestTurnId, 'steered-turn');
  assert.equal(result.completed, true);
  assert.equal(result.messages.length, 3);
});

test('unrelated and cyclic children are rejected before reading turns', async () => {
  for (const parent of [null, 'child']) {
    const { read, calls } = fixture({ parent });
    await assert.rejects(readNativeSubagent(read, { rootThreadId: 'root', agentId: 'child' }), /requested root|cyclic/);
    assert.ok(calls.every(({ method }) => method === 'thread/read'));
  }
});

test('an interrupted child is an authoritative failure without marking the parent complete', async () => {
  const { read } = fixture({ turnStatus: 'interrupted', status: 'notLoaded' });
  const result = await readNativeSubagent(read, { rootThreadId: 'root', agentId: 'child' });
  assert.equal(result.status, 'error');
  assert.equal(result.completed, false);
});
