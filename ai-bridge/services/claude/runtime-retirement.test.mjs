import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing, sendMessagePersistent } from './persistent-query-service.js';
import { disposeRuntime } from './runtime-lifecycle.js';
import { cleanupStaleSessionRuntimes, getAllRuntimes } from './runtime-registry.js';
import { createScriptedQuery, RESULT_OK } from './testing/scripted-query.js';

const params = { sessionId: 'retiring', runtimeSessionEpoch: 'epoch', message: 'first', cwd: process.cwd() };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
test.afterEach(async () => __testing.resetState());

test('Stop after idle cleanup is an idempotent no-op and a later send starts normally', async () => {
  const queries = [];
  __testing.setQueryFn(args => {
    const query = createScriptedQuery(args, [[RESULT_OK]]);
    queries.push(query);
    return query;
  });
  assert.deepEqual(await sendMessagePersistent(params), { outcome: 'completed' });
  const runtime = __testing.getRuntimeForSession(params.sessionId);
  runtime.lastUsedAt = Date.now() - 61_000;
  await cleanupStaleSessionRuntimes(item => disposeRuntime(item, {}));
  assert.equal(getAllRuntimes().has(runtime), false);
  assert.deepEqual(await __testing.abortTurnPersistent(params), { stopped: false });
  assert.deepEqual(await sendMessagePersistent({ ...params, message: 'new send' }), { outcome: 'completed' });
  assert.equal(queries.length, 2);
});

test('pending idle disposal is still an owner for Stop and ambiguous-target checks', async t => {
  const close = deferred();
  __testing.setQueryFn(args => {
    const query = createScriptedQuery(args, [[RESULT_OK]]);
    const originalClose = query.close;
    query.close = async () => { await close.promise; originalClose(); };
    query.interrupt = async () => {};
    return query;
  });
  assert.deepEqual(await sendMessagePersistent(params), { outcome: 'completed' });
  const runtime = __testing.getRuntimeForSession(params.sessionId);
  const disposing = disposeRuntime(runtime, {});
  const nextEpoch = { ...params, runtimeSessionEpoch: 'next-epoch' };
  const nextSend = sendMessagePersistent(nextEpoch);
  await assert.rejects(__testing.abortTurnPersistent({ sessionId: params.sessionId }), /ambiguous/);
  await __testing.abortTurnPersistent(nextEpoch);
  assert.deepEqual(await nextSend, { outcome: 'cancelled' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const stopping = __testing.abortTurnPersistent(params);
    const rejected = assert.rejects(stopping, /cleanup did not finish/);
    await tick();
    t.mock.timers.tick(3000);
    await rejected;
    assert.equal(getAllRuntimes().has(runtime), true);
  } finally {
    close.resolve();
    await disposing;
    t.mock.timers.reset();
  }
  assert.deepEqual(await __testing.abortTurnPersistent(params), { stopped: false });
});

test('an aged runtime cannot make the next send outlive Stop\'s bounded cleanup failure', async t => {
  const close = deferred();
  const queries = [];
  __testing.setQueryFn(args => {
    const query = createScriptedQuery(args, [[RESULT_OK]]);
    if (!queries.length) {
      query.interrupt = () => new Promise(() => {});
      const originalClose = query.close;
      query.close = async () => { await close.promise; originalClose(); };
    }
    queries.push(query);
    return query;
  });
  await sendMessagePersistent(params);
  const old = __testing.getRuntimeForSession(params.sessionId);
  old.lastUsedAt = Date.now() - 61_000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sending;
  try {
    const stopping = __testing.abortTurnPersistent(params);
    const stopFailure = assert.rejects(stopping, /did not acknowledge/);
    let nextResult;
    sending = sendMessagePersistent({ ...params, message: 'next' }).then(result => { nextResult = result; return result; });
    await tick();
    assert.equal(old.closed, false, 'idle cleanup must not race the pending interrupt');
    t.mock.timers.tick(5000);
    await tick();
    t.mock.timers.tick(3000);
    await stopFailure;
    await tick();
    assert.equal(nextResult?.outcome, 'failed', 'the next send must settle without waiting forever on close');
    assert.match(nextResult.error, /still closing the previous runtime/);
    assert.equal(queries.length, 1);
  } finally {
    close.resolve();
    await old.disposePromise;
    t.mock.timers.reset();
    await sending;
  }
});

test('an unrelated idle runtime with hung cleanup does not block another session or later cleanup sweeps', async () => {
  const close = deferred();
  const queries = [];
  __testing.setQueryFn(args => {
    const query = createScriptedQuery(args, [[RESULT_OK]]);
    if (!queries.length) {
      const originalClose = query.close;
      query.close = async () => { await close.promise; originalClose(); };
    }
    queries.push(query);
    return query;
  });
  await sendMessagePersistent(params);
  const old = __testing.getRuntimeForSession(params.sessionId);
  old.lastUsedAt = Date.now() - 61_000;
  let timeout;
  try {
    const result = await Promise.race([
      sendMessagePersistent({ ...params, sessionId: 'unrelated', runtimeSessionEpoch: 'other', message: 'independent work' }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('unrelated send blocked on hung idle cleanup')), 2000); }),
    ]);
    assert.deepEqual(result, { outcome: 'completed' });
    assert.equal(queries.length, 2);
    assert.equal(getAllRuntimes().has(old), true);
    await __testing.cleanupSessionRuntimes();
    const retry = await sendMessagePersistent({ ...params, message: 'own retry during cleanup' });
    assert.equal(retry.outcome, 'failed');
    assert.match(retry.error, /still closing the previous runtime/);
    assert.equal(queries.length, 2);
  } finally {
    clearTimeout(timeout);
    close.resolve();
    await old.disposePromise;
  }
});

for (const failure of ['interrupt rejection', 'interrupt timeout', 'cleanup rejection']) {
  test(`a send waiting for ${failure} belongs to a fresh runtime after retirement`, async t => {
    const interrupt = deferred();
    const queries = [];
    __testing.setQueryFn(args => {
      const query = createScriptedQuery(args, [[RESULT_OK]]);
      if (!queries.length) {
        query.interrupt = async () => {
          await interrupt.promise;
          if (failure === 'interrupt rejection') throw new Error('old interrupt rejected');
        };
        if (failure === 'cleanup rejection') {
          const close = query.close;
          query.close = () => { close(); throw new Error('old cleanup rejected'); };
        }
      }
      queries.push(query);
      return query;
    });
    assert.deepEqual(await sendMessagePersistent(params), { outcome: 'completed' });
    const old = __testing.getRuntimeForSession(params.sessionId);
    if (failure === 'interrupt timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const stopping = __testing.abortTurnPersistent(params);
    const stopFailure = assert.rejects(stopping, /old .* rejected|did not acknowledge/);
    const sending = sendMessagePersistent({ ...params, message: 'next' });
    await tick();
    assert.equal(queries.length, 1, 'new runtime must wait for old retirement');
    if (failure === 'interrupt timeout') t.mock.timers.tick(5000);
    else interrupt.resolve();
    await stopFailure;
    if (failure === 'interrupt timeout') t.mock.timers.reset();
    assert.deepEqual(await sending, { outcome: 'completed' });
    assert.equal(queries.length, 2);
    assert.equal(queries[0].inputs.length, 1);
    assert.equal(queries[1].inputs[0].message.content[0].text, 'next');
    assert.equal(old.disposeSettled, true);
    assert.equal(getAllRuntimes().has(old), false);
  });
}

for (const anonymous of [false, true]) {
  test(`hung cleanup fences ${anonymous ? 'anonymous changed-signature' : 'resumed'} sends until disposal really settles`, async t => {
    const close = deferred();
    const enteredClose = deferred();
    const queries = [];
    const owner = { ...params, ...(anonymous ? { sessionId: undefined } : {}) };
    __testing.setQueryFn(args => {
      const query = createScriptedQuery(args, [[RESULT_OK]]);
      if (!queries.length) {
        query.interrupt = async () => {};
        const originalClose = query.close;
        query.close = async () => { enteredClose.resolve(); await close.promise; originalClose(); };
      }
      queries.push(query);
      return query;
    });
    assert.deepEqual(await sendMessagePersistent(owner), { outcome: 'completed' });
    const old = [...getAllRuntimes()][0];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const stopping = __testing.abortTurnPersistent(owner);
      const stopFailure = assert.rejects(stopping, /cleanup did not finish/);
      await enteredClose.promise;
      const changed = { ...owner, reasoningEffort: 'max', message: 'blocked while closing' };
      const sending = sendMessagePersistent(changed);
      await tick();
      assert.equal(queries.length, 1);
      assert.equal(getAllRuntimes().has(old), true, 'cleanup sweep must not forget a still-closing owner');
      t.mock.timers.tick(3000);
      await stopFailure;
      const result = await sending;
      assert.equal(result.outcome, 'failed');
      assert.match(result.error, /still closing the previous runtime/);
      assert.equal(queries.length, 1);
      assert.equal(getAllRuntimes().has(old), true);
      const again = await sendMessagePersistent(changed);
      assert.equal(again.outcome, 'failed');
      assert.equal(queries.length, 1, 'a later attempt must not bypass the retirement fence');
    } finally {
      close.resolve();
      await old.disposePromise;
      t.mock.timers.reset();
    }
    assert.equal(getAllRuntimes().has(old), false);
    assert.deepEqual(await sendMessagePersistent({ ...owner, message: 'after cleanup' }), { outcome: 'completed' });
    assert.equal(queries.length, 2);
  });
}
