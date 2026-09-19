import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,
  createWorkspace,
  history,
  prompt,
  sessionIdFromThread,
  threadIdForSession,
  workspaceIdFromCreate,
} from './session.js';

test('sessionIdFromThread strips the thread prefixes', () => {
  assert.equal(sessionIdFromThread('dsh:abc123'), 'abc123');
  assert.equal(sessionIdFromThread('dsh-pending-xyz'), 'xyz');
});

test('sessionIdFromThread passes through bare ids and trims', () => {
  assert.equal(sessionIdFromThread('abc123'), 'abc123');
  assert.equal(sessionIdFromThread('  dsh:abc  '), 'abc');
  assert.equal(sessionIdFromThread(''), '');
  assert.equal(sessionIdFromThread(null), '');
  assert.equal(sessionIdFromThread(undefined), '');
});

test('sessionIdFromThread only strips a leading prefix', () => {
  assert.equal(sessionIdFromThread('xxdsh:abc'), 'xxdsh:abc');
  assert.equal(sessionIdFromThread('dsh:dsh:abc'), 'dsh:abc');
});

test('threadIdForSession round-trips through sessionIdFromThread', () => {
  assert.equal(threadIdForSession('s1'), 'dsh:s1');
  assert.equal(sessionIdFromThread(threadIdForSession('s1')), 's1');
});

/** Minimal client double: records the logical calls the session layer makes. */
function stubClient(dialect, responses = {}) {
  const calls = [];
  return {
    dialect,
    origin: 'http://127.0.0.1:3080',
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      const response = responses[method];
      return typeof response === 'function' ? response(payload) : response;
    },
  };
}

test('a legacy session still binds through workspace.create', async () => {
  const client = stubClient('legacy', {
    'workspace.create': { workspace: { workspaceId: 'w1' } },
    'session.create': { sessionId: 's1' },
  });
  const workspace = await createWorkspace(client, 'D:/proj');
  assert.deepEqual(client.calls[0], { method: 'workspace.create', payload: { path: 'D:/proj' } });
  assert.equal(workspaceIdFromCreate(workspace), 'w1');
  await createSession(client, 'w1');
  assert.deepEqual(client.calls[1], { method: 'session.create', payload: { workspaceId: 'w1' } });
});

test('a modern session binds through workspace.create too', async () => {
  const client = stubClient('modern', {
    'workspace.create': { workspace: { workspaceId: 'w2' } },
    'session.create': { sessionId: 's2' },
  });
  const workspace = await createWorkspace(client, 'D:/proj');
  assert.deepEqual(client.calls[0], { method: 'workspace.create', payload: { path: 'D:/proj' } });
  assert.equal(workspaceIdFromCreate(workspace), 'w2');
  assert.equal(await createSession(client, 'w2'), 's2');
  assert.deepEqual(client.calls[1], { method: 'session.create', payload: { workspaceId: 'w2' } });
});

test('createSession never sends a bare cwd — that files the session under Ungrouped', async () => {
  const client = stubClient('modern', { 'session.create': { sessionId: 's3' } });
  assert.equal(await createSession(client, 'w3'), 's3');
  assert.ok(!('cwd' in client.calls[0].payload), 'the workspace, not the cwd, is the binding');
  await assert.rejects(() => createSession(client, ''), /workspaceId/);
  assert.equal(client.calls.length, 1, 'an unbound session is refused before any RPC');
});

test('createSession adopts an existing session into its workspace', async () => {
  const client = stubClient('modern', { 'session.create': { sessionId: 's4' } });
  assert.equal(await createSession(client, 'w4', ' s4 '), 's4');
  assert.deepEqual(client.calls[0], {
    method: 'session.create',
    payload: { workspaceId: 'w4', sessionId: 's4' },
  });
});

test('a modern prompt carries a client-minted requestId', async () => {
  const modern = stubClient('modern', { 'session.prompt': { accepted: true } });
  await prompt(modern, 's1', 'hello');
  const { payload } = modern.calls[0];
  assert.equal(payload.mode, 'queue');
  assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(payload.content, [{ type: 'text', text: 'hello' }]);

  const legacy = stubClient('legacy', { 'session.prompt': { accepted: true } });
  await prompt(legacy, 's1', 'hello');
  assert.equal(legacy.calls[0].payload.requestId, undefined);
});

test('a legacy history call keeps its own payload shape', async () => {
  const client = stubClient('legacy', { 'session.history': { events: [], hasMore: false } });
  await history(client, 's1', 20, 5);
  assert.deepEqual(client.calls[0], {
    method: 'session.history',
    payload: { sessionId: 's1', maxMessages: 20, beforeSeq: 5 },
  });
});

