import test from 'node:test';
import assert from 'node:assert/strict';

import { cancelSession } from './cancel-service.js';

test('cancelSession sends session.cancel for the bare session id of a thread id', async () => {
  const calls = [];
  const client = { id: 'client' };
  const result = await cancelSession({
    sessionId: 'dsh:abc',
    connect: async () => ({ client }),
    cancelSession: async (c, id) => calls.push([c, id]),
  });
  assert.deepEqual(calls, [[client, 'abc']]);
  assert.equal(result.success, true);
  assert.equal(result.sessionId, 'abc');
});

test('cancelSession rejects an empty session id without contacting the host', async () => {
  let connected = false;
  const result = await cancelSession({
    sessionId: '  ',
    connect: async () => { connected = true; return { client: {} }; },
    cancelSession: async () => {},
  });
  assert.equal(connected, false);
  assert.equal(result.success, false);
});

test('cancelSession reports failure when the host is unreachable', async () => {
  const result = await cancelSession({
    sessionId: 'abc',
    connect: async () => { throw new Error('no host'); },
    cancelSession: async () => {},
  });
  assert.equal(result.success, false);
  assert.match(result.error, /no host/);
});

test('cancelSession reports failure when the host rejects the cancel', async () => {
  const result = await cancelSession({
    sessionId: 'abc',
    connect: async () => ({ client: {} }),
    cancelSession: async () => { throw new Error('rejected'); },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /rejected/);
});
