import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeNativeHistoryPages,
  nextNativeHistoryParams,
  normalizeNativeHistoryPage,
  readNativeHistoryPage,
} from './codex-native-history.js';

test('native display page loads items, preserves identities and never resumes a writer', async () => {
  const calls = [];
  const read = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread', cwd: '/saved', createdAt: 1 } };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', itemsView: 'notLoaded', items: [] }], nextCursor: 'opaque:old' };
    return { data: [
      { turnId: 'turn', item: { id: 'user', type: 'userMessage', clientId: 'client', content: [{ type: 'text', text: 'same' }] } },
      { turnId: 'turn', item: { id: 'reasoning', type: 'reasoning', summary: ['Check scope'] } },
      { turnId: 'turn', item: { id: 'command', type: 'commandExecution', command: 'git status', status: 'completed', aggregatedOutput: 'clean' } },
    ], nextCursor: null };
  };
  const page = await readNativeHistoryPage(read, { threadId: 'thread' });
  assert.equal(page.cursor, 'opaque:old');
  assert.equal(page.partial, true);
  assert.equal(page.messages.length, 4);
  assert.equal(page.messages[0].raw.clientMessageId, 'client');
  assert.equal(page.messages[1].raw.message.content[0].thinking, 'Check scope');
  assert.equal(page.messages[2].raw.message.content[0].input.command, 'git status');
  assert.equal(page.messages[3].raw.message.content[0].content, 'clean');
  assert.equal(page.messages[2].raw.uuid, 'codex:thread:turn:command');
  assert.deepEqual(calls.map((call) => call.method), ['thread/read', 'thread/turns/list', 'thread/items/list']);
});

test('only explicit pagination capability errors select a fixed full native read', async () => {
  const calls = [];
  const read = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/turns/list') throw Object.assign(new Error('method not supported'), { code: 'RPC_ERROR', rpcCode: -32601 });
    return { thread: { id: 'thread', turns: params.includeTurns ? [{ id: 't', items: [{ id: 'a', type: 'agentMessage', text: 'stored' }] }] : [] } };
  };
  const page = await readNativeHistoryPage(read, { threadId: 'thread' });
  assert.equal(page.readMode, 'full');
  assert.equal(page.complete, true);
  assert.equal(page.messages[0].content, 'stored');
  calls.length = 0;
  await readNativeHistoryPage(read, { threadId: 'thread', readMode: page.readMode });
  assert.equal(calls.length, 1);
  await assert.rejects(readNativeHistoryPage(async (method) => {
    if (method === 'thread/read') return { thread: { id: 'thread' } };
    throw new Error('Authentication failed');
  }, { threadId: 'thread' }), /Authentication failed/);
});

test('reasoning without plaintext remains visible with its terminal turn state in every history mode', async () => {
  for (const status of ['completed', 'interrupted', 'failed']) {
    for (const readMode of ['paged', 'full']) {
      const turn = { id: 'turn', status, items: [
        { id: 'reasoning', type: 'reasoning', summary: [], content: [], encrypted_content: 'cipher-only' },
      ] };
      const original = JSON.stringify(turn);
      const page = await readNativeHistoryPage(async method => method === 'thread/read'
        ? { thread: { id: 'thread', turns: [turn] } } : { data: [turn] }, { threadId: 'thread', readMode });
      assert.equal(page.messages.length, 1);
      assert.equal(page.messages[0].raw.uuid, 'codex:thread:turn:reasoning');
      assert.deepEqual(page.messages[0].raw.message.content[0], {
        type: 'thinking', thinking: '', text: '', native: true, status,
      });
      assert.equal(JSON.stringify(page.messages).includes('cipher-only'), false);
      assert.equal(JSON.stringify(turn), original, 'reasoning display does not rewrite native history');
    }
  }
});

test('full native reads refuse another thread or a transcript with no turns field', async () => {
  for (const response of [{ thread: { id: 'other', turns: [] } }, { thread: { id: 'thread' } }]) {
    await assert.rejects(readNativeHistoryPage(async () => response,
      { threadId: 'thread', readMode: 'full' }), /different thread|turns/i);
    let reads = 0;
    await assert.rejects(readNativeHistoryPage(async method => {
      if (method === 'thread/turns/list') throw Object.assign(new Error('unsupported'), { rpcCode: -32601 });
      return ++reads === 1 ? { thread: { id: 'thread' } } : response;
    }, { threadId: 'thread' }), /different thread|turns/i);
  }
});

test('opaque item cursor loops fail instead of spinning or publishing partial history as complete', async () => {
  await assert.rejects(readNativeHistoryPage(async (method) => {
    if (method === 'thread/read') return { thread: { id: 'thread' } };
    if (method === 'thread/turns/list') return { data: [{ id: 't', itemsView: 'summary', items: [] }] };
    return { data: [], nextCursor: 'repeat' };
  }, { threadId: 'thread' }), /repeated its cursor/);
});

test('malformed paged turns and items cannot become an authoritative empty transcript', async () => {
  for (const kind of ['turns', 'items']) {
    for (const malformed of [{}, { data: null }, { data: {} }]) {
      await assert.rejects(readNativeHistoryPage(async method => {
        if (method === 'thread/read') return { thread: { id: 'thread' } };
        if (method === 'thread/turns/list') return kind === 'turns' ? malformed
          : { data: [{ id: 'turn', itemsView: 'summary', items: [] }] };
        return malformed;
      }, { threadId: 'thread' }), /array/i);
    }
  }
});

test('native history pages preserve opaque cursors and metadata-only partial state', () => {
  const page = normalizeNativeHistoryPage({
    turns: [],
    hasMoreTurns: true,
    nextCursor: 'opaque-cursor',
  }, 'turns');
  assert.deepEqual(page, {
    items: [],
    cursor: 'opaque-cursor',
    hasMore: true,
    complete: false,
    partial: true,
  });
  assert.deepEqual(nextNativeHistoryParams({ cursor: page.cursor, excludeTurns: true, limit: 30 }), {
    cursor: 'opaque-cursor',
    excludeTurns: true,
    limit: 30,
  });
});

test('overlapping pages upsert by native identity without merging equal text', () => {
  const merged = mergeNativeHistoryPages([
    { items: [{ id: 'item-1', text: 'draft' }, { id: 'item-2', text: 'same' }] },
    { items: [{ id: 'item-2', text: 'same', status: 'completed' }, { id: 'item-3', text: 'next' }] },
  ]);
  assert.deepEqual(merged, [
    { id: 'item-1', text: 'draft' },
    { id: 'item-2', text: 'same', status: 'completed' },
    { id: 'item-3', text: 'next' },
  ]);
});

test('history keeps compaction position and distinguishes item time, turn time and unknown time', async () => {
  const page = await readNativeHistoryPage(async (method) => {
    if (method === 'thread/read') return { thread: { id: 't', createdAt: 999 } };
    if (method === 'thread/turns/list') return { data: [
      { id: 'recent', startedAt: 20, itemsView: 'summary', items: [] },
      { id: 'old', items: [{ id: 'unknown', type: 'contextCompaction' }] },
    ], nextCursor: null };
    return { data: [
      { item: { id: 'before', type: 'agentMessage', text: 'before' } },
      { completedAtMs: 21_000, item: { id: 'exact', type: 'contextCompaction' } },
      { item: { id: 'after', type: 'agentMessage', text: 'after' } },
      { item: { id: 'approx', type: 'contextCompaction' } },
    ], nextCursor: null };
  }, { threadId: 't' });
  assert.deepEqual(page.messages.map((m) => m.raw.codexItemId), ['unknown', 'before', 'exact', 'after', 'approx']);
  assert.equal(page.messages[0].raw.summarizeMetadata.timestamp, undefined);
  assert.equal(page.messages[2].raw.summarizeMetadata.timestamp, 21_000);
  assert.equal(page.messages[2].raw.summarizeMetadata.timestampSource, 'item');
  assert.equal(page.messages[4].raw.summarizeMetadata.timestamp, 20_000);
  assert.equal(page.messages[4].raw.summarizeMetadata.timestampSource, 'turn');
  assert.equal(page.messages[4].raw.summarizeMetadata.trigger, undefined);
});

test('native terminal turns close unfinished image, web and command receipts when history is reloaded', async () => {
  for (const status of ['interrupted', 'failed']) {
    for (const readMode of ['paged', 'full']) {
      const turn = { id: 'stopped-turn', status, items: [
        { id: 'image', type: 'imageGeneration', status: 'in_progress', result: '' },
        { id: 'legacy-image', type: 'imageGeneration', status: '', result: '' },
        { id: 'web', type: 'webSearch', status: 'inProgress', query: 'fixture' },
        { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'npm test', aggregatedOutput: 'partial output' },
        { id: 'completed', type: 'commandExecution', status: 'completed', command: 'true', aggregatedOutput: 'completed before stop' },
        { id: 'failed', type: 'mcpToolCall', status: 'failed', tool: 'fixture', error: { message: 'original failure' } },
      ] };
      const original = JSON.stringify(turn);
      const page = await readNativeHistoryPage(async method => method === 'thread/read'
        ? { thread: { id: 'thread', turns: [turn] } } : { data: [turn] }, { threadId: 'thread', readMode });
      const results = page.messages.map(message => message.raw.message.content[0])
        .filter(block => block.type === 'tool_result');
      for (const id of ['image', 'legacy-image', 'web', 'command']) {
        const result = results.find(block => block.tool_use_id === id);
        assert.ok(result, `${id} in ${status} ${readMode} has a terminal receipt`);
        assert.equal(result.is_error, true);
      }
      assert.equal(results.find(block => block.tool_use_id === 'command').content, 'partial output');
      assert.equal(results.find(block => block.tool_use_id === 'completed').is_error, false);
      assert.equal(results.find(block => block.tool_use_id === 'completed').content, 'completed before stop');
      assert.equal(results.find(block => block.tool_use_id === 'failed').content, 'original failure');
      assert.equal(JSON.stringify(turn), original, 'display projection does not rewrite native history');
    }
  }
});

test('ongoing native turns and already complete turns keep unfinished items pending', async () => {
  for (const status of ['inProgress', 'completed']) {
    const page = await readNativeHistoryPage(async () => ({ thread: { id: 'thread', turns: [{ id: 'turn', status, items: [
      { id: 'image', type: 'imageGeneration', status: 'in_progress', result: '' },
      { id: 'legacy-image', type: 'imageGeneration', status: '', result: '' },
      { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'npm test', aggregatedOutput: 'still running' },
    ] }] } }), { threadId: 'thread', readMode: 'full' });
    assert.equal(page.messages.length, 3);
    assert.ok(page.messages.every(message => message.raw.message.content[0].type === 'tool_use'));
  }
});

test('native terminal projection stays within its own turn and thread while child history remains active', async () => {
  const read = async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: params.threadId === 'root' ? 'interrupted' : 'inProgress',
      itemsView: 'notLoaded', items: [] }] };
    return { data: [
      { turnId: 'turn', item: { id: 'image', type: 'imageGeneration', status: 'in_progress', result: '' } },
      { turnId: 'other-turn', item: { id: 'other-image', type: 'imageGeneration', status: 'in_progress', result: '' } },
    ] };
  };
  const [root, child] = await Promise.all(['root', 'child'].map(threadId => readNativeHistoryPage(read, { threadId })));
  const rootResult = root.messages.find(message => message.raw.message.content[0].tool_use_id === 'image');
  assert.ok(rootResult);
  assert.equal(rootResult.raw.codexThreadId, 'root');
  assert.equal(rootResult.raw.message.content[0].is_error, true);
  assert.equal(root.messages.some(message => message.raw.message.content[0].tool_use_id === 'other-image'), false);
  assert.equal(child.messages.length, 2);
  assert.ok(child.messages.every(message => message.raw.codexThreadId === 'child'
    && message.raw.message.content[0].type === 'tool_use'));
});
