import assert from 'node:assert/strict';
import test from 'node:test';
import { readCodexSessionEdits } from './codex-session-edits.js';

const edit = (index, status = 'completed') => ({ id: `edit-${index}`, type: 'fileChange', status,
  changes: [{ path: `/file-${index}.ts`, kind: 'add', diff: '+created' }] });
const turn = (index, status) => ({ id: `turn-${index}`, items: [edit(index, status),
  { id: `command-${index}`, type: 'commandExecution', status: 'completed', command: 'inspect', aggregatedOutput: 'private output' }] });
const metadata = { thread: { id: 'session', name: 'Local edits' } };

test('collects all edit pages chronologically without full hydration or command transcripts', async () => {
  const reads = [];
  const result = await readCodexSessionEdits(async (method, params) => {
    reads.push({ method, params });
    if (method === 'thread/read') {
      assert.equal(params.includeTurns, false);
      assert.equal(params.excludeTurns, true);
      return metadata;
    }
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.itemsView, 'full');
    assert.equal(params.sortDirection, 'desc');
    if (params.cursor === null) return { data: Array.from({ length: 30 }, (_, i) => turn(39 - i)), nextCursor: 'older/+=' };
    assert.equal(params.cursor, 'older/+=');
    return { data: Array.from({ length: 10 }, (_, i) => turn(9 - i)), nextCursor: null };
  }, { threadId: 'session' });
  assert.deepEqual(result.thread, metadata.thread);
  assert.equal(result.fileChangeMessages.length, 40);
  assert.deepEqual(result.fileChangeMessages.map(raw => raw.codexTurnId), Array.from({ length: 40 }, (_, i) => `turn-${i}`));
  assert.equal(reads.filter(read => read.method === 'thread/turns/list').length, 2);
  assert.equal(JSON.stringify(result).includes('private output'), false);
});

test('overlapping pages keep the newer edit snapshot once, at its original chronological position', async () => {
  const result = await readCodexSessionEdits(async (method, params) => {
    if (method === 'thread/read') return metadata;
    return params.cursor === null
      ? { data: [turn(2), turn(1)], nextCursor: 'older' }
      : { data: [turn(1, 'inProgress'), turn(0)], nextCursor: null };
  }, { threadId: 'session' });
  assert.deepEqual(result.fileChangeMessages.map(raw => raw.codexTurnId), ['turn-0', 'turn-1', 'turn-2']);
  assert.equal(result.fileChangeMessages[1].message.content[0].input.status, 'completed');
});

test('loads paginated items when a turn only provides a summary', async () => {
  const cursors = [];
  const result = await readCodexSessionEdits(async (method, params) => {
    if (method === 'thread/read') return metadata;
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-0', itemsView: 'summary' }], nextCursor: null };
    assert.equal(method, 'thread/items/list');
    cursors.push(params.cursor);
    return params.cursor === null
      ? { data: [{ turnId: 'turn-0', item: edit(0) }], nextCursor: 'next-item' }
      : { data: [{ turnId: 'turn-0', item: edit(1) }], nextCursor: null };
  }, { threadId: 'session' });
  assert.equal(result.fileChangeMessages.length, 2);
  assert.deepEqual(cursors, [null, 'next-item']);
});

test('supports legacy native history only after an explicit unsupported pagination response', async () => {
  let fullReads = 0;
  const result = await readCodexSessionEdits(async (method, params) => {
    if (method === 'thread/turns/list') throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
    if (params.includeTurns) {
      fullReads++;
      return { thread: { ...metadata.thread, turns: [turn(0), turn(1)] } };
    }
    return metadata;
  }, { threadId: 'session' });
  assert.equal(fullReads, 1);
  assert.deepEqual(result.fileChangeMessages.map(raw => raw.codexTurnId), ['turn-0', 'turn-1']);
});

test('an unmaterialized new thread has no edits and does not hydrate full history', async () => {
  const result = await readCodexSessionEdits(async (method, params) => {
    if (method === 'thread/read') { assert.equal(params.includeTurns, false); return metadata; }
    throw Object.assign(new Error('thread session is not materialized yet; thread/turns/list is unavailable before first user message'), { rpcCode: -32600 });
  }, { threadId: 'session' });
  assert.deepEqual(result.fileChangeMessages, []);
});

test('broken pagination and authorization failures are not returned as a successful empty edit list', async t => {
  for (const [name, response, expected] of [
    ['repeated cursor', { data: [turn(0)], nextCursor: 'same' }, /repeated/],
    ['missing cursor', { data: [turn(0)], hasMore: true }, /incomplete/],
    ['missing items', { data: [{ id: 'turn-0' }], nextCursor: null }, /no items array/],
    ['access failure', new Error('Permission denied'), /Permission denied/],
  ]) await t.test(name, async () => {
    await assert.rejects(readCodexSessionEdits(async method => {
      if (method === 'thread/read') return metadata;
      if (response instanceof Error) throw response;
      return response;
    }, { threadId: 'session' }), expected);
  });
});

test('a total deadline stops late RPC responses from starting another page', async () => {
  let resolve;
  let calls = 0;
  const late = new Promise(done => { resolve = done; });
  const pending = readCodexSessionEdits(async () => { calls++; return await late; }, { threadId: 'session', timeoutMs: 15 });
  await assert.rejects(pending, /timed out/);
  resolve(metadata);
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 1);
});
