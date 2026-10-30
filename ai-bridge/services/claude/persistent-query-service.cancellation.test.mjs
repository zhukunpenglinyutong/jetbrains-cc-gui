import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing, sendMessagePersistent, sendMessageWithAttachmentsPersistent } from './persistent-query-service.js';
import { createScriptedQuery, assistantText, RESULT_OK, settleReader } from './testing/scripted-query.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function startTurn(overrides = {}) {
  const created = deferred();
  let query;
  __testing.setQueryFn(args => {
    query = createScriptedQuery(args);
    Object.assign(query, { interrupt: async () => {}, ...overrides });
    created.resolve();
    return query;
  });
  const sending = sendMessagePersistent({
    sessionId: 'stop-session', runtimeSessionEpoch: 'stop-epoch', message: 'working', cwd: process.cwd(),
  });
  await created.promise;
  await query.waitForInput();
  return { sending, query, stop: () => __testing.abortTurnPersistent({ sessionId: 'stop-session', runtimeSessionEpoch: 'stop-epoch' }) };
}

test.afterEach(async () => __testing.resetState());

test('Stop during preparation prevents SDK input without cancelling a later send in the same epoch', async () => {
  const queries = [];
  __testing.setQueryFn(args => {
    const query = createScriptedQuery(args, [[RESULT_OK]]);
    queries.push(query);
    return query;
  });
  const params = { sessionId: 'preparing', runtimeSessionEpoch: 'epoch', message: 'cancel me', cwd: process.cwd() };
  const sending = sendMessagePersistent(params);
  assert.deepEqual(await __testing.abortTurnPersistent(params), { stopped: true });
  assert.deepEqual(await sending, { outcome: 'cancelled' });
  assert.equal(queries.length, 0);

  assert.deepEqual(await sendMessagePersistent({ ...params, message: 'later send' }), { outcome: 'completed' });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].inputs[0].message.content[0].text, 'later send');
});

test('acknowledged preparation cancellation wins over a later attachment preparation error', async () => {
  let launches = 0;
  __testing.setQueryFn(() => { launches++; throw new Error('must not launch'); });
  const params = { sessionId: 'preparation-error', runtimeSessionEpoch: 'epoch', message: 'cancel', attachments: [null] };
  const sending = sendMessageWithAttachmentsPersistent(params);
  assert.deepEqual(await __testing.abortTurnPersistent(params), { stopped: true });
  assert.deepEqual(await sending, { outcome: 'cancelled' });
  assert.equal(launches, 0);
});

test('preparation Stop matches the exact existing epoch and rejects ambiguous session-only targets', async () => {
  const first = { sessionId: 'shared-session', runtimeSessionEpoch: 'first', message: 'one' };
  const second = { ...first, runtimeSessionEpoch: 'second', message: 'two' };
  const sendingFirst = sendMessagePersistent(first);
  const sendingSecond = sendMessagePersistent(second);
  assert.deepEqual(await __testing.abortTurnPersistent({ ...first, runtimeSessionEpoch: 'stale' }), { stopped: false });
  await assert.rejects(__testing.abortTurnPersistent({ sessionId: first.sessionId }), /ambiguous/);
  assert.deepEqual(await __testing.abortTurnPersistent(first), { stopped: true });
  assert.deepEqual(await __testing.abortTurnPersistent(second), { stopped: true });
  assert.deepEqual(await sendingFirst, { outcome: 'cancelled' });
  assert.deepEqual(await sendingSecond, { outcome: 'cancelled' });
});

for (const rejected of [false, true]) {
  test(`Stop during SDK initialization preserves its ${rejected ? 'failed' : 'confirmed'} native outcome`, async () => {
    const entered = deferred();
    const initialization = deferred();
    let query;
    __testing.setQueryFn(args => {
      query = createScriptedQuery(args);
      Object.assign(query, {
        initializationResult: () => { entered.resolve(); return initialization.promise; },
        applyFlagSettings: async () => {},
        getSettings: async () => ({ applied: { ultracode: true } }),
        interrupt: async () => { if (rejected) throw new Error('native initialization stop rejected'); },
      });
      return query;
    });
    const params = { sessionId: 'initializing', runtimeSessionEpoch: 'epoch', message: 'cancel', ultracode: true };
    const sending = sendMessagePersistent(params);
    await entered.promise;
    const stopping = __testing.abortTurnPersistent(params);
    if (rejected) await assert.rejects(stopping, /native initialization stop rejected/);
    else assert.deepEqual(await stopping, { stopped: true });
    initialization.resolve({ claude_code_version: '2.1.296' });
    const result = await sending;
    assert.equal(result.outcome, rejected ? 'failed' : 'cancelled');
    if (rejected) assert.match(result.error, /native initialization stop rejected/);
    assert.equal(query.inputs.length, 0);
  });
}

test('Stop during initial quiescence cannot enqueue or reopen a sink while interrupt is pending', async () => {
  const interrupted = deferred();
  let query;
  __testing.setQueryFn(args => {
    query = createScriptedQuery(args);
    query.interrupt = () => interrupted.promise;
    return query;
  });
  const params = { sessionId: 'initial-quiescence', runtimeSessionEpoch: 'epoch', message: 'cancel' };
  const sending = sendMessagePersistent(params);
  for (let attempt = 0; !__testing.getActiveTurnRuntime() && attempt < 1000; attempt++) await Promise.resolve();
  const runtime = __testing.getActiveTurnRuntime();
  assert.ok(runtime);
  assert.equal(query.inputs.length, 0);
  const stopping = __testing.abortTurnPersistent(params);
  let sendSettled = false;
  sending.then(() => { sendSettled = true; });
  await settleReader();
  assert.equal(query.inputs.length, 0);
  assert.equal(runtime.turnSink, null);
  assert.equal(sendSettled, false);
  interrupted.resolve();
  assert.deepEqual(await stopping, { stopped: true });
  assert.deepEqual(await sending, { outcome: 'cancelled' });
});

test('repeated Stop during startup disposal shares native cleanup failure instead of replacing it with local success', async () => {
  const entered = deferred();
  const initialization = deferred();
  const closing = deferred();
  const enteredClose = deferred();
  let query;
  __testing.setQueryFn(args => {
    query = createScriptedQuery(args);
    const close = query.close;
    Object.assign(query, {
      initializationResult: () => { entered.resolve(); return initialization.promise; },
      applyFlagSettings: async () => {},
      getSettings: async () => ({ applied: { ultracode: true } }),
      interrupt: async () => {},
      close: async () => { enteredClose.resolve(); await closing.promise; close(); throw new Error('deferred cleanup failed'); },
    });
    return query;
  });
  const params = { sessionId: 'repeated-stop', runtimeSessionEpoch: 'epoch', message: 'cancel', ultracode: true };
  const sending = sendMessagePersistent(params);
  await entered.promise;
  const firstStop = __testing.abortTurnPersistent(params);
  const firstRejected = assert.rejects(firstStop, /deferred cleanup failed/);
  await enteredClose.promise;
  const secondStop = __testing.abortTurnPersistent(params);
  const secondRejected = assert.rejects(secondStop, /deferred cleanup failed/);
  initialization.resolve({ claude_code_version: '2.1.296' });
  let sendSettled = false;
  sending.then(() => { sendSettled = true; });
  await settleReader();
  assert.equal(sendSettled, false);
  closing.resolve();
  await Promise.all([firstRejected, secondRejected]);
  assert.deepEqual(await sending, { outcome: 'failed', error: 'deferred cleanup failed' });
  assert.equal(query.inputs.length, 0);
});

test('the original send acknowledges cancellation only after native interrupt and cleanup', async () => {
  const interrupted = deferred();
  const closing = deferred();
  const { sending, query, stop } = await startTurn({ interrupt: () => interrupted.promise });
  const close = query.close;
  query.close = async () => { await closing.promise; close(); };
  let sendSettled = false;
  sending.then(() => { sendSettled = true; });
  const stopping = stop();
  await Promise.resolve();
  assert.equal(sendSettled, false);
  interrupted.resolve();
  await Promise.resolve();
  assert.equal(sendSettled, false);
  closing.resolve();
  assert.deepEqual(await stopping, { stopped: true });
  assert.deepEqual(await sending, { outcome: 'cancelled' });
});

test('cancelling a send waiting for prior CLI output acknowledges native cancellation without enqueuing it', async () => {
  let query;
  __testing.setQueryFn(args => {
    query = createScriptedQuery(args, [[RESULT_OK, assistantText('prior CLI run still finishing')]]);
    query.interrupt = async () => {};
    return query;
  });
  const params = { sessionId: 'waiting-session', runtimeSessionEpoch: 'waiting-epoch', message: 'first', cwd: process.cwd() };
  assert.deepEqual(await sendMessagePersistent(params), { outcome: 'completed' });
  await settleReader();
  const runtime = __testing.getRuntimeForSession(params.sessionId);
  assert.equal(runtime.cliTurnInFlight, true);
  const sending = sendMessagePersistent({ ...params, message: 'next' });
  // executeTurn owns the send while waiting for prior output, before it can
  // enqueue the new user message or create a turn sink.
  for (let attempt = 0; __testing.getActiveTurnRuntime() !== runtime && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(__testing.getActiveTurnRuntime(), runtime);
  await __testing.abortTurnPersistent(params);
  const result = await sending;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(query.inputs.length, 1);
});

test('native interrupt rejection cannot become a confirmed cancelled send', async () => {
  const { sending, stop } = await startTurn({ interrupt: async () => { throw new Error('native rejected interrupt'); } });
  await assert.rejects(stop(), /native rejected interrupt/);
  assert.deepEqual(await sending, { outcome: 'failed', error: 'native rejected interrupt' });
});

test('an SDK without interrupt acknowledgment is cleaned up without confirming cancellation', async () => {
  const { sending, stop } = await startTurn({ interrupt: undefined });
  await assert.rejects(stop(), /cannot acknowledge native cancellation/);
  assert.equal((await sending).outcome, 'failed');
  assert.equal(__testing.getRuntimeForSession('stop-session'), null);
});

test('cleanup failure cannot become a confirmed cancelled send', async () => {
  const { sending, query, stop } = await startTurn();
  const close = query.close;
  query.close = () => { close(); throw new Error('native cleanup failed'); };
  await assert.rejects(stop(), /native cleanup failed/);
  assert.deepEqual(await sending, { outcome: 'failed', error: 'native cleanup failed' });
});

test('native interrupt timeout reports failure while still closing the runtime', async t => {
  const { sending, query, stop } = await startTurn({ interrupt: () => new Promise(() => {}) });
  const close = query.close;
  let closed = false;
  query.close = () => { closed = true; close(); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = stop();
  const rejection = assert.rejects(stopping, /did not acknowledge native cancellation/);
  t.mock.timers.tick(5000);
  await rejection;
  assert.equal(closed, true);
  assert.equal((await sending).outcome, 'failed');
});

test('cleanup timeout does not hold either Stop or the original send indefinitely', async t => {
  const { sending, query, stop } = await startTurn();
  const close = query.close;
  const enteredClose = deferred();
  const closing = deferred();
  query.close = async () => { enteredClose.resolve(); await closing.promise; close(); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = stop();
  const rejection = assert.rejects(stopping, /cleanup did not finish/);
  await enteredClose.promise;
  t.mock.timers.tick(3000);
  await rejection;
  assert.equal((await sending).outcome, 'failed');
  closing.resolve();
});
