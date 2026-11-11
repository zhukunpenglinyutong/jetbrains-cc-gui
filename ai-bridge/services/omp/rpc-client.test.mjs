import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { OmpRpcClient } from './rpc-client.js';
import { fakeOmp } from './testing/fake-omp.js';

test('correlates responses by id and hands every other frame to onFrame', async () => {
  const omp = fakeOmp({
    on: {
      get_session_stats: [
        { emit: { type: 'extension_ui_request', id: 'ui-1', method: 'setWidget' } },
        { respond: { sessionId: 'sess-1' } },
      ],
      get_state: [{ respond: { isStreaming: false } }],
    },
  });
  const frames = [];
  const client = omp.createClient((frame) => frames.push(frame));
  try {
    const ready = await client.start();
    assert.equal(ready.type, 'ready');

    // Answers arrive in command order here; each must reach its own caller.
    const [stats, state] = await Promise.all([
      client.request({ type: 'get_session_stats' }),
      client.request({ type: 'get_state' }),
    ]);
    assert.deepEqual(stats, { sessionId: 'sess-1' });
    assert.deepEqual(state, { isStreaming: false });
    assert.deepEqual(frames, [{ type: 'extension_ui_request', id: 'ui-1', method: 'setWidget' }]);

    assert.deepEqual(await client.close(), { code: 0, signal: null });
  } finally {
    client.kill();
    omp.cleanup();
  }
});

test('a failed command rejects with omp\'s error text and code', async () => {
  const omp = fakeOmp({ on: { fork: [{ fail: 'Session is busy', code: 'session_busy' }] } });
  const client = omp.createClient();
  try {
    await client.start();
    await assert.rejects(client.request({ type: 'fork' }), (error) => {
      assert.equal(error.message, 'Session is busy');
      assert.equal(error.code, 'session_busy');
      return true;
    });
  } finally {
    await client.close();
    omp.cleanup();
  }
});

test('a caller-chosen id is kept so later frames can be matched to the command', async () => {
  const omp = fakeOmp({ on: { prompt: [{ respond: null }] } });
  const client = omp.createClient();
  try {
    await client.start();
    await client.request({ id: 'prompt', type: 'prompt', message: 'hi' });
    assert.deepEqual(omp.received(), [{ id: 'prompt', type: 'prompt', message: 'hi' }]);
  } finally {
    await client.close();
    omp.cleanup();
  }
});

test('a missing binary rejects start and settles exited', async () => {
  const client = new OmpRpcClient({
    bin: 'ccgui-test-no-such-omp-binary-4c1d',
    args: ['--mode', 'rpc'],
    cwd: tmpdir(),
  });
  await assert.rejects(client.start(), (error) => {
    assert.equal(error.code, 'ENOENT');
    assert.match(error.message, /OMP CLI not found/);
    return true;
  });
  const exit = await client.exited;
  assert.notEqual(exit.code, 0);
  // Later calls fail the same way instead of hanging.
  await assert.rejects(client.request({ type: 'get_state' }), /OMP CLI not found/);
  await client.close();
});

test('a process that dies mid-request rejects the request with its exit code and stderr', async () => {
  const omp = fakeOmp({ on: { prompt: [{ stderr: 'fatal: model catalog is corrupt\n' }, { exit: 3 }] } });
  const client = omp.createClient();
  try {
    await client.start();
    await assert.rejects(client.request({ type: 'prompt', message: 'hi' }, { timeoutMs: 0 }), (error) => {
      assert.match(error.message, /exited with code 3/);
      assert.match(error.message, /model catalog is corrupt/);
      return true;
    });
    assert.deepEqual(await client.exited, { code: 3, signal: null });
  } finally {
    omp.cleanup();
  }
});

test('a request without an answer times out and leaves the client usable', async () => {
  const omp = fakeOmp({ on: { compact: [], get_state: [{ respond: { ok: true } }] } });
  const client = omp.createClient();
  try {
    await client.start();
    await assert.rejects(client.request({ type: 'compact' }, { timeoutMs: 50 }), /did not answer "compact" within 50 ms/);
    assert.deepEqual(await client.request({ type: 'get_state' }), { ok: true });
  } finally {
    await client.close();
    omp.cleanup();
  }
});

test('start rejects when the process never reports ready', async () => {
  const omp = fakeOmp({ ready: false });
  const client = omp.createClient();
  try {
    await assert.rejects(client.start({ timeoutMs: 200 }), /did not become ready within 200 ms/);
    // The stuck process is killed rather than left behind.
    const exit = await client.exited;
    assert.notEqual(exit.code, 0);
  } finally {
    omp.cleanup();
  }
});
