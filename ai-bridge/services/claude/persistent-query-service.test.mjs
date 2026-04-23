import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './persistent-query-service.js';

/**
 * Create a Promise that can be manually resolved.
 * @returns {{ promise: Promise, resolve: Function, reject: Function }}
 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createQueryFactory() {
  const runtimes = [];
  return {
    runtimes,
    queryFn({ prompt, options }) {
      const runtime = {
        prompt,
        options,
        closed: false,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        close() {
          this.closed = true;
        },
        async next() {
          return { done: true, value: undefined };
        }
      };
      runtimes.push(runtime);
      return runtime;
    }
  };
}

/**
 * Create a query factory that returns next() results in sequence.
 * @param {Array<(() => Promise<{done: boolean, value?: any}>) | {done: boolean, value?: any}>} steps
 */
function createSequencedQueryFactory(steps) {
  const runtimes = [];
  return {
    runtimes,
    queryFn({ prompt, options }) {
      let index = 0;
      const runtime = {
        prompt,
        options,
        closed: false,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        close() {
          this.closed = true;
        },
        async next() {
          const step = steps[index++];
          if (!step) {
            return { done: false, value: { type: 'result', is_error: false } };
          }
          return typeof step === 'function' ? await step() : step;
        }
      };
      runtimes.push(runtime);
      return runtime;
    }
  };
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

test('anonymous runtime is isolated by runtimeSessionEpoch', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const firstContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-1',
    cwd: process.cwd(),
    message: 'hello'
  }, false);

  const runtime1 = await __testing.acquireRuntime(firstContext);
  const runtime1Again = await __testing.acquireRuntime(firstContext);
  assert.equal(runtime1, runtime1Again);
  assert.equal(factory.runtimes.length, 1);

  const secondContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-2',
    cwd: process.cwd(),
    message: 'hello again'
  }, false);

  const runtime2 = await __testing.acquireRuntime(secondContext);
  assert.notEqual(runtime1, runtime2);
  assert.equal(factory.runtimes.length, 2);
});

test('same-tab new-session isolation matches fresh runtime isolation expectations', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const firstContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-a',
    cwd: process.cwd(),
    message: 'first turn'
  }, false);
  const runtimeA = await __testing.acquireRuntime(firstContext);

  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-a' });

  const secondContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-b',
    cwd: process.cwd(),
    message: 'new session turn'
  }, false);
  const runtimeB = await __testing.acquireRuntime(secondContext);

  assert.notEqual(runtimeA, runtimeB);
  assert.equal(factory.runtimes.length, 2);
  assert.equal(__testing.getSnapshot().anonymousRuntimeCount, 1);
});

test('resetRuntimePersistent disposes active turn runtime for interrupted old epoch before next first send', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const oldContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-old',
    cwd: process.cwd(),
    message: 'streaming turn'
  }, false);
  const oldRuntime = await __testing.acquireRuntime(oldContext);
  __testing.setActiveTurnRuntime(oldRuntime);

  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-old' });

  const nextContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-new',
    cwd: process.cwd(),
    message: 'first send after interrupt'
  }, false);
  const nextRuntime = await __testing.acquireRuntime(nextContext);

  assert.equal(oldRuntime.closed, true);
  assert.notEqual(oldRuntime, nextRuntime);
  assert.equal(__testing.getSnapshot().activeTurnEpoch, null);
});

test('restore-history continuation keeps runtime bound to restored session after reset of prior epoch', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const oldAnonymousContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-stale',
    cwd: process.cwd(),
    message: 'stale anonymous'
  }, false);
  await __testing.acquireRuntime(oldAnonymousContext);
  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-stale' });

  const restoredContext = await __testing.buildRequestContext({
    sessionId: 'hist-restore',
    runtimeSessionEpoch: 'epoch-restore',
    cwd: process.cwd(),
    message: 'restored continuation'
  }, false);
  const restoredRuntime = await __testing.acquireRuntime(restoredContext);
  const restoredRuntimeAgain = await __testing.acquireRuntime(restoredContext);

  assert.equal(restoredRuntime, restoredRuntimeAgain);
  assert.equal(__testing.getRuntimeForSession('hist-restore'), restoredRuntime);
});

test('active session runtime is not disposed by idle cleanup while a turn is executing', async () => {
  const nextDeferred = createDeferred();
  const enteredDeferred = createDeferred();
  const factory = createSequencedQueryFactory([
    async () => {
      enteredDeferred.resolve();
      return nextDeferred.promise;
    },
    { done: false, value: { type: 'result', is_error: false } }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-active',
    runtimeSessionEpoch: 'epoch-active',
    cwd: process.cwd(),
    message: 'long running turn'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (31 * 60 * 1000);

  const turnPromise = __testing.executeTurn(runtime, context);
  await enteredDeferred.promise;

  await __testing.cleanupSessionRuntimes();

  assert.equal(runtime.closed, false);
  assert.equal(__testing.getRuntimeForSession('session-active'), runtime);

  nextDeferred.resolve({ done: false, value: { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } });
  await turnPromise;
});

test('idle session runtime is still disposed by idle cleanup', async () => {
  const factory = createQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-idle',
    runtimeSessionEpoch: 'epoch-idle',
    cwd: process.cwd(),
    message: 'idle turn'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (31 * 60 * 1000);

  await __testing.cleanupSessionRuntimes();

  assert.equal(runtime.closed, true);
  assert.equal(__testing.getRuntimeForSession('session-idle'), null);
});

test('active anonymous runtime is not disposed by idle cleanup while a turn is executing', async () => {
  const nextDeferred = createDeferred();
  const enteredDeferred = createDeferred();
  const factory = createSequencedQueryFactory([
    async () => {
      enteredDeferred.resolve();
      return nextDeferred.promise;
    },
    { done: false, value: { type: 'result', is_error: false } }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-anon-active',
    cwd: process.cwd(),
    message: 'anonymous long running turn'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (11 * 60 * 1000);

  const turnPromise = __testing.executeTurn(runtime, context);
  await enteredDeferred.promise;

  await __testing.cleanupAnonymousRuntimes();

  assert.equal(runtime.closed, false);
  assert.equal(__testing.getSnapshot().anonymousRuntimeCount, 1);

  nextDeferred.resolve({ done: false, value: { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } });
  await turnPromise;
});

test('executeTurn refreshes lastUsedAt while processing query events', async () => {
  const factory = createSequencedQueryFactory([
    { done: false, value: { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } } },
    { done: false, value: { type: 'result', is_error: false } }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-refresh',
    runtimeSessionEpoch: 'epoch-refresh',
    cwd: process.cwd(),
    message: 'refresh lastUsedAt'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = 1;

  await __testing.executeTurn(runtime, context);

  assert.ok(runtime.lastUsedAt > 1);
});

test('drainPendingEvents consumes all buffered events before a timeout', async () => {
  const calls = [];
  const runtime = {
    closed: false,
    query: {
      async next() {
        calls.push(Date.now());
        if (calls.length <= 3) {
          return { done: false, value: { type: 'stream_event', event: { type: 'content_block_delta' } } };
        }
        // After draining 3 buffered events, simulate no more events by hanging.
        return new Promise(() => {});
      }
    }
  };

  const drained = await __testing.drainPendingEvents(runtime, 50);
  assert.equal(drained, 3);
  assert.ok(calls.length >= 4); // 3 drained + 1 hanging call that triggered the timeout
});

test('drainPendingEvents returns 0 for a closed runtime', async () => {
  const runtime = { closed: true, query: { async next() { throw new Error('must not be called'); } } };
  const drained = await __testing.drainPendingEvents(runtime, 50);
  assert.equal(drained, 0);
});

test('drainPendingEvents stops at done:true', async () => {
  let i = 0;
  const runtime = {
    closed: false,
    query: {
      async next() {
        i++;
        if (i === 1) return { done: false, value: { type: 'assistant' } };
        return { done: true, value: undefined };
      }
    }
  };
  const drained = await __testing.drainPendingEvents(runtime, 1000);
  assert.equal(drained, 1);
  assert.equal(i, 2);
});

test('executeTurn drains stale previous-turn events before processing new turn', async () => {
  // Scenario: previous turn left 2 straggling events in the iterator.
  // With hasCompletedTurn=true, these must be drained BEFORE the main loop
  // starts processing the new turn, so they don't pollute turnState.
  const staleAssistant1 = { type: 'assistant', message: { content: [{ type: 'text', text: 'STALE PREVIOUS ANSWER' }] } };
  const staleAssistant2 = { type: 'assistant', message: { content: [{ type: 'text', text: 'STALE PREVIOUS ANSWER continued' }] } };
  const newAssistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh reply' }] } };
  const resultMsg = { type: 'result', is_error: false };

  // Custom factory: first 2 calls return stale events immediately, call 3
  // hangs forever (simulating the SDK with no more buffered events — drain
  // times out here), then calls 4+ return new-turn events to the main loop.
  let callCount = 0;
  const queryFn = ({ prompt, options }) => {
    const q = {
      prompt,
      options,
      closed: false,
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      close() { this.closed = true; },
      async next() {
        callCount++;
        if (callCount === 1) return { done: false, value: staleAssistant1 };
        if (callCount === 2) return { done: false, value: staleAssistant2 };
        if (callCount === 3) return new Promise(() => {}); // hangs; drain times out
        if (callCount === 4) return { done: false, value: newAssistant };
        return { done: false, value: resultMsg };
      }
    };
    return q;
  };
  __testing.setQueryFn(queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-drain',
    runtimeSessionEpoch: 'epoch-drain',
    cwd: process.cwd(),
    message: 'new question',
    streaming: true
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  // Simulate that this runtime has already completed one turn.
  runtime.hasCompletedTurn = true;

  const turnMeta = { state: null };
  await __testing.executeTurn(runtime, context, turnMeta);

  // After drain, the main loop should have only seen newAssistant + result.
  // turnState.lastAssistantContent should contain only 'fresh reply',
  // never the stale previous-turn text.
  assert.equal(turnMeta.state.lastAssistantContent, 'fresh reply');
  assert.ok(!turnMeta.state.lastAssistantContent.includes('STALE'));
  // Drain took calls 1-3 (3rd hung until timeout), main loop took calls 4-5.
  assert.equal(callCount, 5);
});

test('executeTurn skips drain on a first-turn runtime (hasCompletedTurn=false)', async () => {
  // Scenario: a brand-new runtime has not completed any turn yet.
  // Drain must NOT run — there's nothing to drain, and calling next()
  // before enqueueing the user message would hang the iterator.
  const newAssistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'first reply' }] } };
  const resultMsg = { type: 'result', is_error: false };

  const factory = createSequencedQueryFactory([
    { done: false, value: newAssistant },
    { done: false, value: resultMsg }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-first',
    runtimeSessionEpoch: 'epoch-first',
    cwd: process.cwd(),
    message: 'first message',
    streaming: true
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  assert.equal(runtime.hasCompletedTurn, undefined, 'new runtime should not have hasCompletedTurn set');

  const turnMeta = { state: null };
  await __testing.executeTurn(runtime, context, turnMeta);

  assert.equal(turnMeta.state.lastAssistantContent, 'first reply');
  // After a successful turn, runtime should be flagged.
  assert.equal(runtime.hasCompletedTurn, true);
});

test('abortCurrentTurn still disposes an active runtime explicitly', async () => {
  const nextDeferred = createDeferred();
  const enteredDeferred = createDeferred();
  const factory = createSequencedQueryFactory([
    async () => {
      enteredDeferred.resolve();
      return nextDeferred.promise;
    }
  ]);
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'session-abort',
    runtimeSessionEpoch: 'epoch-abort',
    cwd: process.cwd(),
    message: 'abort me'
  }, false);
  const runtime = await __testing.acquireRuntime(context);
  const turnPromise = __testing.executeTurn(runtime, context);
  await enteredDeferred.promise;

  await __testing.abortCurrentTurn();
  nextDeferred.reject(new Error('runtime terminated'));

  await assert.rejects(turnPromise, /runtime terminated/);
  assert.equal(runtime.closed, true);
});
