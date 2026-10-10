import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CodexAppServerClient,
} from './codex-appserver-client.js';
import { startPeerWithStreams } from './testing/codex-stdio-peer.js';

const here = dirname(fileURLToPath(import.meta.url));
const peerScript = resolve(here, 'testing', 'codex-stdio-peer.js');

function spawnPeerCommand(scenario) {
  return [process.execPath, peerScript, '--scenario', scenario];
}

function makeClient(scenario, overrides = {}) {
  return new CodexAppServerClient({
    command: spawnPeerCommand(scenario),
    cwd: here,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 3000,
    ...overrides,
  });
}

function makeInProcessClient(scenario, { clientOpts = {}, peerOpts = {} } = {}) {
  const clientToPeer = new PassThrough();
  const peerToClient = new PassThrough();
  const peerStderr = new PassThrough();
  const peer = startPeerWithStreams({
    scenario,
    input: clientToPeer,
    output: peerToClient,
    stderr: peerStderr,
    onExit: () => {},
    ...peerOpts,
  });
  const client = new CodexAppServerClient({
    command: ['in-process-peer'],
    requestTimeoutMs: 3000,
    ...clientOpts,
    spawnFn: () => ({
      stdin: clientToPeer,
      stdout: peerToClient,
      stderr: peerStderr,
      pid: -1,
      on: () => {},
      kill: () => true,
    }),
  });
  return { client, peer, stderrStream: peerStderr };
}

function waitForNotification(client, method, timeoutMs = 15_000, filter = null) {
  // 15s: loaded CI runners can stall the in-process peer's stream pump well
  // past 4s; the timeout only bounds genuine failures, not happy paths.
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`timeout waiting notification ${method}`)),
      timeoutMs
    );
    const onNotification = (n) => {
      if (n.method === method && (!filter || filter(n))) {
        client.removeListener('notification', onNotification);
        clearTimeout(timer);
        resolvePromise(n);
      }
    };
    client.on('notification', onNotification);
  });
}

test('process exit drains final frames before close settles the transport exactly once', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  Object.assign(child, { stdin: input, stdout: output, stderr, pid: -1, kill: () => true });
  const peer = startPeerWithStreams({ scenario: 'native-read-only', input, output, stderr, onExit: () => {} });
  const client = new CodexAppServerClient({ command: ['in-process-peer'], spawnFn: () => child });
  const events = [];
  client.on('notification', (event) => events.push(event));
  client.on('exited', () => events.push({ method: 'exited' }));
  try {
    await client.ensureInitialized();
    peer.dispatch = (_method, _params, id) => peer.rememberPendingAck(id);
    const reply = client.request('fixture/draining');
    await new Promise((resolve) => setImmediate(resolve));
    const requestId = [...peer.pendingAcks.keys()][0];
    child.emit('exit', 0, null);
    assert.equal(client.exitSettled, false);
    assert.equal(client.alive, false);
    await assert.rejects(client.request('fixture/after-exit'), { code: 'CHILD_EXITED' });
    assert.equal(peer.pendingAcks.size, 1);
    peer.ackPending(requestId, { drained: true });
    peer.notify({ method: 'item/completed', params: { item: { id: 'final', type: 'agentMessage', text: '完整尾部 🧪' } } });
    peer.notify({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
    assert.deepEqual(await reply, { drained: true });
    output.end();
    stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    await client.waitForExit();
    child.emit('close', 0, null);
    assert.deepEqual(events.map((event) => event.method), ['item/completed', 'turn/completed', 'exited']);
    assert.equal(events[0].params.item.text, '完整尾部 🧪');
    assert.equal(client.pendingRequests.size, 0);
  } finally {
    client.close();
    input.end();
  }
});

test('a pre-handshake exit keeps a sanitized stderr tail and marks the failure as startup', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  Object.assign(child, { stdin: input, stdout: output, stderr, pid: -1, kill: () => true });
  const client = new CodexAppServerClient({
    command: ['fixture-codex', 'app-server'],
    env: { OPENAI_API_KEY: 'synthetic-startup-secret' },
    spawnFn: () => child,
  });
  try {
    const initialize = client.ensureInitialized();
    const exited = new Promise((resolve) => client.on('exited', resolve));
    stderr.write('Error: spawn vendor/codex ENOENT synthetic-startup-secret\n');
    stderr.write('launcher: incomplete install\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('exit', 1, null);
    output.end();
    stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 1, null);

    const failure = await exited;
    await assert.rejects(initialize, (error) => error.code === 'CHILD_EXITED');
    // The canonical message stays byte-identical for existing consumers; the
    // launch facts travel out of band.
    assert.equal(failure.message, 'codex app-server exited (code=1, signal=null)');
    assert.equal(failure.startupFailure, true);
    assert.deepEqual(failure.details.command, ['fixture-codex', 'app-server']);
    assert.match(failure.details.stderr, /ENOENT/);
    assert.ok(!failure.details.stderr.includes('synthetic-startup-secret'));
    assert.ok(client.stderrTail().length >= 1);
  } finally {
    client.close();
    input.end();
  }
});

test('a runtime that was ready before the exit is not reported as a startup failure', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  Object.assign(child, { stdin: input, stdout: output, stderr, pid: -1, kill: () => true });
  const client = new CodexAppServerClient({ command: ['in-process-peer'], spawnFn: () => child });
  const peer = startPeerWithStreams({ scenario: 'early-notification', input, output, stderr, onExit: () => {} });
  try {
    await client.ensureInitialized();
    const exited = new Promise((resolve) => client.on('exited', resolve));
    child.emit('exit', 0, null);
    output.end();
    stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    const failure = await exited;
    assert.equal(failure.startupFailure, undefined);
    assert.equal(failure.details, undefined);
    assert.equal(failure.message, 'codex app-server exited (code=0, signal=null)');
    assert.ok(peer);
  } finally {
    client.close();
    input.end();
  }
});

test('a post-spawn process error keeps its exit lease until the owned child actually closes', async () => {
  const client = makeClient('native-read-only', { env: { ...process.env, TEST_API_KEY: 'synthetic-token' } });
  const failures = [];
  client.on('processError', (error) => failures.push(error));
  try {
    await client.ensureInitialized();
    client.child.emit('error', new Error('fixture termination failed synthetic-token'));
    assert.equal(client.exitSettled, false);
    assert.equal(client.closeRequested, true);
    assert.equal(client.alive, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message.includes('synthetic-token'), false);
    await client.waitForExit();
    assert.equal(client.exitSettled, true);
    assert.equal(client.pendingRequests.size, 0);
  } finally {
    client.close();
    // A failing retirement assertion must still reap this test's real child.
    if (client.child && client.child.exitCode === null && client.child.signalCode === null) {
      await new Promise((resolve) => {
        client.child.once('close', resolve);
        client.child.kill();
      });
    }
  }
});

test('a grandchild holding the stdio pipes cannot hang waitForExit after the child exits', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  Object.assign(child, { stdin: input, stdout: output, stderr, pid: -1, kill: () => true });
  startPeerWithStreams({ scenario: 'native-read-only', input, output, stderr, onExit: () => {} });
  const client = new CodexAppServerClient({
    command: ['in-process-peer'], spawnFn: () => child, exitDrainTimeoutMs: 50,
  });
  try {
    await client.ensureInitialized();
    // The child exits but 'close' never fires: a surviving grandchild still
    // holds the inherited pipe write ends. The drain grace must settle exit.
    child.emit('exit', 0, null);
    assert.equal(client.exitSettled, false);
    const err = await client.waitForExit();
    assert.equal(client.exitSettled, true);
    assert.equal(err.code, 'CHILD_EXITED');
    assert.equal(client.state, 'exited');
  } finally {
    client.close();
    input.end();
    output.end();
    stderr.end();
  }
});

test('closing a retired process cancels the delayed process-group kill', async (t) => {
  const client = makeClient('native-read-only');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalKill = process.kill;
  const kills = [];
  try {
    await client.ensureInitialized();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    process.kill = (pid, signal) => { kills.push({ pid, signal }); return true; };
    // The PID belongs to this real peer; simulated POSIX signals never reach the OS.
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    client.close();
    Object.defineProperty(process, 'platform', platform);
    await client.waitForExit();
    t.mock.timers.tick(4000);
    assert.deepEqual(kills, [{ pid: -client.child.pid, signal: 'SIGTERM' }]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.kill = originalKill;
    t.mock.timers.reset();
    client.close();
  }
});

test('an actual child input error fails pending RPCs, scrubs credentials and awaits exit', async () => {
  const client = makeClient('never-respond', { env: { ...process.env, TEST_API_KEY: 'synthetic-token' } });
  const failures = [];
  client.on('stdinError', error => failures.push(error));
  try {
    await client.ensureInitialized();
    const pending = client.request('turn/start', { threadId: 'th-test-root-0001', input: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.pendingRequests.size, 1);
    client.child.stdin.emit('error', new Error('fixture broken pipe synthetic-token'));
    await assert.rejects(pending, error => error.code === 'WRITE_FAILED' && !error.message.includes('synthetic-token'));
    assert.equal(client.closeRequested, true);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].message.includes('synthetic-token'), false);
    await client.waitForExit();
    assert.equal(client.exitSettled, true);
    assert.equal(client.pendingRequests.size, 0);
  } finally { client.close(); await client.waitForExit(); }
});

test('custom native credential names redact RPC errors and stderr without hiding unrelated environment values', async () => {
  const { client, peer, stderrStream } = makeInProcessClient('native-read-only', { clientOpts: {
    env: { TEAM_KEY: 'fixture-team-credential', CUSTOM: 'fixture-custom-value', PUBLIC_VALUE: 'ordinary-visible-data' },
    sensitiveEnvNames: ['TEAM_KEY', 'CUSTOM'],
  } });
  const stderr = [];
  client.on('stderrLine', line => stderr.push(line));
  try {
    await client.ensureInitialized();
    const echoed = 'rejected fixture-team-credential fixture-custom-value ordinary-visible-data';
    peer.dispatch = async (_method, _params, id) => peer.replyError(id, { code: -32601, message: echoed });
    await assert.rejects(client.request('fixture/credential-error'), error => error.code === 'RPC_ERROR'
      && error.rpcCode === -32601 && !error.message.includes('fixture-team-credential')
      && !error.message.includes('fixture-custom-value') && error.message.includes('ordinary-visible-data'));
    stderrStream.write(echoed + '\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(stderr, ['rejected [redacted credential] [redacted credential] ordinary-visible-data']);
  } finally { client.close(); }
});

test('numeric native errors preserve RPC_ERROR classification and scrub the launch credential', async () => {
  const { client, peer } = makeInProcessClient('native-read-only', { clientOpts: { env: { TEST_API_KEY: 'synthetic-token' } } });
  try {
    await client.ensureInitialized();
    peer.dispatch = async (_method, _params, id) => peer.replyError(id, { code: -32601, message: 'rejected synthetic-token' });
    await assert.rejects(client.request('fixture/error'), (error) => error.code === 'RPC_ERROR'
      && error.rpcCode === -32601 && !error.message.includes('synthetic-token'));
  } finally { client.close(); }
});

test('malformed frames are dropped without retiring the transport and never expose a known credential', async () => {
  const { client, peer } = makeInProcessClient('native-read-only', { clientOpts: { env: { TEST_TOKEN: 'synthetic-token' } } });
  const errors = [];
  client.on('protocolError', (error) => errors.push(error));
  try {
    await client.ensureInitialized();
    peer.raw('not-json synthetic-token\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.alive, true, 'a malformed line must not close the runtime');
    assert.equal(errors[0].code, 'PROTOCOL_ERROR');
    assert.equal(errors[0].message.includes('synthetic-token'), false);
    const read = await client.request('config/read', {});
    assert.ok(read.config, 'framing resyncs after a malformed line');
  } finally { client.close(); }
});

test('native resolution invalidates deferred handlers without consuming a reused RPC id', async () => {
  const handlers = [];
  const { client, peer } = makeInProcessClient('native-read-only', { clientOpts: {
    onServerRequest: (_method, _params, ctx) => new Promise((resolve) => handlers.push({ ctx, resolve })),
  } });
  try {
    await client.ensureInitialized();
    peer.serverRequest('reused', 'item/tool/requestUserInput', {});
    await new Promise((resolve) => setImmediate(resolve));
    const old = handlers[0];
    const resolved = waitForNotification(client, 'serverRequest/resolved');
    peer.notify({ method: 'serverRequest/resolved', params: { requestId: 'reused' } });
    await resolved;
    assert.equal(client.serverRequests.has('reused'), false);
    assert.equal(old.ctx.isPending(), false);
    peer.serverRequest('reused', 'item/tool/requestUserInput', {});
    await new Promise((resolve) => setImmediate(resolve));
    const current = handlers[1];
    old.resolve({ obsolete: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(current.ctx.isPending(), true);
    assert.equal(client.serverRequests.has('reused'), true);
    const reply = peer.waitServerResponse('reused');
    current.resolve({ current: true });
    assert.deepEqual(await reply, { current: true });
    assert.equal(client.serverRequests.has('reused'), false);
  } finally { client.close(); }
});

test('all invalid frame diagnostics scrub launch credentials', async () => {
  const { client, peer } = makeInProcessClient('native-read-only', { clientOpts: { env: { TEST_TOKEN: 'synthetic-token' } } });
  const errors = [];
  client.on('protocolError', (error) => errors.push(error));
  try {
    await client.ensureInitialized();
    peer.raw('"synthetic-token"\n');
    peer.raw('{"unroutable":"synthetic-token"}\n');
    assert.equal(errors.length, 2);
    assert.equal(errors.some((error) => error.message.includes('synthetic-token')), false);
  } finally { client.close(); }
});

// ---------------------------------------------------------------------------
// 3.1 framing / spawn
// ---------------------------------------------------------------------------

test('split and multi-message frames both parse (broken-framing fixture)', async () => {
  const client = makeClient('broken-framing');
  try {
    const thread = await client.request('thread/start', { cwd: '/tmp/x' });
    assert.equal(thread.thread.id, 'th-test-root-0001', 'split response frame reassembled');
    const turn = await client.request('turn/start', { threadId: thread.thread.id, input: [] });
    assert.ok(turn.thread, 'turn/start survives the framing scenario');
    assert.equal(client.state, 'ready');
  } finally {
    client.close();
  }
});

test('heavy stderr output does not block request processing', async () => {
  const client = makeClient('stderr-flood');
  let stderrBytes = 0;
  client.on('stderrLine', (line) => { stderrBytes += line.length + 1; });
  try {
    const turn = await client.request('turn/start', { threadId: 'th-test-root-0001', input: [] });
    assert.ok(turn.thread, 'request completes under a stderr flood');
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(stderrBytes > 1024, 'stderr was drained independently');
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------------------
// 3.2 initialize single flight
// ---------------------------------------------------------------------------

test('concurrent requests share exactly one initialize handshake', async () => {
  const { client, peer } = makeInProcessClient('early-notification');
  let initializeCount = 0;
  const originalDispatch = peer.dispatch.bind(peer);
  peer.dispatch = (method, params, id) => {
    if (method === 'initialize') {
      initializeCount += 1;
    }
    return originalDispatch(method, params, id);
  };
  try {
    const [a, b] = await Promise.all([
      client.request('turn/start', { threadId: 'th-test-root-0001', input: [] }),
      client.request('turn/start', { threadId: 'th-test-root-0001', input: [] }),
    ]);
    assert.ok(a.thread && b.thread);
    assert.equal(client.state, 'ready');
    assert.equal(initializeCount, 1, 'exactly one handshake for concurrent callers');
  } finally {
    client.close();
  }
});

test('initialize refusal surfaces and no business RPC is sent', async () => {
  const client = makeClient('initialize-refusal');
  const notifications = [];
  client.on('notification', (n) => notifications.push(n));
  await assert.rejects(
    client.request('turn/start', { threadId: 'th-test-root-0001', input: [] }),
    (err) => err.code === 'INIT_FAILED' && /refuses initialization/.test(err.message)
  );
  assert.equal(notifications.length, 0, 'no turn events arrive without a handshake');
  client.close();
});

// ---------------------------------------------------------------------------
// 3.3 structure-based dispatch, id types preserved
// ---------------------------------------------------------------------------

test('same numeric id in both directions resolves independently', async () => {
  const decisions = [];
  // In-process peer: this test verifies protocol-level id independence, and a
  // spawned child's scheduling stall on loaded Windows CI must not gate it.
  const { client } = makeInProcessClient('numeric-id-collision', {
    clientOpts: {
      onServerRequest: async (method, params, ctx) => {
        assert.equal(method, 'item/commandExecution/requestApproval');
        assert.equal(ctx.id, 1, 'server request carries its own numeric id');
        assert.equal(params.itemId, 'item-cmd-collide');
        decisions.push(ctx.id);
        return { decision: 'accept' };
      },
    },
  });
  try {
    // The client request id is 1 (initialize used the sentinel), so this
    // collides with the server request id 1 in the fixture.
    // Registered before the request: the ack and its following notifications
    // can share one stdout chunk, so a listener attached after the await
    // would miss them.
    const completed = waitForNotification(client, 'turn/completed');
    const turn = await client.request('turn/start', { threadId: 'th-test-root-0001', input: [] });
    assert.ok(turn.thread, 'client request resolved independently of the server request');
    assert.equal((await completed).params.turn.status, 'completed');
    assert.deepEqual(decisions, [1]);
  } finally {
    client.close();
  }
});

test('string server request ids are preserved end to end', async () => {
  const seen = [];
  const { client } = makeInProcessClient('string-id-reverse', {
    clientOpts: {
      onServerRequest: async (_method, _params, ctx) => {
        seen.push(ctx.id);
        return { decision: 'accept' };
      },
    },
  });
  try {
    const completed = waitForNotification(client, 'turn/completed');
    await client.request('turn/start', { threadId: 'th-test-root-0001', input: [] });
    assert.ok(await completed);
    assert.deepEqual(seen, ['server-fixture-77']);
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------------------
// 3.4 timeouts, late responses, exit classification
// ---------------------------------------------------------------------------

test('written timeout keeps writtenUnconfirmed phase; late ack reaches lateResponse', async () => {
  const { client, peer } = makeInProcessClient('never-respond', {
    clientOpts: { requestTimeoutMs: 200 },
  });
  const lateResponses = [];
  client.on('lateResponse', (entry) => lateResponses.push(entry));
  try {
    await assert.rejects(
      client.request('turn/start', { threadId: 'th-test-root-0001', input: [] }),
      (err) => err.code === 'RPC_TIMEOUT' && err.phase === 'writtenUnconfirmed'
    );
    assert.equal(lateResponses.length, 0);
    assert.ok(!client.pendingRequests.has(1), 'timed-out entry left the pending map');

    const acked = peer.ackPending(1);
    assert.equal(acked, true, 'fixture had the pending ack');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(lateResponses.length, 1, 'late response surfaced for service correlation');
    assert.equal(lateResponses[0].id, 1);
  } finally {
    client.close();
  }
});

test('child exit during a turn classifies as CHILD_EXITED and leaves no entries', async () => {
  const client = makeClient('disconnect-mid-turn', { requestTimeoutMs: 8000 });
  const exits = [];
  client.on('exited', (err) => exits.push(err));
  try {
    // turn/start acks before the exit; the ack resolves the first request.
    await client.request('turn/start', { threadId: 'th-test-root-0001', input: [] });
    await new Promise((resolvePromise) => client.once('exited', resolvePromise));
    assert.equal(client.state, 'exited');
    assert.equal(exits.length, 1, 'exactly one exit finalization');
    assert.equal(exits[0].code, 'CHILD_EXITED');
    await assert.rejects(
      client.request('turn/start', { threadId: 'th-test-root-0001', input: [] }),
      (err) => ['CHILD_EXITED', 'INIT_FAILED'].includes(err.code)
    );
    assert.equal(client.pendingRequests.size, 0, 'no pending entries after exit');
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------------------
// 3.5 non-blocking reverse requests
// ---------------------------------------------------------------------------

test('notifications flow while a reverse request waits for the UI', async () => {
  const events = [];
  let releaseReply;
  const replyGate = new Promise((resolvePromise) => { releaseReply = resolvePromise; });
  const client = makeClient('reverse-approval-with-traffic', {
    onServerRequest: async (method, params, ctx) => {
      events.push({ type: 'serverRequest', method, id: ctx.id, itemId: params.itemId });
      await replyGate;
      return { decision: 'accept' };
    },
  });
  try {
    // Traffic while the approval is still open: proves the reader never waits.
    const traffic = waitForNotification(
      client,
      'item/started',
      3000,
      (n) => n.params.item?.id === 'item-agent-traffic'
    );
    // An ACK and its following notifications can share one stdout chunk.
    await client.request('turn/start', { threadId: 'th-test-root-0001', input: [] });
    await traffic;
    assert.equal(events.length, 1, 'approval remained open while traffic flowed');
    const completed = waitForNotification(client, 'turn/completed');
    releaseReply();
    await completed;
  } finally {
    releaseReply();
    client.close();
  }
});

// ---------------------------------------------------------------------------
// 3.7 unknown requests/notifications
// ---------------------------------------------------------------------------

test('unknown server request is answered unsupported and the turn continues', async () => {
  const client = makeClient('unknown-server-request', {
    onServerRequest: async (method) => {
      throw Object.assign(new Error(`no UI handler for ${method}`), { code: -32601 });
    },
  });
  let unknownNotificationSeen = false;
  client.on('notification', (n) => {
    if (n.method === 'peer/__futureFeature') {
      unknownNotificationSeen = true;
    }
  });
  try {
    const completed = waitForNotification(client, 'turn/completed');
    await client.request('turn/start', { threadId: 'th-test-root-0001', input: [] });
    await completed;
    assert.equal(unknownNotificationSeen, true, 'unknown notification reached the consumer');
  } finally {
    client.close();
  }
});

test('missing handler answers unsupported without hanging the peer', async () => {
  const client = makeClient('unknown-server-request');
  try {
    const completed = waitForNotification(client, 'turn/completed');
    await client.request('turn/start', { threadId: 'th-test-root-0001', input: [] });
    await completed;
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------------------
// 3.6 close and cleanup
// ---------------------------------------------------------------------------

test('close terminates the child, is idempotent, and rejects later requests', async () => {
  const client = makeClient('early-notification');
  await client.ensureInitialized();
  assert.equal(client.state, 'ready');
  client.close();
  client.close();
  await assert.rejects(
    client.request('turn/start', { threadId: 'th-test-root-0001', input: [] }),
    (err) => ['CLOSED', 'CHILD_EXITED', 'INIT_FAILED'].includes(err.code)
  );
});

test('in-process close ends stdin (peer exits) and rejects the next request', async () => {
  const { client } = makeInProcessClient('early-notification');
  await client.ensureInitialized();
  client.close();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(
    client.request('turn/start', { threadId: 'x', input: [] }),
    (err) => ['CLOSED', 'CHILD_EXITED'].includes(err.code)
  );
});
