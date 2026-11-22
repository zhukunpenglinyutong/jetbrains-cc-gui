import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';

const STALL_ENV = 'CC_GUI_CLAUDE_STALL_TIMEOUT_MS';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRuntime() {
  return {
    closed: false,
    abortRequested: false,
    sessionId: null,
    runtimeSessionEpoch: null,
    activeTurnCount: 0,
    inputStream: { enqueue() {}, done() {} },
    query: { close() {} },
  };
}

function startTurn(runtime) {
  const turn = __testing.executeTurn(runtime, {
    requestedSessionId: null,
    runtimeSessionEpoch: null,
    options: { cwd: '/tmp' },
    permissionMode: 'default',
    streamingEnabled: false,
    userMessage: { type: 'user', message: { role: 'user', content: 'hi' } },
  });
  turn.catch(() => {});
  return turn;
}

async function sinkOf(runtime) {
  while (!runtime.turnSink) {
    await sleep(0);
  }
  return runtime.turnSink;
}

const resultMessage = { type: 'result', subtype: 'success', is_error: false, result: 'done' };

const toolUseMessage = (id) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 1' } }] },
});

const toolResultMessage = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

async function withStallTimeout(value, body) {
  const previous = process.env[STALL_ENV];
  process.env[STALL_ENV] = String(value);
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env[STALL_ENV];
    } else {
      process.env[STALL_ENV] = previous;
    }
  }
}

test('a turn that receives nothing from the upstream fails with a clear error instead of hanging', async () => {
  await withStallTimeout(80, async () => {
    const runtime = createRuntime();
    const turn = startTurn(runtime);
    await sinkOf(runtime);

    const outcome = await Promise.race([
      turn.then(() => 'resolved', (error) => error),
      sleep(2000).then(() => 'still hanging'),
    ]);

    assert.notEqual(outcome, 'still hanging');
    assert.notEqual(outcome, 'resolved');
    assert.match(outcome.message, /stopped responding/i);
    assert.equal(outcome.runtimeTerminated, true);
  });
});

test('every received message restarts the stall window', async () => {
  await withStallTimeout(150, async () => {
    const runtime = createRuntime();
    const turn = startTurn(runtime);
    const sink = await sinkOf(runtime);

    for (let index = 0; index < 5; index += 1) {
      await sleep(80);
      sink.push({ type: 'system', subtype: 'status', session_id: 'sess-1' });
    }
    sink.push(resultMessage);

    await turn;
  });
});

test('a running tool never counts as a stalled upstream', async () => {
  await withStallTimeout(80, async () => {
    const runtime = createRuntime();
    const turn = startTurn(runtime);
    const sink = await sinkOf(runtime);

    sink.push(toolUseMessage('tool-1'));
    const early = await Promise.race([turn.then(() => 'settled', () => 'settled'), sleep(400).then(() => 'waiting')]);
    assert.equal(early, 'waiting');

    sink.push(toolResultMessage('tool-1'));
    sink.push(resultMessage);
    await turn;
  });
});

test('the stall window applies again once the tool has returned', async () => {
  await withStallTimeout(80, async () => {
    const runtime = createRuntime();
    const turn = startTurn(runtime);
    const sink = await sinkOf(runtime);

    sink.push(toolUseMessage('tool-1'));
    await sleep(200);
    sink.push(toolResultMessage('tool-1'));

    await assert.rejects(turn, /stopped responding/i);
  });
});

test('setting the stall timeout to 0 disables the watchdog', async () => {
  await withStallTimeout(0, async () => {
    const runtime = createRuntime();
    const turn = startTurn(runtime);
    const sink = await sinkOf(runtime);

    const early = await Promise.race([turn.then(() => 'settled', () => 'settled'), sleep(300).then(() => 'waiting')]);
    assert.equal(early, 'waiting');

    sink.push(resultMessage);
    await turn;
  });
});
