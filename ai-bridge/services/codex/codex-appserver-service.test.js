import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient, ClassifiedError } from './codex-appserver-client.js';
import { CodexAppServerService } from './codex-appserver-service.js';
import { startPeerWithStreams, THREAD_ID } from './testing/codex-stdio-peer.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * In-process service + peer harness. Every test gets isolated streams and a
 * peer dispatch counter so wire-level assertions (turn/start count, resume
 * count) are direct.
 */
function makeService({
  scenario = 'early-notification',
  clientOpts = {},
  serviceOpts = {},
  peerOpts = {},
} = {}) {
  const dispatchCounts = new Map();
  const dispatched = [];
  const events = [];
  let client = null;
  let peer = null;

  // Each runtime generation gets fresh streams and a fresh peer, mirroring
  // production where a generation owns a fresh child process.
  const service = new CodexAppServerService({
    sessionEpoch: '7',
    channelId: 'channel-test',
    stopBudgetMs: 400,
    ...serviceOpts,
    clientFactory: () => {
      const clientToPeer = new PassThrough();
      const peerToClient = new PassThrough();
      const peerStderr = new PassThrough();
      const childEvents = new EventEmitter();
      peer = startPeerWithStreams({
        scenario,
        input: clientToPeer,
        output: peerToClient,
        stderr: peerStderr,
        onExit: (code) => {
          childEvents.emit('exit', code, null);
          peerToClient.end();
          peerStderr.end();
          setImmediate(() => childEvents.emit('close', code, null));
        },
        ...peerOpts,
      });
      const originalDispatch = peer.dispatch.bind(peer);
      peer.dispatch = (method, params, id) => {
        dispatchCounts.set(method, (dispatchCounts.get(method) || 0) + 1);
        dispatched.push({ method, params });
        return originalDispatch(method, params, id);
      };
      client = new CodexAppServerClient({
        command: ['in-process-peer'],
        ...clientOpts,
        spawnFn: () => ({
          stdin: clientToPeer,
          stdout: peerToClient,
          stderr: peerStderr,
          pid: -1,
          on: childEvents.on.bind(childEvents),
          emit: childEvents.emit.bind(childEvents),
          kill: () => true,
        }),
      });
      return client;
    },
  });
  service.on('codex_event', (event) => events.push(event));
  return { service, getPeer: () => peer, events, dispatchCounts, dispatched, getClient: () => client };
}

function eventsOf(events, kind) {
  return events.filter((event) => event.kind === kind);
}

test('restored usage cannot steal sends around a manual compaction', async () => {
  const markers = [];
  const { service, events } = makeService({ scenario: 'resume-replayed-usage',
    serviceOpts: { emitMarker: (operation, marker) => markers.push({ kind: operation.kind, marker }) } });
  try {
    await service.bindThread(THREAD_ID);
    for (const operation of ['send', 'compact', 'send']) {
      const pending = operation === 'compact' ? service.compact({ threadId: THREAD_ID })
        : service.send({ threadId: THREAD_ID, input: [{ type: 'text', text: 'restored request' }] });
      await waitFor(() => !service.busy && service.operations.size === 0, 1000, 'restored operation terminal');
      assert.equal((await pending).outcome, 'completed');
    }
    const terminals = eventsOf(events, 'operationDone');
    assert.equal(terminals.length, 3);
    assert(terminals.every(event => event.turnId !== 'restored-previous-turn'));
    const messages = markers.filter(entry => typeof entry.marker === 'string' && entry.marker.startsWith('[MESSAGE]'))
      .map(entry => JSON.parse(entry.marker.slice('[MESSAGE]'.length)));
    assert.equal(messages.filter(message => message.message?.content?.some(block => block.text === 'Visible restored response')).length, 2);
    assert.equal(messages.filter(message => message.message?.content?.some(block => block.thinking === 'Visible restored reasoning')).length, 2);
    assert.equal(messages.filter(message => message.message?.content?.some(block => block.name === 'bash')).length, 2);
    assert.equal(messages.some(message => message.codexTurnId === 'restored-previous-turn'), false);
    assert.equal(messages.some(message => JSON.stringify(message).includes('Old turn plan')), false);
  } finally { await service.resetRuntime(); }
});

test('native thread naming uses the owned root and relays name notifications', async () => {
  const fixture = makeService();
  await fixture.service.send({ input: [{ type: 'text', text: 'hello' }] });
  const threadId = fixture.service.rootThreadId;
  try {
    await fixture.service.setThreadName(threadId, 'Inspect commands');
    assert.deepEqual(fixture.dispatched.find(call => call.method === 'thread/name/set')?.params,
      { threadId, name: 'Inspect commands' });
    assert.equal(eventsOf(fixture.events, 'threadNameUpdated')[0].payload.threadName, 'Inspect commands');
    await assert.rejects(fixture.service.setThreadName('another-thread', 'wrong'), /no longer active/);
    assert.equal(fixture.dispatchCounts.get('thread/name/set'), 1);
  } finally {
    await fixture.service.resetRuntime();
  }
});

test('module context and role initialize native threads without entering user turns', async () => {
  const instructions = 'Selected role\n\n## Project Modules\n\n- main\n- test';
  const { service, dispatched } = makeService({ serviceOpts: { launchOptions: { developerInstructions: instructions } } });
  service.updateSettings({ developerInstructions: instructions });
  try {
    for (const text of ['first prompt', 'next prompt']) {
      assert.equal((await service.send({ input: [{ type: 'text', text }] })).outcome, 'completed');
    }
    await service.resetRuntime();
    assert.equal((await service.send({ input: [{ type: 'text', text: 'cold prompt' }] })).outcome, 'completed');
    const initialization = dispatched.filter((entry) => ['thread/start', 'thread/resume'].includes(entry.method));
    assert.deepEqual(initialization.map((entry) => entry.method), ['thread/start', 'thread/resume']);
    for (const entry of initialization) assert.equal(entry.params.developerInstructions, instructions);
    const turns = dispatched.filter((entry) => entry.method === 'turn/start');
    assert.deepEqual(turns.map((entry) => entry.params.input), ['first prompt', 'next prompt', 'cold prompt']
      .map((text) => [{ type: 'text', text }]));
  } finally { await service.resetRuntime(); }
});

test('buffered final items complete the turn before a process exit retires its writer', async () => {
  const { service, getClient, getPeer, events, dispatchCounts } = makeService({ scenario: 'never-respond' });
  try {
    const sending = service.send({ input: [{ type: 'text', text: 'tail prompt' }] });
    await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
    const operation = [...service.operations.values()][0];
    const peer = getPeer();
    for (const id of peer.pendingAcks.keys()) peer.ackPending(id, { turn: { id: operation.nativeTurnId } });
    peer.output.pause();
    peer.notify({ method: 'item/completed', params: { threadId: operation.threadId, turnId: operation.nativeTurnId,
      item: { type: 'agentMessage', id: 'tail', text: '完整结束正文 🧪' } } });
    peer.notify({ method: 'turn/completed', params: { threadId: operation.threadId,
      turn: { id: operation.nativeTurnId, status: 'completed' } } });
    peer.exit(0);
    assert.equal(getClient().exitSettled, false);
    peer.output.resume();
    assert.equal((await sending).outcome, 'completed');
    await getClient().waitForExit();
    assert.equal(eventsOf(events, 'operationDone').length, 1);
    assert.equal(dispatchCounts.get('turn/start'), 1);
    assert.ok(eventsOf(events, 'itemCompleted').some((event) => event.payload.item.text === '完整结束正文 🧪'));
    assert.equal(service.busy, false);
    assert.equal(service.queue.length, 0);
  } finally { await service.resetRuntime(); }
});

test('concurrent callers waiting for an exited writer create only one replacement runtime', async () => {
  for (const retirement of ['exit', 'reset']) {
    const { service, getClient, dispatchCounts } = makeService();
    try {
      await service.ensureRuntime();
      const generation = service.runtimeGeneration;
      const previous = getClient();
      const draining = retirement === 'reset' ? service.resetRuntime() : null;
      if (!draining) previous.child.emit('exit', 0, null);
      const waiting = [service.ensureRuntime(), service.ensureRuntime()];
      assert.equal(service.runtimeGeneration, generation);
      if (draining) await draining;
      else previous.child.emit('close', 0, null);
      await Promise.all(waiting);
      assert.equal(service.runtimeGeneration, generation + 1, retirement);
      assert.equal(dispatchCounts.get('initialize'), 2, retirement);
      assert.equal(service.state, 'ready');
    } finally { await service.resetRuntime(); }
  }
});

test('asynchronous native client preparation stays single flight across concurrent callers', async () => {
  const { service, dispatchCounts } = makeService();
  const create = service.clientFactory;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let preparations = 0;
  service.clientFactory = async () => { preparations += 1; await gate; return create(); };
  const results = Promise.allSettled([service.ensureRuntime(), service.ensureRuntime()]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(preparations, 1);
    release();
    assert.equal((await results).every(result => result.status === 'fulfilled'), true);
    assert.equal(dispatchCounts.get('initialize'), 1);
    assert.equal(service.runtimeGeneration, 1);
  } finally { release(); await results; await service.resetRuntime().catch(() => {}); }
});

test('concurrent resets retire one writer before the next explicitly queued send starts', { timeout: 3000 }, async () => {
  const { service, getClient, dispatchCounts, events } = makeService();
  let previous;
  try {
    await service.ensureRuntime();
    previous = getClient();
    // Hold the actual close boundary so both controls await the same retiring writer.
    previous.child.emit('exit', 0, null);
    const resetting = [service.resetRuntime(), service.resetRuntime()];
    const sending = service.send({ input: [{ type: 'text', text: 'explicit request during cleanup' }] });
    previous.child.emit('close', 0, null);
    await Promise.all(resetting);
    assert.equal((await sending).outcome, 'completed');
    assert.equal(dispatchCounts.get('initialize'), 2);
    assert.equal(dispatchCounts.get('turn/start'), 1);
    assert.equal(eventsOf(events, 'operationDone').length, 1);
  } finally {
    previous?.child.emit('close', 0, null);
    await service.resetRuntime();
  }
});

test('releasing a runtime during environment preparation prevents a late child from starting', async () => {
  const { service, dispatchCounts } = makeService();
  const create = service.clientFactory;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  service.clientFactory = async () => { await gate; return create(); };
  const result = service.ensureRuntime().then(() => null, error => error);
  let waitingError;
  const waiting = service.ensureRuntime().then(() => null, error => { waitingError = error; return error; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    await service.resetRuntime();
    release();
    assert.equal((await result)?.code, 'RUNTIME_RESET');
    assert.equal(dispatchCounts.get('initialize') ?? 0, 0);
    assert.equal(service.client, null);
    assert.equal(service.state, 'stopped');
    assert.equal(waitingError?.code, 'RUNTIME_RESET', 'concurrent preparation waiters finish when their runtime is released');
  } finally {
    release();
    if (!waitingError) service.emit('runtimeStateChanged', { state: 'failed' });
    await Promise.all([result, waiting]);
    await service.resetRuntime().catch(() => {});
  }
});

test('image views settle live cards without a native status field', async () => {
  const markers = [];
  const { service } = makeService({ scenario: 'image-view',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) } });
  try {
    assert.equal((await service.send({ input: [{ type: 'text', text: 'inspect an image' }] })).outcome, 'completed');
    const messages = markers.filter(marker => typeof marker === 'string' && marker.startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length)));
    const uses = messages.filter(message => message.message.content[0].name === 'imageView');
    assert.equal(uses.length, 2, 'started and completed snapshots share a card identity');
    const result = messages.find(message => message.message.content[0].tool_use_id === 'image-view');
    assert.ok(result, 'completed snapshot carries a paired result');
    assert.equal(result.message.content[0].is_error, false);
  } finally { await service.resetRuntime(); }
});

test('empty native reasoning starts visibly and completes under the same message identity', async () => {
  const markers = [];
  const { service, getClient, getPeer } = makeService({ scenario: 'never-respond',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
  const reasoningMessages = () => markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
    .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length)))
    .filter(message => message.message?.content?.some(block => block.type === 'thinking'));
  try {
    const send = service.send({ input: [{ type: 'text', text: 'reason through the request' }] });
    await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
    const operation = [...service.operations.values()][0];
    for (const id of getPeer().pendingAcks.keys()) getPeer().ackPending(id, { turn: { id: operation.nativeTurnId } });
    const params = { threadId: operation.threadId, turnId: operation.nativeTurnId,
      item: { id: 'reasoning-empty', type: 'reasoning', summary: [], content: [] } };
    getClient().emit('notification', { method: 'item/started', params });
    assert.equal(reasoningMessages().length, 1, 'the native lifecycle is visible without plaintext');
    assert.deepEqual(reasoningMessages()[0].message.content,
      [{ type: 'thinking', thinking: '', text: '', native: true, status: 'inProgress' }]);
    getClient().emit('notification', { method: 'item/completed', params });
    getClient().emit('notification', { method: 'turn/completed', params: {
      threadId: operation.threadId, turn: { id: operation.nativeTurnId, status: 'completed' } } });
    assert.equal((await send).outcome, 'completed');
    assert.equal(reasoningMessages().length, 2);
    assert.equal(reasoningMessages()[1].uuid, reasoningMessages()[0].uuid);
    assert.equal(reasoningMessages()[1].message.content[0].status, 'completed');
  } finally { await service.resetRuntime(); }
});

test('received native reasoning survives empty updated and terminal snapshots', async (t) => {
  for (const [field, method] of [['summary', 'item/reasoning/summaryTextDelta'], ['content', 'item/reasoning/textDelta']]) {
    for (const status of ['completed', 'failed', 'interrupted']) {
      await t.test(`${field} remains readable when ${status}`, async () => {
        const markers = [];
        const { service, getClient, getPeer } = makeService({ scenario: 'never-respond',
          serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
        const messages = () => markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
          .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length)))
          .filter(message => message.codexItemId === 'streamed-reasoning');
        try {
          const send = service.send({ input: [{ type: 'text', text: 'keep the native summary' }] });
          await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
          const operation = [...service.operations.values()][0];
          for (const id of getPeer().pendingAcks.keys()) getPeer().ackPending(id, { turn: { id: operation.nativeTurnId } });
          const identity = { threadId: operation.threadId, turnId: operation.nativeTurnId };
          const item = { id: 'streamed-reasoning', type: 'reasoning', summary: [], content: [] };
          getClient().emit('notification', { method: 'item/started', params: { ...identity, item } });
          for (const delta of ['原生摘要', ' 🧪']) {
            getClient().emit('notification', { method, params: { ...identity, itemId: item.id, delta,
              ...(field === 'summary' ? { summaryIndex: 0 } : { contentIndex: 0 }) } });
          }
          getClient().emit('notification', { method: 'item/updated', params: { ...identity, item } });
          assert.equal(messages().at(-1).message.content[0].thinking, '原生摘要 🧪', 'empty updates cannot erase received text');
          getClient().emit('notification', { method: 'item/completed', params: { ...identity, item: { ...item, status } } });
          getClient().emit('notification', { method: 'turn/completed', params: {
            threadId: operation.threadId, turn: { id: operation.nativeTurnId, status } } });
          assert.equal((await send).outcome, status);
          const completed = messages().at(-1);
          assert.deepEqual(completed.message.content,
            [{ type: 'thinking', thinking: '原生摘要 🧪', text: '原生摘要 🧪', native: true, status }]);
          assert.equal(completed.uuid, messages()[0].uuid);
          assert.equal(completed.codexAuthoritative, true);
        } finally { await service.resetRuntime(); }
      });
    }
  }
});

test('nonempty native reasoning completion remains authoritative over streamed text', async () => {
  const markers = [];
  const { service, getClient, getPeer } = makeService({ scenario: 'never-respond',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
  try {
    const send = service.send({ input: [] });
    await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
    const operation = [...service.operations.values()][0];
    for (const id of getPeer().pendingAcks.keys()) getPeer().ackPending(id, { turn: { id: operation.nativeTurnId } });
    const identity = { threadId: operation.threadId, turnId: operation.nativeTurnId, itemId: 'authoritative-reasoning' };
    getClient().emit('notification', { method: 'item/reasoning/summaryTextDelta', params: { ...identity, delta: 'draft summary' } });
    getClient().emit('notification', { method: 'item/reasoning/textDelta', params: { ...identity, delta: 'draft content' } });
    getClient().emit('notification', { method: 'item/completed', params: { ...identity,
      item: { id: identity.itemId, type: 'reasoning', summary: ['Final summary.'], content: ['Final content.'] } } });
    getClient().emit('notification', { method: 'turn/completed', params: {
      threadId: operation.threadId, turn: { id: operation.nativeTurnId, status: 'completed' } } });
    assert.equal((await send).outcome, 'completed');
    const completed = markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length))).at(-1);
    assert.deepEqual(completed.message.content.map(block => block.thinking), ['Final summary.', 'Final content.']);
    assert.equal(completed.codexAuthoritative, true);
  } finally { await service.resetRuntime(); }
});

test('reasoning retention never supplies another item or an empty agent message with its body', async () => {
  const markers = [];
  const { service, getClient, getPeer } = makeService({ scenario: 'never-respond',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
  try {
    const send = service.send({ input: [] });
    await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
    const operation = [...service.operations.values()][0];
    for (const id of getPeer().pendingAcks.keys()) getPeer().ackPending(id, { turn: { id: operation.nativeTurnId } });
    const identity = { threadId: operation.threadId, turnId: operation.nativeTurnId };
    getClient().emit('notification', { method: 'item/reasoning/summaryTextDelta', params: {
      ...identity, itemId: 'reasoning-source', delta: 'Only the source item owns this.' } });
    getClient().emit('notification', { method: 'item/agentMessage/delta', params: {
      ...identity, itemId: 'cleared-answer', delta: 'Temporary answer.' } });
    for (const item of [
      { id: 'reasoning-empty-other', type: 'reasoning', summary: [], content: [] },
      { id: 'cleared-answer', type: 'agentMessage', text: '' },
      { id: 'reasoning-source', type: 'reasoning', summary: [], content: [] },
    ]) getClient().emit('notification', { method: 'item/completed', params: { ...identity, item } });
    getClient().emit('notification', { method: 'turn/completed', params: {
      threadId: operation.threadId, turn: { id: operation.nativeTurnId, status: 'completed' } } });
    assert.equal((await send).outcome, 'completed');
    const messages = markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length)));
    const latest = id => messages.filter(message => message.codexItemId === id).at(-1).message.content[0];
    assert.equal(latest('reasoning-empty-other').thinking, '');
    assert.equal(latest('cleared-answer').text, '');
    assert.equal(latest('reasoning-source').thinking, 'Only the source item owns this.');
  } finally { await service.resetRuntime(); }
});

test('reasoning retention never borrows plaintext from the same item id in an older turn', async () => {
  const markers = [];
  const { service, getClient, getPeer } = makeService({ scenario: 'never-respond',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
  try {
    await service.preconnect({ threadId: THREAD_ID });
    getClient().emit('notification', { method: 'item/completed', params: {
      threadId: THREAD_ID, turnId: 'old-turn', item: {
        id: 'reused-reasoning', type: 'reasoning', summary: ['Old turn summary.'], content: [] },
    } });
    const send = service.send({ threadId: THREAD_ID, input: [] });
    await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
    const operation = [...service.operations.values()][0];
    for (const id of getPeer().pendingAcks.keys()) getPeer().ackPending(id, { turn: { id: operation.nativeTurnId } });
    const identity = { threadId: THREAD_ID, turnId: operation.nativeTurnId, itemId: 'reused-reasoning' };
    const item = { id: identity.itemId, type: 'reasoning', summary: [], content: [] };
    getClient().emit('notification', { method: 'item/started', params: { ...identity, item } });
    const started = markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length))).at(-1);
    assert.equal(started.message.content[0].thinking, '');
    getClient().emit('notification', { method: 'item/reasoning/summaryTextDelta', params: {
      ...identity, delta: 'Current turn summary.' } });
    getClient().emit('notification', { method: 'item/completed', params: { ...identity, item } });
    getClient().emit('notification', { method: 'turn/completed', params: {
      threadId: THREAD_ID, turn: { id: operation.nativeTurnId, status: 'completed' } } });
    assert.equal((await send).outcome, 'completed');
    const completed = markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length))).at(-1);
    assert.equal(completed.message.content[0].thinking, 'Current turn summary.');
    assert.doesNotMatch(JSON.stringify(markers), /Old turn summary/);
  } finally { await service.resetRuntime(); }
});

test('retained native reasoning continues through the privacy projection', async () => {
  const markers = [];
  const { service, getClient, getPeer, events } = makeService({ scenario: 'never-respond', serviceOpts: {
    emitMarker: (_operation, marker) => markers.push(marker),
    privacyIndex: { redact: value => value === undefined ? value
      : JSON.parse(JSON.stringify(value).replaceAll('synthetic-secret', '[redacted]')) },
  } });
  try {
    const send = service.send({ input: [] });
    await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
    const operation = [...service.operations.values()][0];
    for (const id of getPeer().pendingAcks.keys()) getPeer().ackPending(id, { turn: { id: operation.nativeTurnId } });
    const identity = { threadId: operation.threadId, turnId: operation.nativeTurnId, itemId: 'private-reasoning' };
    getClient().emit('notification', { method: 'item/reasoning/summaryTextDelta', params: { ...identity, delta: 'synthetic-secret' } });
    getClient().emit('notification', { method: 'item/completed', params: { ...identity,
      item: { id: identity.itemId, type: 'reasoning', summary: [], content: [] } } });
    const completed = markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length))).at(-1);
    assert.equal(completed.message.content[0].thinking, '[redacted]');
    assert.doesNotMatch(JSON.stringify([...service.itemSnapshots.values(), ...markers, ...events]), /synthetic-secret/);
    getClient().emit('notification', { method: 'turn/completed', params: {
      threadId: operation.threadId, turn: { id: operation.nativeTurnId, status: 'completed' } } });
    assert.equal((await send).outcome, 'completed');
  } finally { await service.resetRuntime(); }
});

test('started-only native reasoning settles on cancellation, failure and successful completion', async () => {
  for (const outcome of ['cancelled', 'failed', 'completed']) {
    const markers = [];
    const { service, getClient, getPeer } = makeService({ scenario: 'never-respond',
      serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
    try {
      const send = service.send({ input: [{ type: 'text', text: 'reason before stopping' }] });
      await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
      const operation = [...service.operations.values()][0];
      for (const id of getPeer().pendingAcks.keys()) getPeer().ackPending(id, { turn: { id: operation.nativeTurnId } });
      getClient().emit('notification', { method: 'item/started', params: {
        threadId: operation.threadId, turnId: operation.nativeTurnId,
        item: { id: 'reasoning-interrupted', type: 'reasoning', summary: [], content: [] } } });
      if (outcome === 'cancelled') service.stopOperation(operation.clientOperationId);
      else getClient().emit('notification', { method: 'turn/completed', params: {
        threadId: operation.threadId, turn: { id: operation.nativeTurnId, status: outcome,
          ...(outcome === 'failed' ? { error: { message: 'native reasoning failed' } } : {}) } } });
      assert.equal((await send).outcome, outcome === 'cancelled' ? 'interrupted' : outcome);
      const messages = markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
        .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length)))
        .filter(message => message.message?.content?.some(block => block.type === 'thinking'));
      assert.equal(messages.length, 2, `${outcome} closes the started reasoning card`);
      assert.equal(messages[1].uuid, messages[0].uuid);
      assert.equal(messages[1].message.content[0].status, outcome === 'cancelled' ? 'interrupted' : outcome);
      assert.equal(messages[1].message.content[0].thinking, '');
    } finally { await service.resetRuntime(); }
  }
});

test('image generation starts visibly and keeps its native PNG result under the same card identity', async () => {
  const markers = [];
  const { service, getPeer } = makeService({ scenario: 'never-respond',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) } });
  try {
    const send = service.send({ input: [{ type: 'text', text: 'generate an image' }] });
    await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
    const operation = [...service.operations.values()][0];
    const peer = getPeer();
    for (const id of peer.pendingAcks.keys()) peer.ackPending(id, { turn: { id: operation.nativeTurnId } });
    peer.notify({ method: 'item/started', params: { threadId: operation.threadId, turnId: operation.nativeTurnId,
      item: { type: 'imageGeneration', id: 'generate', status: 'in_progress', result: '' } } });
    await waitFor(() => markers.some(marker => typeof marker === 'string' && marker.includes('"name":"imageGeneration"')));
    peer.notify({ method: 'item/completed', params: { threadId: operation.threadId, turnId: operation.nativeTurnId,
      item: { type: 'imageGeneration', id: 'generate', status: 'completed', result: 'cG5n',
        revisedPrompt: 'A square', savedPath: '/tmp/generated.png' } } });
    peer.notify({ method: 'turn/completed', params: { threadId: operation.threadId,
      turn: { id: operation.nativeTurnId, status: 'completed' } } });
    assert.equal((await send).outcome, 'completed');
    const messages = markers.filter(marker => typeof marker === 'string' && marker.startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length)));
    const calls = messages.filter(message => message.message.content[0].name === 'imageGeneration');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].uuid, calls[1].uuid);
    assert.deepEqual(calls[0].message.content[0].input, {});
    assert.equal(calls[1].message.content[0].input.result, undefined);
    const result = messages.find(message => message.message.content[0].tool_use_id === 'generate');
    assert.equal(result.message.content[0].is_error, false);
    assert.deepEqual(result.message.content[0].content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
      { type: 'text', text: '/tmp/generated.png' },
    ]);
  } finally { await service.resetRuntime(); }
});

test('late start ack supplies the missing identity and honors the original Stop without retrying', async () => {
  const { service, getPeer, getClient, dispatchCounts } = makeService({ scenario: 'silent-start' });
  try {
    await service.ensureRuntime();
    const client = getClient();
    const request = client.request.bind(client);
    client.request = (method, params, options) => request(method, params, method === 'turn/start' ? { ...options, timeoutMs: 25 } : options);
    const operation = service.enqueueOperation({ kind: 'send', markerPayload: { input: [] } });
    await waitFor(() => getPeer().pendingAcks.size === 1);
    service.stopOperation(operation.clientOperationId);
    await waitFor(() => !client.pendingRequests.has(operation.rpcId));
    getPeer().ackPending(operation.rpcId, { turn: { id: 'turn-test-0001' } });
    const result = await operation.promise;
    assert.equal(result.outcome, 'interrupted');
    assert.equal(dispatchCounts.get('turn/start'), 1);
    assert.equal(dispatchCounts.get('turn/interrupt'), 1);
  } finally { await service.resetRuntime(); }
});

test('settings ack without effective confirmation closes the writer before a control operation', async () => {
  const { service, getPeer, getClient, dispatchCounts } = makeService({ serviceOpts: { stopBudgetMs: 40 } });
  try {
    await service.send({ input: [], clientMessageId: 'seed' });
    const client = getClient();
    const peer = getPeer();
    const dispatch = peer.dispatch.bind(peer);
    peer.dispatch = (method, params, id) => method === 'thread/settings/update' ? peer.reply(id, {}) : dispatch(method, params, id);
    service.updateSettings({ model: 'another-model' });
    const result = await service.compact();
    assert.notEqual(result.outcome, 'completed');
    assert.equal(dispatchCounts.get('thread/compact/start') ?? 0, 0);
    assert.equal(client.alive, false);
  } finally { await service.resetRuntime(); }
});

test('native project fallback names remain ahead of the plugin compatibility fallback', async () => {
  const { service, getPeer, dispatched } = makeService();
  try {
    const startup = service.ensureRuntime();
    const peer = getPeer();
    const dispatch = peer.dispatch.bind(peer);
    peer.dispatch = (method, params, id) => method === 'config/read'
      ? peer.reply(id, { config: { project_doc_fallback_filenames: ['TEAM.md', 'README.instructions.md'],
        projects: { fixture: { trust_level: 'untrusted' } } } }) : dispatch(method, params, id);
    await startup;
    await service.send({ input: [], clientMessageId: 'fallback-test' });
    const config = dispatched.find(({ method }) => method === 'thread/start').params.config;
    assert.deepEqual(config.project_doc_fallback_filenames, ['TEAM.md', 'README.instructions.md', 'CLAUDE.md']);
    assert.equal(config.projects, undefined);
  } finally { await service.resetRuntime(); }
});

async function waitFor(predicate, timeoutMs = 4000, message = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${message}`);
}

test('a confirmed long turn survives the dispatch confirmation budget', async () => {
  const { service, getPeer } = makeService({
    scenario: 'never-respond', serviceOpts: { stopBudgetMs: 60 },
  });
  try {
    const operation = service.enqueueOperation({ kind: 'send', markerPayload: { input: [] } });
    await waitFor(() => operation.nativeTurnId);
    const peer = getPeer();
    for (const id of peer.pendingAcks.keys()) peer.ackPending(id, { turn: { id: operation.nativeTurnId } });
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(service.state, 'ready');
    assert.equal(operation.settled, false, 'a running turn has no local execution deadline');
    peer.notify({ method: 'turn/completed', params: {
      threadId: operation.threadId, turn: { id: operation.nativeTurnId, status: 'completed' },
    } });
    assert.equal((await operation.promise).outcome, 'completed');
  } finally { await service.resetRuntime(); }
});

test('an accepted compact waits for native preparation without using the Stop budget as its execution deadline', async () => {
  const { service, events, dispatchCounts } = makeService({
    scenario: 'delayed-compact-start', serviceOpts: { stopBudgetMs: 40 },
  });
  try {
    await service.preconnect({ threadId: THREAD_ID });
    const result = await service.compact();
    assert.equal(result.outcome, 'completed');
    assert.equal(service.state, 'ready');
    assert.equal(dispatchCounts.get('thread/compact/start'), 1);
    assert.equal(eventsOf(events, 'runtimeUnhealthy').length, 0);
    assert.equal(eventsOf(events, 'operationDone').length, 1);
  } finally { await service.resetRuntime(); }
});

test('Stop still retires an accepted compact when its native identity remains unavailable', async () => {
  const { service, events, dispatchCounts } = makeService({
    scenario: 'delayed-compact-start', serviceOpts: { stopBudgetMs: 40 },
  });
  try {
    await service.preconnect({ threadId: THREAD_ID });
    const operation = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID });
    await waitFor(() => eventsOf(events, 'operationAcked').length === 1);
    assert.equal(operation.nativeTurnId, null);
    service.stopOperation(operation.clientOperationId);
    const result = await operation.promise;
    assert.equal(result.outcome, 'failed');
    assert.equal(dispatchCounts.get('thread/compact/start'), 1);
    assert.equal(dispatchCounts.get('turn/interrupt') ?? 0, 0);
    assert.equal(eventsOf(events, 'runtimeUnhealthy').length, 1);
    assert.equal(eventsOf(events, 'operationDone').length, 1);
  } finally { await service.resetRuntime(); }
});

test('late compact acceptance clears dispatch uncertainty while keeping the FIFO occupied', async () => {
  const { service, getClient, getPeer, events } = makeService({
    scenario: 'delayed-compact-start', serviceOpts: { stopBudgetMs: 50 },
  });
  try {
    await service.preconnect({ threadId: THREAD_ID });
    const client = getClient();
    const request = client.request.bind(client);
    client.request = (method, params, options) => request(method, params,
      method === 'thread/compact/start' ? { ...options, timeoutMs: 10 } : options);
    const peer = getPeer();
    const prepare = peer.scenario.onCompactStart;
    peer.scenario = { ...peer.scenario, onCompactStart: async (params, ctx) => {
      await ctx.sleep(35);
      await prepare(params, ctx);
    } };
    const operation = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID });
    await waitFor(() => eventsOf(events, 'operationAcked').length === 1);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(operation.settled, false);
    assert.equal(service.busy, true);
    assert.equal((await operation.promise).outcome, 'completed');
    assert.equal(eventsOf(events, 'runtimeUnhealthy').length, 0);
  } finally { await service.resetRuntime(); }
});

test('an acked compact that never announces its turn is recovered by its announcement budget', async () => {
  const { service, getPeer, events } = makeService({
    scenario: 'delayed-compact-start',
    serviceOpts: { stopBudgetMs: 40, compactAnnouncementBudgetMs: 60 },
  });
  // The announcement watchdog is unref'd (production keeps its own handles),
  // so the test must hold the loop open while the wedge budget expires.
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await service.preconnect({ threadId: THREAD_ID });
    const peer = getPeer();
    // Acknowledge the submission but never announce a native turn or terminal.
    peer.scenario = { ...peer.scenario, onCompactStart: async (_params, ctx) => {
      ctx.reply(ctx.currentId, {});
    } };
    const operation = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID });
    const result = await operation.promise;
    assert.equal(result.outcome, 'failed', 'wedged compaction settles failed after the budget');
    assert.equal(eventsOf(events, 'operationDone').length, 1);
    assert.equal(eventsOf(events, 'runtimeUnhealthy').length >= 1, true,
      'wedged compact surfaced as unhealthy');
    assert.equal(service.busy, false, 'the FIFO drains after the recovery');
  } finally {
    clearTimeout(keepAlive);
    await service.resetRuntime();
  }
});

test('a compact without acceptance still retires an unconfirmed dispatch', async () => {
  const { service, getClient, getPeer, events, dispatchCounts } = makeService({
    serviceOpts: { stopBudgetMs: 40 },
  });
  try {
    await service.preconnect({ threadId: THREAD_ID });
    const client = getClient();
    const request = client.request.bind(client);
    client.request = (method, params, options) => request(method, params,
      method === 'thread/compact/start' ? { ...options, timeoutMs: 10 } : options);
    const peer = getPeer();
    peer.scenario = { ...peer.scenario, onCompactStart: (_params, ctx) => ctx.rememberPendingAck(ctx.currentId) };
    const operation = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID });
    await waitFor(() => operation.settled);
    assert.equal((await operation.promise).outcome, 'failed');
    assert.equal(eventsOf(events, 'operationAcked').length, 0);
    assert.equal(eventsOf(events, 'runtimeUnhealthy').length, 1);
    assert.equal(dispatchCounts.get('thread/compact/start'), 1);
  } finally { await service.resetRuntime(); }
});

test('reset settles active and queued operations and clears reverse requests', async () => {
  const { service, events } = makeService({ scenario: 'reverse-approval' });
  const first = service.enqueueOperation({ kind: 'send', markerPayload: { input: [] } });
  await waitFor(() => eventsOf(events, 'interactionRequested').length > 0);
  const second = service.enqueueOperation({ kind: 'send', threadId: first.threadId, markerPayload: { input: [] } });
  await service.resetRuntime();
  assert.equal(first.settled, true);
  assert.equal(second.settled, true);
  assert.equal(service.operations.size, 0);
  assert.equal(service.pendingInteractions.size, 0);
  assert.equal(service.snapshot().queueLength, 0);
});

test('tool and plan deltas do not become assistant prose', async () => {
  const markers = [];
  const { service, getPeer } = makeService({ scenario: 'never-respond',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) },
  });
  try {
    const operation = service.enqueueOperation({ kind: 'send', markerPayload: { input: [] } });
    await waitFor(() => operation.nativeTurnId);
    for (const method of ['item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/plan/delta']) {
      getPeer().notify({ method, params: { threadId: operation.threadId, turnId: operation.nativeTurnId,
        itemId: 'tool-item', delta: 'tool-only-content' } });
    }
    assert.equal(markers.some((marker) => String(marker).startsWith('[CONTENT_DELTA]')), false);
  } finally { await service.resetRuntime(); }
});

test('native token snapshots keep context and turn accounting separate', async () => {
  const markers = [];
  const { service, getPeer } = makeService({ scenario: 'never-respond',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) },
  });
  try {
    const operation = service.enqueueOperation({ kind: 'send', markerPayload: { input: [] } });
    await waitFor(() => operation.nativeTurnId);
    getPeer().notify({ method: 'thread/tokenUsage/updated', params: {
      threadId: operation.threadId, turnId: operation.nativeTurnId,
      tokenUsage: { total: { inputTokens: 120, outputTokens: 20, cachedInputTokens: 30 },
        last: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 15 }, modelContextWindow: 1000 },
    } });
    const result = markers.find((marker) => String(marker).includes('"type":"result"'));
    const context = markers.find((marker) => String(marker).includes('token_count'));
    assert.match(result, /"input_tokens":120/);
    assert.match(context, /"input_tokens":50/);
    assert.match(context, /"model_context_window":1000/);
  } finally { await service.resetRuntime(); }
});

test('native live events and cached items use the same privacy projection as markers', async () => {
  const { service, getPeer, events } = makeService({ scenario: 'never-respond', serviceOpts: {
    privacyIndex: { redact: (value) => JSON.parse(JSON.stringify(value).replaceAll('synthetic-secret', '[redacted]')) },
  } });
  try {
    const operation = service.enqueueOperation({ kind: 'send', markerPayload: { input: [] } });
    await waitFor(() => operation.nativeTurnId);
    getPeer().notify({ method: 'item/completed', params: { threadId: operation.threadId,
      turnId: operation.nativeTurnId, item: { id: 'secret-output', type: 'functionCallOutput', output: 'synthetic-secret' } } });
    assert.doesNotMatch(JSON.stringify(events), /synthetic-secret/);
    assert.doesNotMatch(JSON.stringify([...service.itemSnapshots.values()]), /synthetic-secret/);
  } finally { await service.resetRuntime(); }
});

test('read-only thread inspection does not resume the selected thread', async () => {
  const { service, dispatchCounts } = makeService();
  await service.bindThread('saved-thread');
  try {
    await service.readOnly('thread/read', { threadId: 'saved-thread' });
    assert.equal(dispatchCounts.get('thread/resume') || 0, 0);
    assert.equal(dispatchCounts.get('turn/start') || 0, 0);
  } finally { await service.resetRuntime(); }
});

test('a send queued during an idle launch rebuild runs on the new child', async () => {
  const { service } = makeService();
  try {
    await service.send({ input: [{ type: 'text', text: 'seed' }] });
    service.notifyLaunchConfigChange({}, 'new-provider');
    const operation = service.enqueueOperation({ kind: 'send', threadId: service.rootThreadId,
      markerPayload: { input: [{ type: 'text', text: 'next' }] } });
    const result = await Promise.race([operation.promise,
      new Promise((resolve) => setTimeout(() => resolve({ outcome: 'timed-out' }), 1000))]);
    assert.equal(result.outcome, 'completed');
    assert.equal(service.runtimeGeneration, 2);
  } finally { await service.resetRuntime(); }
});

test('a send queued behind an active turn is not cancelled by the deferred rebuild', async () => {
  const { service } = makeService({ scenario: 'reverse-approval' });
  try {
    await service.ensureRuntime();
    let releaseApproval;
    const gate = new Promise((resolvePromise) => { releaseApproval = resolvePromise; });
    service.client.onServerRequest = async () => {
      await gate;
      return { decision: 'accept' };
    };
    const first = service.send({ input: [{ type: 'text', text: 'active' }], clientMessageId: 'cm-1' });
    await waitFor(() => service.busy, 3000, 'turn active');

    service.notifyLaunchConfigChange({ codexHome: '/tmp/other' }, 'fp-2');
    const second = service.enqueueOperation({ kind: 'send', threadId: service.rootThreadId,
      markerPayload: { input: [{ type: 'text', text: 'next' }] } });

    releaseApproval();
    const firstResult = await first;
    assert.equal(firstResult.outcome, 'completed');
    const secondResult = await Promise.race([second.promise,
      new Promise((resolve) => setTimeout(() => resolve({ outcome: 'timed-out' }), 3000))]);
    assert.equal(secondResult.outcome, 'completed', 'queued send must not be cancelled by the rebuild');
    await waitFor(() => service.runtimeGeneration === 2, 3000, 'rebuild after the queue drains');
  } finally { await service.resetRuntime(); }
});


// ---------------------------------------------------------------------------
// 4.1 persistent connection and thread reuse
// ---------------------------------------------------------------------------

test('three consecutive sends share one connection and one thread', async () => {
  const { service, dispatchCounts, events } = makeService({ scenario: 'early-notification' });
  try {
    const first = await service.send({ input: [{ type: 'text', text: 'one' }], clientMessageId: 'cm-1' });
    assert.equal(first.outcome, 'completed');
    const threadId = eventsOf(events, 'threadStarted')[0]?.threadId;
    assert.ok(threadId, 'thread started and surfaced');

    const second = await service.send({ threadId, input: [{ type: 'text', text: 'two' }], clientMessageId: 'cm-2' });
    const third = await service.send({ threadId, input: [{ type: 'text', text: 'three' }], clientMessageId: 'cm-3' });
    assert.equal(second.outcome, 'completed');
    assert.equal(third.outcome, 'completed');

    assert.equal(dispatchCounts.get('thread/start'), 1, 'exactly one thread/start');
    assert.equal(dispatchCounts.get('initialize'), 1, 'connection reused across turns');
    assert.equal(dispatchCounts.get('turn/start'), 3, 'three distinct turns');
    assert.equal(service.runtimeGeneration, 1, 'one runtime generation');
  } finally {
    await service.resetRuntime();
  }
});

// ---------------------------------------------------------------------------
// 4.2 notifications before ack bind the operation
// ---------------------------------------------------------------------------

test('turn/started before the ack binds the operation; terminal settles once', async () => {
  const { service, events } = makeService({ scenario: 'early-notification' });
  try {
    const result = await service.send({ input: [{ type: 'text', text: 'hi' }], clientMessageId: 'cm-1' });
    assert.equal(result.outcome, 'completed');

    const started = eventsOf(events, 'turnStarted');
    assert.equal(started.length, 1);
    assert.ok(started[0].clientOperationId, 'notification bound to the operation before the ack');
    const done = eventsOf(events, 'operationDone');
    assert.equal(done.length, 1, 'exactly one operation done');
    assert.equal(done[0].payload.outcome, 'completed');
  } finally {
    await service.resetRuntime();
  }
});

test('completed native items retain stable ids in the legacy display marker', async () => {
  const markers = [];
  const { service } = makeService({
    scenario: 'early-notification',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) },
  });
  try {
    const result = await service.send({
      input: [{ type: 'text', text: 'show item' }],
      clientMessageId: 'cm-item-1',
    });
    assert.equal(result.outcome, 'completed');
    const itemMarker = markers.find((marker) => String(marker).includes('item-agent-1'));
    assert.ok(itemMarker, 'native item id is preserved in the marker');
    assert.match(itemMarker, /Hello from peer/);
  } finally {
    await service.resetRuntime();
  }
});

// ---------------------------------------------------------------------------
// 4.3 session FIFO
// ---------------------------------------------------------------------------

test('messages sent during an active turn queue and dispatch in order', async () => {
  const { service, dispatchCounts } = makeService({ scenario: 'reverse-approval' });
  try {
    await service.ensureRuntime();
    // Block the approval so the first turn stays active.
    let releaseApproval;
    const gate = new Promise((resolvePromise) => { releaseApproval = resolvePromise; });
    service.client.onServerRequest = async () => {
      await gate;
      return { decision: 'accept' };
    };

    const first = service.send({ input: [{ type: 'text', text: 'first' }], clientMessageId: 'cm-1' });
    await waitFor(() => service.busy, 3000, 'first turn active');
    const second = service.send({ input: [{ type: 'text', text: 'second' }], clientMessageId: 'cm-2' });
    assert.equal(service.queue.length, 1, 'second message queued, not dispatched');

    releaseApproval();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.outcome, 'completed');
    assert.equal(r2.outcome, 'completed');
    assert.equal(dispatchCounts.get('turn/start'), 2, 'second turn dispatched only after the first terminal');
    assert.equal(service.busy, false);
  } finally {
    await service.resetRuntime();
  }
});

// ---------------------------------------------------------------------------
// 4.4 single finalization
// ---------------------------------------------------------------------------

test('duplicate terminal and late items settle the operation exactly once', async () => {
  const { service, events } = makeService({ scenario: 'duplicate-terminal' });
  try {
    const result = await service.send({ input: [{ type: 'text', text: 'x' }], clientMessageId: 'cm-1' });
    assert.equal(result.outcome, 'completed');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(eventsOf(events, 'operationDone').length, 1, 'one finalization despite duplicates');
    assert.equal(service.busy, false);
  } finally {
    await service.resetRuntime();
  }
});

test('a broken input pipe ends acknowledged and queued operations without exposing credentials', async () => {
  const { service, getClient, getPeer, events } = makeService({ scenario: 'never-respond',
    clientOpts: { env: { OPENAI_API_KEY: 'synthetic-pipe-secret' } } });
  let failures = 0;
  service.on('runtimeFailed', () => { failures += 1; });
  try {
    const first = service.send({ input: [{ type: 'text', text: 'first' }], clientMessageId: 'pipe-first' });
    await waitFor(() => [...service.operations.values()][0]?.nativeTurnId);
    const operation = [...service.operations.values()][0];
    for (const id of getPeer().pendingAcks.keys()) {
      getPeer().ackPending(id, { turn: { id: operation.nativeTurnId } });
    }
    await waitFor(() => eventsOf(events, 'operationAcked').length === 1);
    const second = service.send({ input: [{ type: 'text', text: 'queued' }], clientMessageId: 'pipe-second' });
    // The peer's readable side shares its in-memory pipe; emit the transport
    // event here to avoid manufacturing an unrelated readline error.
    getClient().emit('stdinError', new Error(getClient().sanitizeDiagnostic('broken pipe synthetic-pipe-secret')));
    assert.equal(service.busy, false);
    assert.equal(service.queue.length, 0);
    assert.equal((await first).outcome, 'failed');
    assert.equal((await second).outcome, 'failed');
    assert.equal(failures, 1);
    assert.equal(eventsOf(events, 'operationDone').length, 2);
    assert.ok(!JSON.stringify(eventsOf(events, 'operationDone')).includes('synthetic-pipe-secret'));
    await getClient().waitForExit();
    assert.equal(failures, 1);
  } finally { await service.resetRuntime(); }
});

// ---------------------------------------------------------------------------
// CLI startup fallback
// ---------------------------------------------------------------------------

/** A client whose handshake dies exactly like a broken Codex CLI install. */
function makeDeadClient(label, stderr) {
  const dead = new EventEmitter();
  dead.command = [label];
  dead.close = () => {};
  dead.closeRequested = false;
  dead.processExited = true;
  dead.exitSettled = true;
  dead.waitForExit = async () => {};
  dead.ensureInitialized = async () => {
    const error = new ClassifiedError('CHILD_EXITED', 'codex app-server exited (code=1, signal=null)');
    error.startupFailure = true;
    error.details = { exitPhase: 'startup', command: [label], stderr };
    throw error;
  };
  return dead;
}

test('a CLI that dies before READY falls back to the next resolved candidate', async () => {
  const fixture = makeService({ scenario: 'early-notification', serviceOpts: { startupAttempts: 2 } });
  const { service } = fixture;
  const workingFactory = service.clientFactory;
  const fallbacks = [];
  service.on('runtimeFallback', (event) => fallbacks.push(event));
  let calls = 0;
  service.clientFactory = async () => {
    calls += 1;
    return calls === 1 ? makeDeadClient('broken-cli', 'spawn vendor/codex ENOENT') : workingFactory();
  };
  service.clientFactory.advance = () => ({ label: 'working-cli', command: ['working-cli'] });
  try {
    await service.ensureRuntime();
    assert.equal(service.state, 'ready');
    assert.equal(calls, 2, 'the fallback candidate started a runtime');
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].from, 'broken-cli');
    assert.equal(fallbacks[0].to, 'working-cli');
    assert.match(fallbacks[0].reason, /codex app-server exited/);
  } finally { await service.resetRuntime(); }
});

test('exhausted candidates settle the turn with every CLI attempt and the fix hint', async () => {
  const fixture = makeService({ scenario: 'early-notification', serviceOpts: { startupAttempts: 2 } });
  const { service } = fixture;
  let calls = 0;
  service.clientFactory = async () => {
    calls += 1;
    return makeDeadClient(calls === 1 ? 'first-cli' : 'second-cli', 'spawn vendor/codex ENOENT');
  };
  service.clientFactory.advance = () => ({ label: 'second-cli', command: ['second-cli'] });
  try {
    const result = await service.send({ input: [{ type: 'text', text: 'hello' }], clientMessageId: 'cm-cli' });
    assert.equal(result.outcome, 'failed');
    // The canonical line stays first: other consumers match on it.
    assert.match(result.error, /^codex runtime failure: codex app-server exited \(code=1, signal=null\)/);
    assert.match(result.error, /first-cli: codex app-server exited/);
    assert.match(result.error, /second-cli: codex app-server exited/);
    assert.match(result.error, /spawn vendor\/codex ENOENT/);
    assert.match(result.error, /Codex CLI check/);
  } finally { await service.resetRuntime(); }
});

test('a transport event before the handshake rejects does not pre-empt the fallback', async () => {
  // The real client emits `exited` synchronously from its child handler, before
  // the pending handshake promise rejects. Failing the runtime from that event
  // would abort the startup loop and report a bare exit code instead of moving
  // on to the next CLI candidate.
  const fixture = makeService({ scenario: 'early-notification', serviceOpts: { startupAttempts: 2 } });
  const { service } = fixture;
  const workingFactory = service.clientFactory;
  const fallbacks = [];
  service.on('runtimeFallback', (event) => fallbacks.push(event));
  let calls = 0;
  service.clientFactory = async () => {
    calls += 1;
    if (calls > 1) {
      return workingFactory();
    }
    const dead = makeDeadClient('broken-cli', 'spawn vendor/codex ENOENT');
    const reject = dead.ensureInitialized;
    dead.ensureInitialized = async () => {
      const error = await reject().then(() => null, (failure) => failure);
      dead.emit('exited', error);
      throw error;
    };
    return dead;
  };
  service.clientFactory.advance = () => ({ label: 'working-cli', command: ['working-cli'] });
  try {
    await service.ensureRuntime();
    assert.equal(service.state, 'ready');
    assert.equal(calls, 2);
    assert.equal(fallbacks.length, 1);
    // The failed candidate must not have finalized the runtime: a stuck
    // failure gate would swallow every later failure of the recovered runtime.
    assert.equal(service.failureSettled, false);
  } finally { await service.resetRuntime(); }
});

test('a startup error is not retried when only one candidate was resolved', async () => {
  const fixture = makeService({ scenario: 'early-notification' });
  const { service } = fixture;
  let calls = 0;
  service.clientFactory = async () => {
    calls += 1;
    return makeDeadClient('only-cli', '');
  };
  service.clientFactory.advance = () => ({ label: 'never-used', command: ['never-used'] });
  try {
    const result = await service.send({ input: [{ type: 'text', text: 'hello' }], clientMessageId: 'cm-one' });
    assert.equal(result.outcome, 'failed');
    assert.equal(calls, 1);
    assert.match(result.error, /only-cli/);
  } finally { await service.resetRuntime(); }
});

test('child exit after ack fails the runtime once and settles pending once', async () => {
  const { service, events } = makeService({ scenario: 'disconnect-mid-turn' });
  let runtimeFailures = 0;
  service.on('runtimeFailed', () => { runtimeFailures += 1; });
  try {
    const result = await service.send({ input: [{ type: 'text', text: 'x' }], clientMessageId: 'cm-1' });
    assert.equal(result.outcome, 'failed');
    assert.equal(service.state, 'failed');
    assert.equal(eventsOf(events, 'operationDone').length, 1, 'one failure finalization');
    assert.equal(runtimeFailures, 1, 'runtime failure surfaced once');
  } finally {
    if (service.client) {
      service.client.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 4.5 stop semantics
// ---------------------------------------------------------------------------

test('stop before write cancels locally with zero operation RPC', async () => {
  const { service, dispatchCounts } = makeService({ scenario: 'reverse-approval' });
  try {
    await service.ensureRuntime();
    let releaseApproval;
    const gate = new Promise((resolvePromise) => { releaseApproval = resolvePromise; });
    service.client.onServerRequest = async () => {
      await gate;
      return { decision: 'accept' };
    };

    const first = service.send({ input: [{ type: 'text', text: 'first' }], clientMessageId: 'cm-1' });
    await waitFor(() => service.busy, 3000, 'first turn active');

    const queued = service.send({ input: [{ type: 'text', text: 'second' }], clientMessageId: 'cm-2' });
    const queuedOp = [...service.operations.values()].find(
      (op) => op.clientMessageId === 'cm-2'
    );
    assert.ok(queuedOp, 'queued operation registered');
    const stopResult = service.stopOperation(queuedOp.clientOperationId);
    assert.equal(stopResult.reason, 'cancelled-locally');
    assert.equal(service.queue.length, 0, 'dequeued without dispatch');

    releaseApproval();
    await first;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(dispatchCounts.get('turn/start'), 1, 'stopped operation never wrote turn/start');
  } finally {
    await service.resetRuntime();
  }
});

test('stop with a known native turn interrupts and waits for the terminal', async () => {
  const { service, events, dispatchCounts } = makeService({ scenario: 'reverse-approval' });
  try {
    await service.ensureRuntime();
    const pending = service.send({ input: [{ type: 'text', text: 'long work' }], clientMessageId: 'cm-1' });
    await waitFor(() => {
      const op = [...service.operations.values()][0];
      return op && op.dispatchPhase === 'nativeTurnKnown';
    }, 3000, 'native turn known');

    const stopResult = service.stopOperation([...service.operations.values()][0].clientOperationId);
    assert.equal(stopResult.reason, 'interrupted');
    const result = await pending;
    assert.equal(result.outcome, 'interrupted', 'native terminal (not the ack) ends the turn');
    assert.equal(dispatchCounts.get('turn/interrupt'), 1);
    const done = eventsOf(events, 'operationDone');
    assert.equal(done.length, 1);
    assert.equal(done[0].payload.outcome, 'interrupted');
  } finally {
    await service.resetRuntime();
  }
});

test('stop with unknown identity keeps the cancel intent, then closes the child', async () => {
  const { service, getClient, events } = makeService({ scenario: 'silent-start' });
  try {
    const sendPromise = service.send({ input: [{ type: 'text', text: 'unknown identity' }], clientMessageId: 'cm-1' });
    await waitFor(() => service.busy, 3000, 'operation dispatched');
    const op = [...service.operations.values()][0];
    assert.equal(op.dispatchPhase, 'writtenUnconfirmed');

    const stopResult = service.stopOperation(op.clientOperationId);
    assert.equal(stopResult.reason, 'cancel-intent-armed');

    const result = await sendPromise;
    assert.equal(result.outcome, 'failed', 'unreconcilable operation fails once after child exit');
    const done = eventsOf(events, 'operationDone');
    assert.equal(done.length, 1);
    const unhealthy = eventsOf(events, 'runtimeUnhealthy');
    assert.equal(unhealthy.length >= 1, true, 'uncertain runtime surfaced as unhealthy');
    assert.ok(!getClient()?.alive, 'child closed after the budget');
  } finally {
    if (service.client) {
      service.client.close();
    }
  }
});

test('stop during an unconfirmed bootstrap never starts the operation', async () => {
  const { service, dispatchCounts, getClient } = makeService({ scenario: 'resume-metadata-only' });
  try {
    await service.ensureRuntime();
    // Gate the resume so the bootstrap window is observable.
    let releaseResume;
    const gate = new Promise((resolvePromise) => { releaseResume = resolvePromise; });
    const client = getClient();
    const originalRequest = client.request.bind(client);
    client.request = (method, params, opts) => {
      if (method === 'thread/resume') {
        return gate.then(() => originalRequest(method, params, opts));
      }
      return originalRequest(method, params, opts);
    };

    const op = service.enqueueOperation({ kind: 'send', threadId: 'th-test-root-0001', clientMessageId: 'cm-1' });
    await waitFor(() => service.bootstrapInFlight, 2000, 'bootstrap in flight');
    const stopResult = service.stopOperation(op.clientOperationId);
    assert.equal(stopResult.reason, 'waiting-for-bootstrap');

    releaseResume();
    const result = await op.promise;
    assert.equal(result.outcome, 'cancelled', 'cancelled after bootstrap without any RPC');
    assert.equal(dispatchCounts.get('turn/start') ?? 0, 0, 'no turn/start after stopped bootstrap');
    assert.equal(dispatchCounts.get('thread/resume'), 1, 'resume confirmed exactly once');
  } finally {
    await service.resetRuntime();
  }
});

// ---------------------------------------------------------------------------
// 4.6 recovery and rebuild
// ---------------------------------------------------------------------------

test('after a disconnect the next send resumes the thread without resending tasks', async () => {
  const { service, dispatchCounts, events } = makeService({ scenario: 'disconnect-mid-turn' });
  try {
    const first = await service.send({ input: [{ type: 'text', text: 'doomed turn' }], clientMessageId: 'cm-1' });
    assert.equal(first.outcome, 'failed');
    const threadId = eventsOf(events, 'turnStarted')[0]?.threadId;

    // Swap to a healthy scenario client for the recovery path.
    const clientToPeer = new PassThrough();
    const peerToClient = new PassThrough();
    const peerStderr = new PassThrough();
    const peer = startPeerWithStreams({
      scenario: 'early-notification',
      input: clientToPeer,
      output: peerToClient,
      stderr: peerStderr,
      onExit: () => {},
    });
    service.clientFactory = () => new CodexAppServerClient({
      command: ['in-process-peer'],
      spawnFn: () => ({
        stdin: clientToPeer, stdout: peerToClient, stderr: peerStderr, pid: -1, on: () => {}, kill: () => true,
      }),
    });

    const second = await service.send({ threadId, input: [{ type: 'text', text: 'fresh turn' }], clientMessageId: 'cm-2' });
    assert.equal(second.outcome, 'completed');
    assert.equal(dispatchCounts.get('thread/resume') ?? 0, 0, 'first peer saw no resume');
    assert.equal(service.runtimeGeneration, 2, 'a fresh runtime generation');
  } finally {
    if (service.client) {
      service.client.close();
    }
  }
});

test('launch-config change rebuilds at the idle boundary and cold-resumes', async () => {
  const { service, events } = makeService({ scenario: 'early-notification' });
  try {
    const first = await service.send({ input: [{ type: 'text', text: 'before rebuild' }], clientMessageId: 'cm-1' });
    assert.equal(first.outcome, 'completed');
    const generationBefore = service.runtimeGeneration;

    const rebuild = service.notifyLaunchConfigChange({ codexHome: '/tmp/other' }, 'fingerprint-2');
    assert.equal(rebuild.rebuild, 'immediate', 'rebuild ran immediately at the idle boundary');
    await waitFor(() => service.runtimeGeneration === generationBefore + 1, 3000, 'runtime rebuilt');
    assert.equal(service.state, 'ready');

    // Cold resume reapplies the role: threadResumed after the rebuild.
    const resumed = eventsOf(events, 'threadResumed');
    assert.equal(resumed.length >= 1, true, 'thread cold-resumed after rebuild');
  } finally {
    await service.resetRuntime();
  }
});

test('launch-config change during an active turn waits for the boundary', async () => {
  const { service } = makeService({ scenario: 'reverse-approval' });
  try {
    await service.ensureRuntime();
    let releaseApproval;
    const gate = new Promise((resolvePromise) => { releaseApproval = resolvePromise; });
    service.client.onServerRequest = async () => {
      await gate;
      return { decision: 'accept' };
    };
    const first = service.send({ input: [{ type: 'text', text: 'active' }], clientMessageId: 'cm-1' });
    await waitFor(() => service.busy, 3000, 'turn active');

    const generationBefore = service.runtimeGeneration;
    const rebuild = service.notifyLaunchConfigChange({ codexHome: '/tmp/other' }, 'fp-2');
    assert.equal(rebuild.rebuild, 'deferred', 'rebuild deferred while busy');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(service.runtimeGeneration, generationBefore, 'no rebuild mid-turn');

    releaseApproval();
    await first;
    await waitFor(() => service.runtimeGeneration === generationBefore + 1, 3000, 'rebuild after terminal');
  } finally {
    await service.resetRuntime();
  }
});

// ---------------------------------------------------------------------------
// 4.8 settings revision gate
// ---------------------------------------------------------------------------

test('preconnect and compact share a single thread resume before claiming its writer', async () => {
  const { service, getClient, dispatchCounts } = makeService();
  let releaseResume;
  try {
    await service.ensureRuntime();
    const gate = new Promise(resolve => { releaseResume = resolve; });
    const client = getClient();
    const request = client.request.bind(client);
    let resumes = 0;
    client.request = (method, params, options) => {
      if (method !== 'thread/resume') return request(method, params, options);
      resumes += 1;
      if (resumes > 1) return Promise.reject(new Error(`thread ${params.threadId} already has an active writer`));
      return gate.then(() => request(method, params, options));
    };
    const threadId = 'th-test-root-0001';
    const preconnect = service.preconnect({ threadId });
    await waitFor(() => resumes === 1);
    const compact = service.compact({ threadId });
    await new Promise(resolve => setImmediate(resolve));
    releaseResume();
    await preconnect;
    assert.equal((await compact).outcome, 'completed');
    assert.equal(resumes, 1);
    assert.equal(dispatchCounts.get('thread/compact/start'), 1);
    assert.equal(dispatchCounts.get('turn/start') ?? 0, 0);
  } finally {
    releaseResume?.();
    await service.resetRuntime();
  }
});

test('a shared resume rejection fails compact truthfully and a later explicit request can resume', async () => {
  const { service, getClient } = makeService();
  let releaseResume;
  try {
    await service.ensureRuntime();
    const gate = new Promise(resolve => { releaseResume = resolve; });
    const client = getClient();
    const request = client.request.bind(client);
    let resumes = 0;
    client.request = (method, params, options) => {
      if (method !== 'thread/resume') return request(method, params, options);
      resumes += 1;
      if (resumes === 1) return gate.then(() => { throw new Error(`thread ${params.threadId} already has an active writer`); });
      return request(method, params, options);
    };
    const threadId = 'th-test-root-0001';
    const preconnect = service.preconnect({ threadId });
    const failedResume = assert.rejects(preconnect, /already has an active writer/);
    await waitFor(() => resumes === 1);
    const compact = service.compact({ threadId });
    await new Promise(resolve => setImmediate(resolve));
    releaseResume();
    await failedResume;
    const result = await compact;
    assert.equal(result.outcome, 'failed');
    assert.match(result.error, /already has an active writer/);
    assert.equal(resumes, 1);
    assert.equal((await service.compact({ threadId })).outcome, 'completed');
    assert.equal(resumes, 2);
  } finally {
    releaseResume?.();
    await service.resetRuntime();
  }
});

test('compact waits for the effective settings notification before starting', async () => {
  const { service, dispatchCounts, dispatched } = makeService({ scenario: 'early-notification' });
  try {
    await service.ensureRuntime();
    const send = await service.send({ input: [{ type: 'text', text: 'seed turn' }], clientMessageId: 'cm-1' });
    assert.equal(send.outcome, 'completed');
    const threadId = service.rootThreadId;

    service.updateSettings({ model: 'gpt-6.1-sol', effort: 'high' });
    const compactResult = await service.compact({ threadId });
    assert.equal(compactResult.outcome, 'completed', 'compact completed after settings applied');
    assert.equal(dispatchCounts.get('thread/settings/update'), 1, 'settings applied first');
    assert.equal(dispatchCounts.get('thread/compact/start'), 1, 'compact started after the gate');
    const settingsRequest = dispatched.find((request) => request.method === 'thread/settings/update');
    assert.equal(settingsRequest.params.threadId, threadId);
    assert.equal(settingsRequest.params.revision, undefined, 'internal revision never crosses the protocol');
  } finally {
    await service.resetRuntime();
  }
});

test('compact applies and confirms an explicitly cleared service tier', async () => {
  const { service, getClient, dispatchCounts, dispatched } = makeService();
  try {
    await service.preconnect({ threadId: THREAD_ID });
    getClient().emit('notification', { method: 'thread/settings/updated', params: {
      threadId: THREAD_ID, threadSettings: { ...service.effectiveSettings, serviceTier: 'fast' },
    } });
    service.updateSettings({ serviceTier: null });
    assert.equal((await service.compact()).outcome, 'completed');
    assert.equal(dispatchCounts.get('thread/settings/update'), 1,
      'compaction must use the tier selected after the preceding Fast turn');
    assert.equal(dispatched.find(call => call.method === 'thread/settings/update').params.serviceTier, null);
    assert.equal(service.effectiveSettings.serviceTier, 'default');
  } finally { await service.resetRuntime(); }
});

test('a resumed null service tier remains a confirmed setting rather than an unknown value', async () => {
  const { service, getClient, dispatchCounts } = makeService();
  try {
    await service.ensureRuntime();
    const client = getClient();
    const request = client.request.bind(client);
    client.request = async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === 'thread/resume') {
        result.serviceTier = null;
        delete result.thread.serviceTier;
      }
      return result;
    };
    const operation = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID,
      settings: { serviceTier: null } });
    assert.equal((await operation.promise).outcome, 'completed');
    assert.equal(service.effectiveSettings.serviceTier, null);
    assert.equal(dispatchCounts.get('thread/settings/update') ?? 0, 0);
  } finally { await service.resetRuntime(); }
});

test('compact recognizes native Fast and standard tier normalization without rewriting its frozen settings', async () => {
  for (const [requested, effective] of [['fast', 'priority'], [null, 'default']]) {
    const { service, getClient, dispatchCounts } = makeService({ serviceOpts: { stopBudgetMs: 40 } });
    try {
      await service.preconnect({ threadId: THREAD_ID });
      getClient().emit('notification', { method: 'thread/settings/updated', params: {
        threadId: THREAD_ID, threadSettings: { ...service.effectiveSettings, serviceTier: effective },
      } });
      const operation = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID,
        settings: { serviceTier: requested } });
      assert.equal((await operation.promise).outcome, 'completed');
      assert.equal(dispatchCounts.get('thread/settings/update') ?? 0, 0);
      assert.equal(operation.frozenSettings.serviceTier, requested);
      assert.equal(service.settingsMatchesEffective({ serviceTier: 'flex' }), false);
    } finally { await service.resetRuntime(); }
  }
});

test('compact accepts the native built-in collaboration instructions requested with null', async () => {
  const { service, getClient, dispatchCounts } = makeService({ serviceOpts: { stopBudgetMs: 40 } });
  try {
    await service.send({ input: [{ type: 'text', text: 'seed settings' }] });
    const client = getClient();
    const request = client.request.bind(client);
    client.request = (method, params, options) => {
      if (method !== 'thread/settings/update') return request(method, params, options);
      queueMicrotask(() => client.emit('notification', { method: 'thread/settings/updated', params: {
        threadId: params.threadId, threadSettings: { ...params, collaborationMode: {
          ...params.collaborationMode, settings: { ...params.collaborationMode.settings,
            developer_instructions: 'Built-in instructions selected by the native mode preset' },
        } },
      } }));
      return Promise.resolve({});
    };
    service.updateSettings({ model: 'gpt-6.1-sol', effort: 'high', collaborationMode: {
      mode: 'default', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'high', developer_instructions: null },
    } });
    const result = await service.compact();
    assert.equal(result.outcome, 'completed');
    assert.equal(dispatchCounts.get('thread/compact/start'), 1);
    assert.equal(service.state, 'ready');
  } finally { await service.resetRuntime(); }
});

test('a first compact restores the root settings without preconnect or bindThread', async () => {
  const { service, dispatchCounts } = makeService({ serviceOpts: { stopBudgetMs: 40 } });
  try {
    const operation = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID });
    assert.equal((await operation.promise).outcome, 'completed');
    assert.equal(dispatchCounts.get('thread/compact/start'), 1);
    assert.equal(service.rootThreadId, THREAD_ID);
    assert.equal(service.effectiveSettings.model, 'test-model');
  } finally { await service.resetRuntime(); }
});

test('compact freezes desired policies together with its per-operation working directory', async () => {
  const { service, dispatched } = makeService({ serviceOpts: { stopBudgetMs: 40 } });
  try {
    service.updateSettings({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
      collaborationMode: { mode: 'plan', settings: { model: '', reasoning_effort: null, developer_instructions: null } } });
    const operation = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID,
      settings: { cwd: '/selected', cwdExplicit: true, model: 'selected-model', effort: 'max' } });
    service.updateSettings({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    assert.equal((await operation.promise).outcome, 'completed');
    const request = dispatched.find(entry => entry.method === 'thread/settings/update').params;
    assert.equal(request.cwd, '/selected');
    assert.equal(request.approvalPolicy, 'on-request');
    assert.equal(request.approvalsReviewer, 'user');
    assert.equal(request.sandboxPolicy.type, 'readOnly');
    assert.equal(request.collaborationMode.mode, 'plan');
    assert.equal(request.collaborationMode.settings.model, 'selected-model');
    assert.equal(request.collaborationMode.settings.reasoning_effort, 'max');
    assert.equal(operation.frozenSettings.approvalPolicy, 'on-request');
  } finally { await service.resetRuntime(); }
});

test('unconfirmed compact settings fail visibly before retiring the runtime rather than becoming cancelled', async () => {
  const { service, getClient, events, dispatchCounts } = makeService({ serviceOpts: { stopBudgetMs: 40 } });
  try {
    await service.send({ input: [{ type: 'text', text: 'seed settings' }] });
    const client = getClient();
    const request = client.request.bind(client);
    client.request = (method, params, options) => method === 'thread/settings/update'
      ? Promise.resolve({}) : request(method, params, options);
    service.updateSettings({ model: 'another-model' });
    const result = await service.compact();
    assert.equal(result.outcome, 'failed');
    assert.match(result.error, /settings.*take effect/i);
    assert.equal(eventsOf(events, 'operationDone').at(-1).payload.outcome, 'failed');
    assert.equal(dispatchCounts.get('thread/compact/start') ?? 0, 0);
    assert.equal(service.state, 'stopped');
    assert.equal((await service.send({ input: [{ type: 'text', text: 'send after failed compact' }] })).outcome, 'completed');
    assert.equal(service.runtimeGeneration, 2);
  } finally { await service.resetRuntime(); }
});

test('a cancelled settings wait cannot retire the subsequent send', async () => {
  const { service, getClient, getPeer, dispatchCounts } = makeService({
    scenario: 'never-respond', serviceOpts: { stopBudgetMs: 80 },
  });
  try {
    await service.preconnect({ threadId: THREAD_ID });
    const client = getClient();
    const request = client.request.bind(client);
    let settingsWritten = false;
    client.request = (method, params, options) => {
      if (method !== 'thread/settings/update') return request(method, params, options);
      settingsWritten = true;
      return Promise.resolve({});
    };
    service.updateSettings({ model: 'selected-model' });
    const compact = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID });
    await waitFor(() => settingsWritten);
    service.stopOperation(compact.clientOperationId);
    assert.equal((await compact.promise).outcome, 'cancelled');
    const send = service.enqueueOperation({ kind: 'send', threadId: THREAD_ID,
      markerPayload: { input: [{ type: 'text', text: 'continue after stop' }] } });
    await waitFor(() => send.nativeTurnId);
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(send.settled, false, 'the old control no longer owns the new turn');
    assert.equal(service.state, 'ready');
    assert.equal(service.runtimeGeneration, 1);
    assert.equal(dispatchCounts.get('thread/compact/start') ?? 0, 0);
    const peer = getPeer();
    for (const id of peer.pendingAcks.keys()) peer.ackPending(id, { turn: { id: send.nativeTurnId } });
    peer.notify({ method: 'turn/completed', params: { threadId: THREAD_ID,
      turn: { id: send.nativeTurnId, status: 'completed' } } });
    assert.equal((await send.promise).outcome, 'completed');
  } finally { await service.resetRuntime(); }
});

test('a cancelled settings RPC cannot clear the later compaction confirmation gate', async () => {
  const { service, getClient, dispatchCounts } = makeService({ serviceOpts: { stopBudgetMs: 200 } });
  let rejectFirst;
  try {
    await service.preconnect({ threadId: THREAD_ID });
    const client = getClient();
    const request = client.request.bind(client);
    let calls = 0;
    let nextSettings;
    client.request = (method, params, options) => {
      if (method !== 'thread/settings/update') return request(method, params, options);
      calls += 1;
      if (calls === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
      nextSettings = params;
      return Promise.resolve({});
    };
    service.updateSettings({ model: 'first-model' });
    const first = service.enqueueOperation({ kind: 'compact', threadId: THREAD_ID });
    await waitFor(() => calls === 1);
    service.stopOperation(first.clientOperationId);
    assert.equal((await first.promise).outcome, 'cancelled');
    service.updateSettings({ model: 'next-model' });
    const next = service.compact({ threadId: THREAD_ID });
    await waitFor(() => calls === 2);
    rejectFirst(new ClassifiedError('RPC_TIMEOUT', 'the cancelled settings request timed out', {
      phase: 'writtenUnconfirmed',
    }));
    await new Promise(resolve => setImmediate(resolve));
    client.emit('notification', { method: 'thread/settings/updated', params: {
      threadId: THREAD_ID, threadSettings: nextSettings,
    } });
    assert.equal((await next).outcome, 'completed');
    assert.equal(service.runtimeGeneration, 1);
    assert.equal(dispatchCounts.get('thread/compact/start'), 1);
  } finally {
    rejectFirst?.(new Error('fixture cleanup'));
    await service.resetRuntime();
  }
});

test('manual compact without a loaded thread is rejected before dispatch', async () => {
  const { service, dispatchCounts } = makeService({ scenario: 'early-notification' });
  try {
    await assert.rejects(
      service.compact(),
      (error) => error?.code === 'NO_THREAD',
    );
    assert.equal(dispatchCounts.get('thread/start') ?? 0, 0);
    assert.equal(dispatchCounts.get('thread/compact/start') ?? 0, 0);
  } finally {
    await service.resetRuntime();
  }
});

test('duplicate pending compaction requests share one native operation', async () => {
  const { service, dispatchCounts } = makeService({ scenario: 'early-notification' });
  try {
    const seeded = await service.send({ input: [{ type: 'text', text: 'seed' }], clientMessageId: 'cm-seed' });
    assert.equal(seeded.outcome, 'completed');
    const threadId = service.rootThreadId;
    const first = service.compact({ threadId });
    const second = service.compact({ threadId });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult, secondResult, 'both callers observe the same operation result');
    assert.equal(dispatchCounts.get('thread/compact/start'), 1);
  } finally {
    await service.resetRuntime();
  }
});

test('queued compact can be cancelled before its native RPC is written', async () => {
  const { service, dispatchCounts, events } = makeService({ scenario: 'reverse-approval' });
  try {
    await service.ensureRuntime();
    const first = service.send({ input: [{ type: 'text', text: 'active' }], clientMessageId: 'cm-active' });
    await waitFor(() => service.busy && service.rootThreadId, 3000, 'active turn');
    const threadId = service.rootThreadId;
    const compact = service.compact({ threadId });
    const cancellation = service.cancelPendingOperation('compact', threadId);
    assert.equal(cancellation.reason, 'cancelled-locally');
    assert.equal((await compact).outcome, 'cancelled');
    const interaction = eventsOf(events, 'interactionRequested')[0];
    assert.ok(interaction, 'active turn is waiting for an interaction');
    service.respondInteraction(interaction.payload.rpcId, { decision: 'accept' });
    await first;
    assert.equal(dispatchCounts.get('thread/compact/start') ?? 0, 0);
  } finally {
    await service.resetRuntime();
  }
});

test('manual compact exposes the native contextCompaction item before terminal', async () => {
  const markers = [];
  const { service, events } = makeService({
    scenario: 'early-notification',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) },
  });
  try {
    await service.send({ input: [{ type: 'text', text: 'seed compact' }], clientMessageId: 'cm-seed' });
    const result = await service.compact({ threadId: service.rootThreadId });
    assert.equal(result.outcome, 'completed');
    const compactItems = markers.filter((marker) => String(marker).includes('isCompactSummary'));
    const compactItem = compactItems.at(-1);
    assert.ok(compactItem, 'compact item is rendered as a native summary marker');
    assert.match(compactItem, /manual compact summary/);
    assert.match(compactItems[0], /inProgress/);
    assert.equal(JSON.parse(compactItems[0].slice('[MESSAGE] '.length)).uuid,
      JSON.parse(compactItem.slice('[MESSAGE] '.length)).uuid);
    assert.equal(eventsOf(events, 'operationDone').at(-1).payload.kind, 'compact');
  } finally {
    await service.resetRuntime();
  }
});

test('automatic context compaction keeps the enclosing send operation active', async () => {
  const markers = [];
  const { service, events, getClient } = makeService({
    scenario: 'reverse-approval',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) },
  });
  try {
    const send = service.send({
      input: [{ type: 'text', text: 'auto compact while waiting' }],
      clientMessageId: 'cm-auto-compact',
    });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'approval request');
    getClient().emit('notification', {
      method: 'item/completed',
      params: {
        threadId: service.rootThreadId,
        turnId: 'turn-test-0001',
        item: { id: 'auto-compact-1', type: 'contextCompaction', text: 'automatic summary' },
      },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    const summary = markers.find((marker) => String(marker).includes('automatic summary'));
    assert.ok(summary, 'automatic compact summary is emitted');
    assert.match(summary, /"trigger":"auto"/);
    assert.equal(service.busy, true, 'automatic compaction does not release the send FIFO');
    const interaction = eventsOf(events, 'interactionRequested')[0];
    service.respondInteraction(interaction.payload.rpcId, { decision: 'accept' });
    assert.equal((await send).outcome, 'completed');
  } finally {
    await service.resetRuntime();
  }
});

test('summaryless thread/compacted emits a completed native boundary without finishing the enclosing send', async () => {
  const markers = [];
  const { service, events, getClient } = makeService({ scenario: 'reverse-approval',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) } });
  try {
    const send = service.send({ input: [{ type: 'text', text: 'compact automatically' }], clientMessageId: 'cm-empty-compact' });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'approval request');
    getClient().emit('notification', { method: 'thread/compacted',
      params: { threadId: service.rootThreadId, turnId: 'turn-test-0001' } });
    const summary = markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length))).find(message => message.isCompactSummary);
    assert.equal(summary?.summarizeMetadata?.status, 'completed');
    assert.equal(summary?.summarizeMetadata?.native, true);
    assert.equal(service.busy, true);
    const interaction = eventsOf(events, 'interactionRequested')[0];
    service.respondInteraction(interaction.payload.rpcId, { decision: 'accept' });
    await send;
  } finally { await service.resetRuntime(); }
});

test('a legacy empty content snapshot cannot mask the subsequent native text deltas', async () => {
  const markers = [];
  const { service, events } = makeService({ scenario: 'streaming-before-terminal',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) } });
  try {
    const send = service.send({ input: [{ type: 'text', text: 'show live text' }], clientMessageId: 'cm-live-text' });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'terminal gate');
    assert.equal(service.busy, true);
    assert.ok(markers.some(marker => String(marker).includes('first and second')));
    const emptyReasoning = () => markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length)))
      .filter(message => message.codexItemId === 'empty-reasoning');
    assert.equal(emptyReasoning().length, 1);
    assert.equal(emptyReasoning()[0].message.content[0].status, 'inProgress');
    const interaction = eventsOf(events, 'interactionRequested')[0];
    service.respondInteraction(interaction.payload.rpcId, { decision: 'accept' });
    await send;
    assert.ok(markers.some(marker => String(marker).includes('first and second; complete')));
    assert.equal(emptyReasoning().length, 2);
    assert.equal(emptyReasoning()[1].message.content[0].status, 'completed');
    assert.equal(emptyReasoning()[1].uuid, emptyReasoning()[0].uuid);
  } finally { await service.resetRuntime(); }
});

test('legacy itemType compaction and its deprecated completion share one boundary identity', async () => {
  const markers = [];
  const { service, events, getClient } = makeService({ scenario: 'reverse-approval',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) } });
  try {
    const send = service.send({ input: [{ type: 'text', text: 'legacy compact' }], clientMessageId: 'cm-legacy-compact' });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'terminal gate');
    getClient().emit('notification', { method: 'item/started', params: { threadId: service.rootThreadId,
      turnId: 'turn-test-0001', item: { id: 'legacy-compact', itemType: 'contextCompaction' } } });
    getClient().emit('notification', { method: 'thread/compacted', params: {
      threadId: service.rootThreadId, turnId: 'turn-test-0001' } });
    const boundaries = markers.filter(marker => String(marker).startsWith('[MESSAGE] '))
      .map(marker => JSON.parse(marker.slice('[MESSAGE] '.length))).filter(message => message.isCompactSummary);
    assert.equal(boundaries.length, 2);
    assert.equal(boundaries[0].uuid, boundaries[1].uuid);
    assert.equal(boundaries[1].summarizeMetadata.status, 'completed');
    const interaction = eventsOf(events, 'interactionRequested')[0];
    service.respondInteraction(interaction.payload.rpcId, { decision: 'accept' });
    await send;
  } finally { await service.resetRuntime(); }
});

test('send carries the frozen settings snapshot from enqueue time', async () => {
  const { service } = makeService({ scenario: 'early-notification' });
  try {
    await service.ensureRuntime();
    const frozen = { model: 'model-at-enqueue', effort: 'medium' };
    const op = service.enqueueOperation({
      kind: 'send', threadId: null, clientMessageId: 'cm-1', settings: frozen,
    });
    // Mutate desired afterwards; the frozen snapshot must not change.
    service.updateSettings({ model: 'model-changed-later' });
    assert.equal(op.frozenSettings.model, 'model-at-enqueue');
    await op.promise;
  } finally {
    await service.resetRuntime();
  }
});

// ---------------------------------------------------------------------------
// Child events do not fake parent identity (5.2 contract, verified early)
// ---------------------------------------------------------------------------

test('child thread events carry real identity without a parent operation', async () => {
  const { service, events } = makeService({ scenario: 'reverse-approval' });
  try {
    await service.ensureRuntime();
    const send = service.send({ input: [{ type: 'text', text: 'parent turn' }], clientMessageId: 'cm-1' });
    await waitFor(() => service.busy, 3000, 'parent turn active');

    // Simulate a child thread notification arriving on the same connection.
    service.client.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'th-test-child-9999',
        turn: { id: 'turn-child-1', status: 'completed', error: null },
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    const childTerminal = eventsOf(events, 'orphanTurnTerminal');
    assert.equal(childTerminal.length, 1, 'unknown child terminal surfaced as orphan, not parent done');
    assert.equal(childTerminal[0].threadId, 'th-test-child-9999');
    assert.equal(childTerminal[0].clientOperationId, null, 'no fabricated parent operation id');
    assert.equal(service.busy, true, 'parent FIFO untouched by the child terminal');

    // Reply to the parent approval through the typed pass-through.
    const interaction = eventsOf(events, 'interactionRequested')[0];
    assert.ok(interaction, 'approval surfaced as an interaction request');
    service.respondInteraction(interaction.payload.rpcId, { decision: 'accept' });
    const result = await send;
    assert.equal(result.outcome, 'completed');
  } finally {
    await service.resetRuntime();
  }
});

test('interaction ancestry verifies native ids and accepts a grandchild only through its actual root', async () => {
  for (const ancestry of ['valid', 'mismatched-id', 'cycle', 'foreign-root']) {
    const { service, getPeer, getClient, events } = makeService();
    try {
      await service.send({ input: [{ type: 'text', text: 'bind root' }] });
      const root = service.rootThreadId;
      const peer = getPeer();
      peer.scenario = { ...peer.scenario, async onThreadRead(params, ctx) {
        const parentThreadId = ancestry === 'cycle' ? params.threadId
          : ancestry === 'foreign-root' ? params.threadId === 'grandchild' ? 'other-root' : null
            : params.threadId === 'parent' ? root : 'parent';
        ctx.reply(ctx.currentId, { thread: { id: ancestry === 'mismatched-id' ? 'another-thread' : params.threadId,
          parentThreadId } });
      } };
      let answered = false;
      let reply;
      getClient().child.stdin.on('data', chunk => {
        for (const line of chunk.toString().trim().split('\n')) {
          const frame = JSON.parse(line);
          if (frame.id === 42 && (frame.result !== undefined || frame.error !== undefined)) reply = frame;
        }
      });
      const response = peer.waitServerResponse(42);
      response.then(() => { answered = true; });
      peer.serverRequest(42, 'item/tool/requestUserInput', { threadId: 'grandchild', turnId: 'child-turn',
        questions: [{ id: 'answer', question: 'Choose' }] });
      await waitFor(() => answered || eventsOf(events, 'interactionRequested').length > 0);
      if (ancestry !== 'valid') {
        assert.equal(eventsOf(events, 'interactionRequested').length, 0);
        assert.equal(service.snapshot().threads.find(thread => thread.threadId === 'grandchild').relationVerified, false);
        await response;
        assert.equal(reply?.error?.code, -32002);
      } else {
        const request = eventsOf(events, 'interactionRequested')[0];
        assert.equal(request?.rootThreadId, root);
        assert.equal(request?.threadId, 'grandchild');
        assert.equal(service.respondInteraction(42, { answers: {} }), true);
        await response;
        assert.equal(service.snapshot().threads.find(thread => thread.threadId === 'parent').relationVerified, true);
      }
    } finally { await service.resetRuntime(); }
  }
});

test('child interaction survives parent terminal and root release clears its pending lease', async () => {
  const { service, events } = makeService({ scenario: 'child-interaction' });
  try {
    const pending = service.send({
      input: [{ type: 'text', text: 'parent waits for child' }],
      clientMessageId: 'cm-child-interaction',
    });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'child interaction');
    const request = eventsOf(events, 'interactionRequested')[0];
    assert.equal(request.threadId, 'th-test-child-0002');
    assert.equal(request.rootThreadId, 'th-test-root-0001');
    assert.equal((await pending).outcome, 'completed', 'parent terminal does not wait for child UI');
    assert.equal(service.pendingInteractions.size, 1, 'child request remains actionable');

    await service.releaseThread('th-test-root-0001');
    assert.equal(service.pendingInteractions.size, 0, 'root release clears child interaction');
  } finally {
    await service.resetRuntime();
  }
});

test('native approval responses are validated before crossing the protocol boundary', async () => {
  const { service, events, getClient } = makeService({ scenario: 'reverse-approval' });
  try {
    const pending = service.send({
      input: [{ type: 'text', text: 'validate approval' }],
      clientMessageId: 'cm-validate',
    });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'approval request');
    const request = eventsOf(events, 'interactionRequested')[0];
    assert.equal(service.respondInteraction(request.payload.rpcId, { decision: 'grant-everything' }), false);
    assert.equal(getClient().serverRequests.has(request.payload.rpcId), true,
      'local validation must leave the native request available for one corrected answer');
    assert.equal(service.respondInteraction(request.payload.rpcId, { decision: 'accept' }), true);
    assert.equal(service.respondInteraction(request.payload.rpcId, { decision: 'accept' }), false);
    assert.equal((await pending).outcome, 'completed');
  } finally {
    await service.resetRuntime();
  }
});

test('MCP elicitation validates action/content and remains on the interaction bypass', async () => {
  const { service, events, getClient } = makeService({ scenario: 'mcp-elicitation' });
  try {
    const pending = service.send({
      input: [{ type: 'text', text: 'mcp form' }],
      clientMessageId: 'cm-mcp-form',
    });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'MCP elicitation');
    const request = eventsOf(events, 'interactionRequested')[0];
    assert.equal(service.respondInteraction(request.payload.rpcId, {
      action: 'decline',
      content: { value: 'must be rejected' },
    }), false);
    assert.equal(getClient().serverRequests.has(request.payload.rpcId), true,
      'a malformed local answer must not resolve the native elicitation');
    assert.equal(service.respondInteraction(request.payload.rpcId, {
      action: 'accept',
      content: { value: 'accepted' },
      _meta: { source: 'fixture' },
    }), true);
    assert.equal((await pending).outcome, 'completed');
  } finally {
    await service.resetRuntime();
  }
});

// ---------------------------------------------------------------------------
// 7.3 / 7.4 / 11.4 native item identity and read-only catalog/history
// ---------------------------------------------------------------------------

test('native plan deltas are replaced by the authoritative item and file changes retain paths', async () => {
  const markers = [];
  const { service, events } = makeService({
    scenario: 'native-items',
    serviceOpts: { emitMarker: (_operation, event) => markers.push(event) },
  });
  try {
    const result = await service.send({
      input: [{ type: 'text', text: 'show native items' }],
      clientMessageId: 'cm-native-items',
    });
    assert.equal(result.outcome, 'completed');
    const plans = eventsOf(events, 'planUpdated');
    assert.equal(plans.length, 2, 'delta and authoritative plan each update once');
    assert.equal(plans.at(-1).payload.item.text, 'authoritative plan');
    assert.equal(plans.at(-1).payload.authoritative, true);
    const fileEvent = eventsOf(events, 'fileChangeUpdated')[0];
    assert.equal(fileEvent.payload.item.changes['src/new.ts'].kind, 'add');
    assert.equal(fileEvent.payload.item.changes['src/old.ts'].newPath, 'src/renamed.ts');
    const fileMarker = markers.find((marker) => String(marker).includes('file_change'));
    assert.ok(fileMarker, 'fileChange emits a visible marker');
    assert.match(fileMarker, /src\/new\.ts/);
    const genericMarker = markers.find((marker) => String(marker).includes('webSearch'));
    assert.ok(genericMarker, 'generic visible items preserve their native type');
  } finally {
    await service.resetRuntime();
  }
});

test('file approval carries the same native item multi-file preview to the UI', async () => {
  const { service, events } = makeService({ scenario: 'file-approval-with-item' });
  try {
    const pending = service.send({
      input: [{ type: 'text', text: 'approve a patch' }],
      clientMessageId: 'cm-file-approval',
    });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'file approval');
    const request = eventsOf(events, 'interactionRequested')[0];
    assert.equal(request.payload.method, 'item/fileChange/requestApproval');
    assert.deepEqual(
      request.payload.params.proposedChanges.map((change) => ({ path: change.path, kind: change.kind })),
      [
        { path: 'src/added.ts', kind: 'add' },
        { path: 'src/removed.ts', kind: 'delete' },
        { path: 'src/changed.ts', kind: 'update' },
      ],
    );
    assert.equal(service.respondInteraction(request.payload.rpcId, { decision: 'decline' }), true);
    assert.equal((await pending).outcome, 'completed');
  } finally {
    await service.resetRuntime();
  }
});

test('missing file preview performs a bounded native read and remains deny-only', async () => {
  const { service, events, dispatchCounts } = makeService({ scenario: 'file-approval-missing-item' });
  try {
    const pending = service.send({
      input: [{ type: 'text', text: 'missing patch preview' }],
      clientMessageId: 'cm-file-missing',
    });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1, 3000, 'missing file preview');
    const request = eventsOf(events, 'interactionRequested')[0];
    assert.equal(dispatchCounts.get('thread/items/list'), 1, 'native item read attempted once');
    assert.equal(request.payload.params.proposedChanges, undefined);
    assert.equal(service.respondInteraction(request.payload.rpcId, { decision: 'decline' }), true);
    assert.equal((await pending).outcome, 'completed');
  } finally {
    await service.resetRuntime();
  }
});

test('a file approval resolved during preview hydration never reopens in the browser', async () => {
  const { service, getPeer, getClient, events } = makeService({ scenario: 'reverse-approval' });
  let finishPreview;
  try {
    const send = service.send({ input: [] });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1);
    const client = getClient();
    const request = client.request.bind(client);
    client.request = (method, params, options) => method === 'thread/items/list'
      ? new Promise((resolve) => { finishPreview = resolve; }) : request(method, params, options);
    getPeer().serverRequest('cancelled-preview', 'item/fileChange/requestApproval', {
      threadId: service.rootThreadId, turnId: 'turn-test-0001', itemId: 'missing-file',
    });
    await waitFor(() => finishPreview);
    getPeer().notify({ method: 'serverRequest/resolved', params: { requestId: 'cancelled-preview',
      threadId: service.rootThreadId, turnId: 'turn-test-0001' } });
    finishPreview({ data: [], nextCursor: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(eventsOf(events, 'interactionRequested').length, 1);
    assert.equal(service.pendingInteractions.has('cancelled-preview'), false);
    assert.equal(client.serverRequests.has('cancelled-preview'), false);
    service.respondInteraction(eventsOf(events, 'interactionRequested')[0].payload.rpcId, { decision: 'accept' });
    await send;
  } finally { finishPreview?.({ data: [], nextCursor: null }); await service.resetRuntime(); }
});

test('an interrupted turn closes unfinished tool cards and drops only its cached snapshots', async () => {
  const markers = [];
  const { service, events, getPeer } = makeService({ scenario: 'reverse-approval',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
  try {
    const send = service.send({ input: [] });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1);
    for (const [id, type] of [['running-cmd', 'commandExecution'], ['running-mcp', 'mcpToolCall'], ['running-edit', 'fileChange'],
      ['running-dynamic', 'dynamicToolCall'], ['running-spawn', 'collabAgentToolCall'], ['running-web', 'webSearch'],
      ['running-image', 'imageGeneration']]) {
      getPeer().notify({ method: 'item/started', params: { threadId: service.rootThreadId,
        turnId: 'turn-test-0001', item: { id, type, command: 'npm test', status: type === 'imageGeneration' ? 'in_progress' : 'inProgress', changes: [],
          tool: type === 'collabAgentToolCall' ? 'spawnAgent' : 'inspect', arguments: {}, receiverThreadIds: ['child-fixture'] } } });
    }
    getPeer().notify({ method: 'item/started', params: { threadId: 'child-fixture', turnId: 'child-turn',
      item: { id: 'child-running', type: 'fileChange', status: 'inProgress', changes: [] } } });
    getPeer().notify({ method: 'turn/completed', params: { threadId: service.rootThreadId,
      turn: { id: 'turn-test-0001', status: 'interrupted' } } });
    assert.equal((await send).outcome, 'interrupted');
    const messages = markers.filter((marker) => typeof marker === 'string' && marker.startsWith('[MESSAGE] '))
      .map((marker) => JSON.parse(marker.slice('[MESSAGE] '.length)));
    for (const id of ['running-cmd', 'running-mcp', 'running-dynamic', 'running-spawn', 'running-web', 'running-image']) {
      assert.ok(messages.some((message) => message.codexItemId === id), `${id} starts visibly`);
      const results = messages.filter((message) => message.codexItemId === `${id}:result`);
      assert.equal(results.length, 1);
      assert.equal(results[0].message.content[0].is_error, true);
    }
    assert.equal(messages.filter((message) => message.codexItemId === 'running-edit').at(-1).message.content[0].input.status, 'interrupted');
    assert.equal([...service.itemSnapshots.values()].some((item) => item.threadId === service.rootThreadId), false);
    assert.equal(service.itemSnapshots.get('child-fixture:child-running').status, 'inProgress');
  } finally { await service.resetRuntime(); }
});

test('read-only native catalog and history calls bypass the operation FIFO', async () => {
  const { service, dispatchCounts } = makeService({ scenario: 'native-read-only' });
  try {
    const threads = await service.readOnly('thread/list', { cwd: '/tmp/codex-peer' });
    const models = await service.readOnly('model/list', {});
    const skills = await service.readOnly('skills/list', { cwd: '/tmp/codex-peer' });
    const mcp = await service.readOnly('mcpServerStatus/list', { threadId: 'th-test-root-0001' });
    assert.equal(threads.data[0].id, 'th-test-root-0001');
    assert.equal(models.data[0].id, 'test-model');
    assert.equal(skills.data[0].skills[0].name, 'test-skill');
    assert.equal(mcp.data[0].runtimeStatus, 'connected');
    assert.equal(service.busy, false);
    assert.equal(dispatchCounts.get('thread/list'), 1);
    assert.equal(dispatchCounts.get('model/list'), 1);
    await assert.rejects(service.readOnly('turn/start', {}), /unsupported Codex read-only method/);
  } finally {
    await service.resetRuntime();
  }
});
test('approval reason survives a request before item start and the final snapshot', async () => {
  const markers = [];
  const { service, events } = makeService({ scenario: 'reverse-approval',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
  try {
    const send = service.send({ input: [{ type: 'text', text: 'reason fixture' }] });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1);
    const request = eventsOf(events, 'interactionRequested')[0];
    service.respondInteraction(request.payload.rpcId, { decision: 'accept' });
    await send;
    const commands = markers.filter((marker) => typeof marker === 'string' && marker.startsWith('[MESSAGE] '))
      .map((marker) => JSON.parse(marker.slice('[MESSAGE] '.length)))
      .filter((message) => message.message?.content?.[0]?.name === 'bash');
    assert.ok(commands.length > 0);
    assert.equal(commands.at(-1).message.content[0].input.approvalReason, 'fixture approval');
  } finally { await service.resetRuntime(); }
});

test('summary-less compaction remains visible and becomes failed when its turn fails', async () => {
  const markers = [];
  const { service, events, getClient } = makeService({ scenario: 'reverse-approval',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
  try {
    const send = service.send({ input: [{ type: 'text', text: 'compact fixture' }] });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1);
    getClient().emit('notification', { method: 'item/started', params: {
      threadId: service.rootThreadId, turnId: 'turn-test-0001', item: { id: 'cmp-empty', type: 'contextCompaction' } } });
    const boundary = markers.find((marker) => String(marker).includes('cmp-empty'));
    assert.match(boundary, /inProgress/);
    assert.equal(service.busy, true);
    getClient().emit('notification', { method: 'turn/completed', params: {
      threadId: service.rootThreadId, turn: { id: 'turn-test-0001', status: 'failed', error: { message: 'fixture failed' } } } });
    assert.equal((await send).outcome, 'failed');
    const final = markers.filter((marker) => String(marker).includes('cmp-empty')).at(-1);
    assert.match(final, /"status":"failed"/);
    assert.equal(JSON.parse(final.slice('[MESSAGE] '.length)).uuid, JSON.parse(boundary.slice('[MESSAGE] '.length)).uuid);
  } finally { await service.resetRuntime(); }
});
test('native error notices preserve their complete reason without ending or resending the turn', async () => {
  const { service, events, getPeer, dispatchCounts } = makeService({ scenario: 'reverse-approval' });
  let settled = false;
  try {
    const send = service.send({ input: [] }).then(result => { settled = true; return result; });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1);
    const message = 'Upstream retry reason: ' + 'a'.repeat(250) + ' complete suffix';
    for (const willRetry of [true, false]) {
      getPeer().notify({ method: 'error', params: { threadId: service.rootThreadId, turnId: 'turn-test-0001',
        error: { message }, willRetry } });
    }
    await waitFor(() => eventsOf(events, 'nativeWarning').length === 2);
    assert.deepEqual(eventsOf(events, 'nativeWarning').map(event => event.payload), [
      { message, willRetry: true }, { message, willRetry: false },
    ]);
    assert.equal(settled, false);
    assert.equal(dispatchCounts.get('turn/start'), 1);
    service.respondInteraction(eventsOf(events, 'interactionRequested')[0].payload.rpcId, { decision: 'accept' });
    assert.equal((await send).outcome, 'completed');
  } finally { await service.resetRuntime(); }
});

test('deprecated compact notification does not duplicate the current canonical boundary', async () => {
  const markers = [];
  const { service, events, getClient } = makeService({ scenario: 'reverse-approval',
    serviceOpts: { emitMarker: (_operation, marker) => markers.push(marker) } });
  try {
    const send = service.send({ input: [{ type: 'text', text: 'duplicate compact fixture' }] });
    await waitFor(() => eventsOf(events, 'interactionRequested').length === 1);
    getClient().emit('notification', { method: 'item/completed', params: {
      threadId: service.rootThreadId, turnId: 'turn-test-0001', item: { id: 'canonical', type: 'contextCompaction' } } });
    getClient().emit('notification', { method: 'thread/compacted', params: {
      threadId: service.rootThreadId, turnId: 'turn-test-0001', summary: 'compatibility summary' } });
    const boundaries = markers.filter((marker) => String(marker).includes('isCompactSummary'));
    assert.equal(boundaries.length, 1);
    assert.match(boundaries[0], /canonical/);
    const request = eventsOf(events, 'interactionRequested')[0];
    service.respondInteraction(request.payload.rpcId, { decision: 'accept' });
    await send;
  } finally { await service.resetRuntime(); }
});
