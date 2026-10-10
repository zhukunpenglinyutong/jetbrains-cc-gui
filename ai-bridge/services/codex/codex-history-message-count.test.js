import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeHistoryCounter } from './codex-history-message-count.js';

const turn = (id) => ({ id, status: 'completed', items: [
  { id: `${id}:user`, type: 'userMessage', content: [{ type: 'text', text: 'inspect' }] },
  { id: `${id}:reasoning`, type: 'reasoning', summary: ['Inspect history'] },
  { id: `${id}:command`, type: 'commandExecution', status: 'completed', command: 'git status' },
  { id: `${id}:answer`, type: 'agentMessage', text: 'Done' },
] });

test('counts all native pages including reasoning and tool results without counting overlapping messages twice', async () => {
  const calls = [];
  const count = createNativeHistoryCounter(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.itemsView, 'full');
    return params.cursor === null ? { data: [turn('new')], nextCursor: 'opaque:old' }
      : { data: [turn('new'), turn('old')], nextCursor: null };
  });
  assert.equal(await count({ id: 'thread', updatedAt: 1 }), 10);
  assert.deepEqual(calls.filter(call => call.method === 'thread/turns/list').map(call => call.params.cursor), [null, 'opaque:old']);
  assert.ok(calls.every(call => !['thread/resume', 'thread/start', 'turn/start'].includes(call.method)));
});

test('older native storage uses one full read and an authoritative empty transcript counts as zero', async () => {
  for (const empty of [false, true]) {
    const calls = [];
    const count = createNativeHistoryCounter(async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/turns/list') throw Object.assign(new Error('unsupported'), { rpcCode: -32601 });
      return { thread: { id: params.threadId, turns: params.includeTurns && !empty ? [turn('full')] : [] } };
    });
    assert.equal(await count({ id: 'thread' }), empty ? 0 : 5);
    assert.equal(calls.filter(call => call.params.includeTurns === true).length, 1);
  }
});

test('metadata-only and looping pages fail instead of publishing an incomplete total', async () => {
  for (const page of [{ data: [], hasMore: true }, { data: [turn('same')], nextCursor: 'repeat' }]) {
    const count = createNativeHistoryCounter(async (method, params) => method === 'thread/read'
      ? { thread: { id: params.threadId } } : page);
    await assert.rejects(count({ id: 'thread' }), /incomplete|repeated/);
  }
});

test('failed counts remain retryable and never become a cached zero', async () => {
  let fail = true;
  const count = createNativeHistoryCounter(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    if (fail) throw new Error('Authentication failed');
    return { data: [turn('retry')], nextCursor: null };
  });
  await assert.rejects(count({ id: 'thread', updatedAt: 1 }), /Authentication failed/);
  fail = false;
  assert.equal(await count({ id: 'thread', updatedAt: 1 }), 5);
});

test('incomplete item pages without a cursor cannot publish a partial message count', async () => {
  const count = createNativeHistoryCounter(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', itemsView: 'summary', items: [] }] };
    return { data: [{ item: { id: 'first', type: 'agentMessage', text: 'Partial' } }], hasMore: true };
  });
  await assert.rejects(count({ id: 'thread' }), /incomplete.*cursor/i);
});

test('turns without an authoritative items array cannot become a confirmed zero', async () => {
  for (const items of [undefined, null, {}]) {
    for (const fullRead of [false, true]) {
      const savedTurn = { id: 'turn', items };
      const count = createNativeHistoryCounter(async (method, params) => {
        if (method === 'thread/read') return { thread: { id: params.threadId, turns: [savedTurn] } };
        if (fullRead) throw Object.assign(new Error('unsupported'), { rpcCode: -32601 });
        return { data: [savedTurn], nextCursor: null };
      });
      await assert.rejects(count({ id: 'thread' }), /items array/i);
    }
  }
});

test('concurrent counts share work and cache invalidates for revised, active and expired threads', async () => {
  let pages = 0;
  let time = 0;
  const count = createNativeHistoryCounter(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    pages += 1;
    return { data: [turn('cached')], nextCursor: null };
  }, { now: () => time, cacheTtlMs: 10 });
  const saved = { id: 'thread', updatedAt: 1 };
  assert.deepEqual(await Promise.all([count(saved), count(saved)]), [5, 5]);
  assert.equal(pages, 1);
  await count(saved);
  assert.equal(pages, 1);
  await count({ ...saved, updatedAt: 2 });
  assert.equal(pages, 2);
  await count({ ...saved, status: { type: 'active' } });
  await count({ ...saved, status: { type: 'active' } });
  assert.equal(pages, 4);
  await count(saved);
  time = 11;
  await count(saved);
  assert.equal(pages, 6);
});

test('cached counts stay bounded and separate thread identities', async () => {
  let pages = 0;
  const count = createNativeHistoryCounter(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    pages += 1;
    return { data: [turn(params.threadId)], nextCursor: null };
  }, { cacheLimit: 2 });
  for (const id of ['one', 'two', 'one', 'three', 'two']) await count({ id });
  assert.equal(pages, 4);
});

test('timed out counts stay retryable and stop following pages after a late native reply', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let releasePage;
  let pageStarted;
  const pageReady = new Promise(resolve => { pageStarted = resolve; });
  let pages = 0;
  const count = createNativeHistoryCounter(async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    pages += 1;
    if (pages === 1) {
      pageStarted();
      return await new Promise(resolve => { releasePage = resolve; });
    }
    return { data: [turn('retry')], nextCursor: null };
  }, { timeoutMs: 20 });
  const failure = assert.rejects(count({ id: 'thread' }), /timed out/i);
  await pageReady;
  context.mock.timers.tick(21);
  await failure;
  releasePage({ data: [turn('late')], nextCursor: 'must-not-read' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pages, 1);
  assert.equal(await count({ id: 'thread' }), 5);
});
