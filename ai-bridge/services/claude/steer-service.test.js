import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';
import { createTurnSink, registerRuntimeSession } from './runtime-lifecycle.js';
import {
  STEER_MIN_CLI_VERSION,
  STEER_REJECT,
  isClaudeCodeVersionAtLeast,
  isSteerCapable,
  steerMessagePersistent,
  tryEmitSteerFolded,
  handleSteerResultAndMaybeContinue,
  dumpPendingSteersAsUndelivered,
  recordClaudeCodeVersionFromInit,
  ensureSteerMaps,
  resetFoldedSteers,
  MAX_FOLDED_STEERS,
} from './steer-service.js';

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8'));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stdout.write = original;
    })
    .then((result) => ({ result, text: chunks.join('') }));
}

function parseTags(text, tag) {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${tag} `))
    .map((line) => JSON.parse(line.slice(tag.length).trim()));
}

async function buildUserMessage(params) {
  return {
    type: 'user',
    session_id: params.sessionId || '',
    message: { role: 'user', content: [{ type: 'text', text: params.message || '' }] },
  };
}

function capableRuntime(overrides = {}) {
  const pendingSteers = new Map();
  const foldedSteers = new Map();
  const enqueued = [];
  return {
    closed: false,
    sessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    claudeCodeVersion: '2.1.220',
    turnSink: createTurnSink(),
    pendingSteers,
    foldedSteers,
    inputStream: {
      enqueue(msg) { enqueued.push(msg); },
    },
    query: {
      cancelAsyncMessage: async () => ({ cancelled: true }),
    },
    __enqueued: enqueued,
    ...overrides,
  };
}

test('isClaudeCodeVersionAtLeast gates 2.1.220', () => {
  assert.equal(isClaudeCodeVersionAtLeast('2.1.182', STEER_MIN_CLI_VERSION), false);
  assert.equal(isClaudeCodeVersionAtLeast('2.1.220', STEER_MIN_CLI_VERSION), true);
  assert.equal(isClaudeCodeVersionAtLeast('2.2.0', STEER_MIN_CLI_VERSION), true);
  assert.equal(isClaudeCodeVersionAtLeast('', STEER_MIN_CLI_VERSION), false);
});

test('capability is false on CLI 2.1.182 even when cancelAsyncMessage exists', () => {
  const runtime = capableRuntime({ claudeCodeVersion: '2.1.182' });
  assert.equal(isSteerCapable(runtime), false);
});

test('capability requires cancelAsyncMessage', () => {
  const runtime = capableRuntime({ query: {} });
  assert.equal(isSteerCapable(runtime), false);
  assert.equal(isSteerCapable(capableRuntime()), true);
});

test('steerMessagePersistent rejects when there is no active turn', async () => {
  await __testing.resetState();
  const result = await steerMessagePersistent(
    { steerId: 's1', message: 'hi', sessionId: 'sess-1' },
    { buildUserMessage },
  );
  assert.deepEqual(result, { delivered: false, reason: STEER_REJECT.NO_ACTIVE_TURN });
});

test('steerMessagePersistent rejects session mismatch', async () => {
  await __testing.resetState();
  const runtime = capableRuntime();
  __testing.setActiveTurnRuntime(runtime);
  const result = await steerMessagePersistent(
    {
      steerId: 's1',
      message: 'hi',
      sessionId: 'other-session',
      runtimeSessionEpoch: 'epoch-1',
    },
    { buildUserMessage },
  );
  assert.deepEqual(result, { delivered: false, reason: STEER_REJECT.SESSION_MISMATCH });
});

test('steerMessagePersistent rejects unsupported CLI version', async () => {
  await __testing.resetState();
  const runtime = capableRuntime({ claudeCodeVersion: '2.1.182' });
  __testing.setActiveTurnRuntime(runtime);
  const result = await steerMessagePersistent(
    { steerId: 's1', message: 'hi', sessionId: 'sess-1', runtimeSessionEpoch: 'epoch-1' },
    { buildUserMessage },
  );
  assert.deepEqual(result, { delivered: false, reason: STEER_REJECT.UNSUPPORTED_CLI_VERSION });
});

test('steerMessagePersistent enqueues priority next and tracks pending', async () => {
  await __testing.resetState();
  const runtime = capableRuntime();
  __testing.setActiveTurnRuntime(runtime);
  const result = await steerMessagePersistent(
    { steerId: 'steer-1', message: 'do not touch B', sessionId: 'sess-1', runtimeSessionEpoch: 'epoch-1' },
    { buildUserMessage },
  );
  assert.deepEqual(result, { delivered: true });
  assert.equal(runtime.__enqueued.length, 1);
  assert.equal(runtime.__enqueued[0].priority, 'next');
  assert.equal(typeof runtime.__enqueued[0].uuid, 'string');
  assert.equal(runtime.pendingSteers.size, 1);
  const pending = runtime.pendingSteers.get(runtime.__enqueued[0].uuid);
  assert.equal(pending.steerId, 'steer-1');
});

test('fold at tool boundary emits STEER_FOLDED for the oldest pending steer', async () => {
  const runtime = capableRuntime();
  runtime.pendingSteers.set('uuid-old', { steerId: 'steer-old', prompt: 'first' });
  runtime.pendingSteers.set('uuid-new', { steerId: 'steer-new', prompt: 'second' });
  const { text } = await captureStdout(() => {
    const consumed = tryEmitSteerFolded(runtime, {
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'user-prompt', prompt: 'do not touch B' },
    });
    assert.equal(consumed, true);
  });
  assert.deepEqual(parseTags(text, '[STEER_FOLDED]'), [{
    steerId: 'steer-old',
    uuid: 'uuid-old',
    prompt: 'do not touch B',
  }]);
  assert.equal(runtime.pendingSteers.has('uuid-old'), false);
  assert.equal(runtime.foldedSteers.has('uuid-old'), true);
  assert.equal(runtime.pendingSteers.has('uuid-new'), true);
});

test('live SDK user message with pending uuid emits STEER_FOLDED', async () => {
  const runtime = capableRuntime();
  runtime.pendingSteers.set('uuid-live', { steerId: 'steer-live', prompt: '你好' });
  const { text } = await captureStdout(() => {
    const consumed = tryEmitSteerFolded(runtime, {
      type: 'user',
      uuid: 'uuid-live',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
    });
    assert.equal(consumed, true);
  });
  assert.deepEqual(parseTags(text, '[STEER_FOLDED]'), [{
    steerId: 'steer-live',
    uuid: 'uuid-live',
    prompt: '你好',
  }]);
  assert.equal(runtime.pendingSteers.size, 0);
});

test('live SDK user message matching pending prompt emits STEER_FOLDED', async () => {
  const runtime = capableRuntime();
  runtime.pendingSteers.set('uuid-assigned', { steerId: 'steer-prompt', prompt: '你好' });
  const { text } = await captureStdout(() => {
    const consumed = tryEmitSteerFolded(runtime, {
      type: 'user',
      uuid: 'cli-rewrote-uuid',
      isReplay: true,
      parent_tool_use_id: null,
      message: { role: 'user', content: '你好' },
    });
    assert.equal(consumed, true);
  });
  assert.equal(parseTags(text, '[STEER_FOLDED]')[0].steerId, 'steer-prompt');
  assert.equal(parseTags(text, '[STEER_FOLDED]')[0].uuid, 'uuid-assigned');
});

test('already-folded steer replays are consumed without a second STEER_FOLDED', async () => {
  const runtime = capableRuntime();
  runtime.foldedSteers.set('uuid-live', { steerId: 'steer-live', prompt: '你好' });
  const { text } = await captureStdout(() => {
    const consumed = tryEmitSteerFolded(runtime, {
      type: 'user',
      uuid: 'uuid-live',
      isReplay: true,
      message: { role: 'user', content: '你好' },
    });
    assert.equal(consumed, true);
    // A different uuid carrying the same text is NOT a replay of this fold:
    // it flows on to [MESSAGE], because matching it by text would also drop a
    // genuine user message that happens to repeat a steered sentence.
    const otherUuid = tryEmitSteerFolded(runtime, {
      type: 'user',
      uuid: 'cli-rewrote',
      isReplay: true,
      message: { role: 'user', content: '你好' },
    });
    assert.equal(otherUuid, false);
  });
  assert.equal(parseTags(text, '[STEER_FOLDED]').length, 0);
});

test('a replayed queued_command carrier is consumed by uuid, not by text', async () => {
  const runtime = capableRuntime();
  runtime.foldedSteers.set('uuid-1', { steerId: 'steer-1', prompt: '你好' });
  const { text } = await captureStdout(() => {
    const replay = tryEmitSteerFolded(runtime, {
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'prompt', uuid: 'uuid-1', prompt: '你好' },
    });
    assert.equal(replay, true);

    // The CLI's own queue uses the same commandMode, so an unknown uuid has to
    // reach [MESSAGE] rather than being mistaken for a steer replay.
    const foreign = tryEmitSteerFolded(runtime, {
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'prompt', uuid: 'uuid-other', prompt: '你好' },
    });
    assert.equal(foreign, false);
  });
  assert.equal(parseTags(text, '[STEER_FOLDED]').length, 0);
});

test('tool_result user messages are not treated as a steer fold', () => {
  const runtime = capableRuntime();
  runtime.pendingSteers.set('uuid-1', { steerId: 'steer-1', prompt: '你好' });
  const consumed = tryEmitSteerFolded(runtime, {
    type: 'user',
    uuid: 'tool-result-uuid',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    },
  });
  assert.equal(consumed, false);
  assert.equal(runtime.pendingSteers.has('uuid-1'), true);
});

test('turn ends before fold cancels pending and emits STEER_UNDELIVERED', async () => {
  const cancelled = [];
  const runtime = capableRuntime({
    query: {
      cancelAsyncMessage: async (uuid) => {
        cancelled.push(uuid);
        return { cancelled: true };
      },
    },
  });
  runtime.pendingSteers.set('uuid-1', { steerId: 'steer-1', prompt: 'later' });
  const { text, result } = await captureStdout(() => handleSteerResultAndMaybeContinue(runtime, {
    type: 'result',
    is_error: false,
    user_message_uuids: [],
  }));
  assert.equal(result, true);
  assert.deepEqual(cancelled, ['uuid-1']);
  assert.deepEqual(parseTags(text, '[STEER_UNDELIVERED]'), [{ steerId: 'steer-1' }]);
  assert.equal(runtime.pendingSteers.size, 0);
});

test('cancelAsyncMessage false with no extra queued turn folds leftover pending', async () => {
  const runtime = capableRuntime({
    query: {
      cancelAsyncMessage: async () => ({ cancelled: false }),
    },
  });
  runtime.pendingSteers.set('uuid-1', { steerId: 'steer-1', prompt: '你好' });
  const { text, result } = await captureStdout(() => handleSteerResultAndMaybeContinue(runtime, {
    type: 'result',
    is_error: false,
    user_message_uuids: [],
    queued_turn_count: 0,
  }));
  assert.equal(result, true);
  assert.deepEqual(parseTags(text, '[STEER_FOLDED]'), [{
    steerId: 'steer-1',
    uuid: 'uuid-1',
    prompt: '你好',
  }]);
  assert.equal(parseTags(text, '[STEER_UNDELIVERED]').length, 0);
  assert.equal(runtime.pendingSteers.size, 0);
});

test('cancelAsyncMessage false keeps reading until a later result covers the uuid', async () => {
  let calls = 0;
  const runtime = capableRuntime({
    query: {
      cancelAsyncMessage: async () => {
        calls += 1;
        return { cancelled: false };
      },
    },
  });
  runtime.pendingSteers.set('uuid-1', { steerId: 'steer-1', prompt: 'later' });

  const first = await captureStdout(() => handleSteerResultAndMaybeContinue(runtime, {
    type: 'result',
    is_error: false,
    user_message_uuids: [],
    queued_turn_count: 1,
  }));
  assert.equal(first.result, false);
  assert.equal(parseTags(first.text, '[STEER_UNDELIVERED]').length, 0);
  assert.equal(runtime.pendingSteers.has('uuid-1'), true);
  assert.equal(calls, 1);

  const second = await captureStdout(() => handleSteerResultAndMaybeContinue(runtime, {
    type: 'result',
    is_error: false,
    user_message_uuids: ['uuid-1'],
    queued_turn_count: 0,
  }));
  assert.equal(second.result, true);
  assert.deepEqual(parseTags(second.text, '[STEER_FOLDED]'), [{
    steerId: 'steer-1',
    uuid: 'uuid-1',
    prompt: 'later',
  }]);
});

test('abort dumps pending-not-folded steers as STEER_UNDELIVERED', async () => {
  const runtime = capableRuntime();
  runtime.pendingSteers.set('uuid-1', { steerId: 'steer-1', prompt: 'x' });
  runtime.foldedSteers.set('uuid-folded', { steerId: 'steer-folded', prompt: 'y' });
  const { text } = await captureStdout(() => dumpPendingSteersAsUndelivered(runtime));
  assert.deepEqual(parseTags(text, '[STEER_UNDELIVERED]'), [{ steerId: 'steer-1' }]);
  assert.equal(runtime.pendingSteers.size, 0);
});

test('abortCurrentTurn emits undelivered before disposing the runtime', async () => {
  await __testing.resetState();
  const runtime = capableRuntime();
  ensureSteerMaps(runtime);
  runtime.pendingSteers.set('uuid-abort', { steerId: 'steer-abort', prompt: 'z' });
  runtime.query = { close() {} };
  runtime.inputStream = { done() {} };
  __testing.setActiveTurnRuntime(runtime);
  const { text } = await captureStdout(() => __testing.abortCurrentTurn());
  assert.deepEqual(parseTags(text, '[STEER_UNDELIVERED]'), [{ steerId: 'steer-abort' }]);
  assert.equal(runtime.closed, true);
});

test('executeTurn folds a queued_command on the current request stream', async () => {
  await __testing.resetState();
  const runtime = capableRuntime({ turnSink: null });
  runtime.activeTurnCount = 0;
  runtime.cliTurnInFlight = false;
  runtime.readerProgress = 0;
  __testing.setActiveTurnRuntime(runtime);

  const turnPromise = __testing.executeTurn(runtime, {
    requestedSessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    options: { cwd: '/tmp' },
    permissionMode: 'default',
    streamingEnabled: false,
    userMessage: { type: 'user', message: { role: 'user', content: 'hi' } },
  });

  while (!runtime.turnSink) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const steer = await steerMessagePersistent(
    { steerId: 'steer-live', message: 'inject', sessionId: 'sess-1', runtimeSessionEpoch: 'epoch-1' },
    { buildUserMessage },
  );
  assert.equal(steer.delivered, true);
  const uuid = runtime.__enqueued[0].uuid;

  const { text } = await captureStdout(async () => {
    runtime.turnSink.push({
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'inject' },
    });
    runtime.turnSink.push({ type: 'result', is_error: false, user_message_uuids: [uuid] });
    await turnPromise;
  });

  const folded = parseTags(text, '[STEER_FOLDED]');
  assert.equal(folded.length, 1);
  assert.equal(folded[0].steerId, 'steer-live');
  assert.equal(folded[0].prompt, 'inject');
});

test('executeTurn folds a live user message on the current request stream', async () => {
  await __testing.resetState();
  const runtime = capableRuntime({ turnSink: null });
  runtime.activeTurnCount = 0;
  runtime.cliTurnInFlight = false;
  runtime.readerProgress = 0;
  __testing.setActiveTurnRuntime(runtime);

  const turnPromise = __testing.executeTurn(runtime, {
    requestedSessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    options: { cwd: '/tmp' },
    permissionMode: 'default',
    streamingEnabled: false,
    userMessage: { type: 'user', message: { role: 'user', content: 'hi' } },
  });

  while (!runtime.turnSink) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const steer = await steerMessagePersistent(
    { steerId: 'steer-user', message: '你好', sessionId: 'sess-1', runtimeSessionEpoch: 'epoch-1' },
    { buildUserMessage },
  );
  assert.equal(steer.delivered, true);
  const uuid = runtime.__enqueued[0].uuid;

  const { text } = await captureStdout(async () => {
    runtime.turnSink.push({
      type: 'user',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
    });
    runtime.turnSink.push({ type: 'result', is_error: false, user_message_uuids: [uuid] });
    await turnPromise;
  });

  const folded = parseTags(text, '[STEER_FOLDED]');
  assert.equal(folded.length, 1);
  assert.equal(folded[0].steerId, 'steer-user');
  assert.equal(folded[0].prompt, '你好');
});

test('recordClaudeCodeVersionFromInit reads system/init.claude_code_version', () => {
  const runtime = {};
  assert.equal(recordClaudeCodeVersionFromInit(runtime, {
    type: 'system',
    subtype: 'init',
    claude_code_version: '2.1.220',
  }), true);
  assert.equal(runtime.claudeCodeVersion, '2.1.220');
});

test('missing queued_turn_count is treated as no queued turn (fold, never hang)', async () => {
  const runtime = capableRuntime({
    query: {
      cancelAsyncMessage: async () => ({ cancelled: false }),
    },
  });
  runtime.pendingSteers.set('uuid-1', { steerId: 'steer-1', prompt: 'later' });
  // queued_turn_count is optional on the SDK result; undefined must not be
  // read as "another turn is queued" (that parks executeTurn on take()).
  const { text, result } = await captureStdout(() => handleSteerResultAndMaybeContinue(runtime, {
    type: 'result',
    is_error: false,
    user_message_uuids: [],
  }));
  assert.equal(result, true);
  assert.deepEqual(parseTags(text, '[STEER_FOLDED]'), [{
    steerId: 'steer-1',
    uuid: 'uuid-1',
    prompt: 'later',
  }]);
  assert.equal(runtime.pendingSteers.size, 0);
});

test('steer lands on the runtime of its own session, not the active pointer', async () => {
  await __testing.resetState();
  const runtimeA = capableRuntime({ sessionId: 'sess-a', runtimeSessionEpoch: 'epoch-a' });
  const runtimeB = capableRuntime({ sessionId: 'sess-b', runtimeSessionEpoch: 'epoch-b' });
  registerRuntimeSession(runtimeB, 'sess-b', {});
  // A holds the process-wide active pointer; the steer targets B's session.
  __testing.setActiveTurnRuntime(runtimeA);
  const result = await steerMessagePersistent(
    { steerId: 's-b', message: 'for B', sessionId: 'sess-b', runtimeSessionEpoch: 'epoch-b' },
    { buildUserMessage },
  );
  assert.deepEqual(result, { delivered: true });
  assert.equal(runtimeB.__enqueued.length, 1);
  assert.equal(runtimeA.__enqueued.length, 0);
});

test('steer rejects when the epoch does not match the session runtime', async () => {
  await __testing.resetState();
  const runtimeB = capableRuntime({ sessionId: 'sess-b', runtimeSessionEpoch: 'epoch-b' });
  registerRuntimeSession(runtimeB, 'sess-b', {});
  const result = await steerMessagePersistent(
    { steerId: 's-b', message: 'for B', sessionId: 'sess-b', runtimeSessionEpoch: 'epoch-stale' },
    { buildUserMessage },
  );
  assert.deepEqual(result, { delivered: false, reason: STEER_REJECT.SESSION_MISMATCH });
  assert.equal(runtimeB.__enqueued.length, 0);
});

test('blank sessionId on the runtime side never matches a known sessionId', async () => {
  await __testing.resetState();
  // Anonymous runtime (session id not landed yet) holding the active pointer.
  const runtime = capableRuntime({ sessionId: '', runtimeSessionEpoch: 'epoch-new' });
  __testing.setActiveTurnRuntime(runtime);
  const result = await steerMessagePersistent(
    { steerId: 's1', message: 'hi', sessionId: 'sess-known', runtimeSessionEpoch: 'epoch-new' },
    { buildUserMessage },
  );
  assert.deepEqual(result, { delivered: false, reason: STEER_REJECT.SESSION_MISMATCH });
  assert.equal(runtime.__enqueued.length, 0);
});

test('unrelated CLI queued_command flows through when no steer is pending', () => {
  const runtime = capableRuntime();
  // CLI's own queue (peer/channel injects, SendMessage, TUI input) shares
  // commandMode 'prompt'; with no pending steer it must reach [MESSAGE].
  const consumed = tryEmitSteerFolded(runtime, {
    type: 'attachment',
    attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'cli queue item' },
  });
  assert.equal(consumed, false);
});

test('executeTurn settles pending steers as undelivered when the turn errors', async () => {
  await __testing.resetState();
  const runtime = capableRuntime({ turnSink: null });
  runtime.activeTurnCount = 0;
  runtime.cliTurnInFlight = false;
  runtime.readerProgress = 0;
  __testing.setActiveTurnRuntime(runtime);

  const turnPromise = __testing.executeTurn(runtime, {
    requestedSessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    options: { cwd: '/tmp' },
    permissionMode: 'default',
    streamingEnabled: false,
    userMessage: { type: 'user', message: { role: 'user', content: 'hi' } },
  });

  while (!runtime.turnSink) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const steer = await steerMessagePersistent(
    { steerId: 'steer-err', message: 'inject', sessionId: 'sess-1', runtimeSessionEpoch: 'epoch-1' },
    { buildUserMessage },
  );
  assert.equal(steer.delivered, true);

  const { text } = await captureStdout(async () => {
    runtime.turnSink.push({ type: 'result', is_error: true, errors: ['boom'] });
    await assert.rejects(turnPromise, /boom/);
  });

  assert.deepEqual(parseTags(text, '[STEER_UNDELIVERED]'), [{ steerId: 'steer-err' }]);
  assert.equal(runtime.pendingSteers.size, 0);
});

test('executeTurn holds back an intermediate result while a steer keeps reading', async () => {
  await __testing.resetState();
  const runtime = capableRuntime({
    turnSink: null,
    query: { cancelAsyncMessage: async () => ({ cancelled: false }) },
  });
  runtime.activeTurnCount = 0;
  runtime.cliTurnInFlight = false;
  runtime.readerProgress = 0;
  __testing.setActiveTurnRuntime(runtime);

  const turnPromise = __testing.executeTurn(runtime, {
    requestedSessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    options: { cwd: '/tmp' },
    permissionMode: 'default',
    streamingEnabled: false,
    userMessage: { type: 'user', message: { role: 'user', content: 'hi' } },
  });

  while (!runtime.turnSink) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const steer = await steerMessagePersistent(
    { steerId: 'steer-mid', message: 'inject', sessionId: 'sess-1', runtimeSessionEpoch: 'epoch-1' },
    { buildUserMessage },
  );
  assert.equal(steer.delivered, true);
  // executeTurn also enqueues the turn's own user message; find the steer by
  // its priority marker instead of assuming an index.
  const uuid = runtime.__enqueued.find((m) => m.priority === 'next')?.uuid;
  assert.equal(typeof uuid, 'string');

  const { text } = await captureStdout(async () => {
    // Sub-turn result: cancel refused and the CLI queued another turn.
    runtime.turnSink.push({ type: 'result', is_error: false, user_message_uuids: [], queued_turn_count: 1 });
    // The steered message folds at the next tool boundary.
    runtime.turnSink.push({
      type: 'user',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'inject' }] },
    });
    // Final result ends the request.
    runtime.turnSink.push({ type: 'result', is_error: false, user_message_uuids: [uuid], queued_turn_count: 0 });
    await turnPromise;
  });

  const resultMessages = text.split('\n')
    .filter((line) => line.startsWith('[MESSAGE] '))
    .map((line) => JSON.parse(line.slice('[MESSAGE] '.length)))
    .filter((m) => m.type === 'result');
  // Only the final result reaches Java; the sub-turn result must not trigger
  // turn finalization (loading, footer, usage) mid-request.
  assert.equal(resultMessages.length, 1);
  assert.deepEqual(resultMessages[0].user_message_uuids, [uuid]);
});

test('a folded record does not swallow the same text in a later turn', () => {
  const runtime = capableRuntime();
  runtime.foldedSteers.set('uuid-old', { steerId: 'steer-old', prompt: '继续' });

  // Inside the turn that emitted the fold, the replay is still recognised.
  assert.equal(
    tryEmitSteerFolded(runtime, {
      type: 'user',
      uuid: 'uuid-old',
      isReplay: true,
      message: { role: 'user', content: '继续' },
    }),
    true,
  );

  // Next turn: the stale record is gone, so the user's own message flows on to
  // [MESSAGE] instead of being treated as a replay and silently dropped.
  resetFoldedSteers(runtime);
  assert.equal(runtime.foldedSteers.size, 0);
  assert.equal(
    tryEmitSteerFolded(runtime, {
      type: 'user',
      uuid: 'uuid-new',
      message: { role: 'user', content: '继续' },
    }),
    false,
  );
});

test('folded records are capped so a long turn cannot grow them without bound', async () => {
  const runtime = capableRuntime();
  const overflow = MAX_FOLDED_STEERS + 8;
  await captureStdout(() => {
    for (let i = 0; i < overflow; i += 1) {
      runtime.pendingSteers.set(`uuid-${i}`, { steerId: `steer-${i}`, prompt: `p${i}` });
      tryEmitSteerFolded(runtime, {
        type: 'user',
        uuid: `uuid-${i}`,
        message: { role: 'user', content: `p${i}` },
      });
    }
  });

  assert.equal(runtime.foldedSteers.size, MAX_FOLDED_STEERS);
  // The ring keeps the newest folds; the oldest were evicted.
  assert.equal(runtime.foldedSteers.has(`uuid-${overflow - 1}`), true);
  assert.equal(runtime.foldedSteers.has('uuid-0'), false);
});

test('a steerId that could forge a log line is dropped, not stored', async () => {
  await __testing.resetState();
  const runtime = capableRuntime();
  __testing.setActiveTurnRuntime(runtime);
  const hostile = 'x\n[STEER_UNDELIVERED] {"steerId":"victim"}';
  const steer = await steerMessagePersistent(
    { steerId: hostile, message: 'hi', sessionId: 'sess-1', runtimeSessionEpoch: 'epoch-1' },
    { buildUserMessage },
  );
  assert.equal(steer.delivered, true);
  const record = [...runtime.pendingSteers.values()][0];
  assert.equal(record.steerId, '');
});
