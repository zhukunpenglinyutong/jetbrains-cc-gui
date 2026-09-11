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

test('a modern session binds the cwd and skips workspace.create', async () => {
  const client = stubClient('modern', { 'session.create': { sessionId: 's2' } });
  assert.equal(await createWorkspace(client, 'D:/proj'), null);
  assert.equal(client.calls.length, 0, 'no workspace is created on a modern host');
  assert.equal(await createSession(client, '', undefined, 'D:/proj'), 's2');
  assert.deepEqual(client.calls[0], { method: 'session.create', payload: { cwd: 'D:/proj' } });
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

