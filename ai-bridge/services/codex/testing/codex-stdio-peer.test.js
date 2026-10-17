import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const peerScript = resolve(dirname(fileURLToPath(import.meta.url)), 'codex-stdio-peer.js');

/** Minimal NDJSON client used to self-check the peer fixtures. */
class FixtureClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.lines = [];
    this.stderrBytes = 0;
    this.exited = false;
    this.exitCode = null;
    this.exitWaiters = [];

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.#onLine(line));
    child.stderr.on('data', (chunk) => { this.stderrBytes += chunk.length; });
    child.on('exit', (code) => {
      // Killed children report code=null; only the exited flag is reliable.
      this.exited = true;
      this.exitCode = code;
      for (const [, entry] of this.pending) {
        entry.reject(new Error('peer exited before responding'));
      }
      this.pending.clear();
      for (const w of this.exitWaiters.splice(0)) w(code);
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, method });
    });
    this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    return promise;
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  replyServerRequest(id, result) {
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  waitForExit() {
    if (this.exited) return Promise.resolve(this.exitCode);
    return new Promise((resolvePromise) => this.exitWaiters.push(resolvePromise));
  }

  waitForNotification(method, timeoutMs = 4000) {
    const found = this.notifications.find((n) => n.method === method);
    if (found) return Promise.resolve(found);
    if (!this.waiters) this.waiters = new Map();
    const existing = this.waiters.get(method);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`timeout waiting notification ${method}`)), timeoutMs);
      const entry = { resolve: resolvePromise, timer };
      if (existing) entry.next = existing;
      this.waiters.set(method, entry);
    });
  }

  #settleWaiters(notification) {
    if (!this.waiters) return;
    const entry = this.waiters.get(notification.method);
    if (!entry) return;
    this.waiters.delete(notification.method);
    clearTimeout(entry.timer);
    entry.resolve(notification);
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.lines.push({ unparseable: trimmed });
      return;
    }
    if (msg.method && typeof msg.id !== 'undefined') {
      this.serverRequests.push(msg);
      return;
    }
    if (msg.method) {
      this.notifications.push(msg);
      this.#settleWaiters(msg);
      return;
    }
    if (typeof msg.id !== 'undefined') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'peer error'));
      else entry.resolve(msg.result);
    }
  }
}

function startPeer(scenario, extraArgs = []) {
  const child = spawn(process.execPath, [peerScript, '--scenario', scenario, ...extraArgs], {
    cwd: dirname(peerScript),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new FixtureClient(child);
}

function terminate(client) {
  if (!client.exited) {
    client.child.kill();
  }
  return client.waitForExit();
}

test('peer serves initialize/initialized handshake', async () => {
  const client = startPeer('early-notification');
  try {
    const result = await client.request('initialize', {
      clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    assert.equal(result.userAgent, 'codex-test-peer/1.0');
    client.notify('initialized');
  } finally {
    await terminate(client);
  }
});

test('early-notification: notifications precede the turn/start ack and terminal arrives once', async () => {
  const client = startPeer('early-notification');
  try {
    await client.request('initialize', {
      clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');

    const order = [];
    const startedPromise = client.waitForNotification('turn/started').then(() => order.push('turn/started'));
    const requestPromise = client.request('turn/start', {
      threadId: 'th-test-root-0001',
      input: [{ type: 'text', text: 'hi' }],
      clientUserMessageId: 'cm-1',
    }).then(() => order.push('ack'));

    await startedPromise;
    await requestPromise;
    assert.equal(order[0], 'turn/started', 'turn/started must arrive before the ack');
    assert.equal(order[1], 'ack');

    const completed = await client.waitForNotification('turn/completed');
    assert.equal(completed.params.turn.status, 'completed');
    await new Promise((r) => setTimeout(r, 50));
    const terminalCount = client.notifications.filter((n) => n.method === 'turn/completed').length;
    assert.equal(terminalCount, 1, 'peer emits exactly one terminal');
  } finally {
    await terminate(client);
  }
});

test('reverse-approval: server request arrives and the decision drives the terminal', async () => {
  const client = startPeer('reverse-approval');
  try {
    await client.request('initialize', {
      clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');

    const requestPromise = client.request('turn/start', { threadId: 'th-test-root-0001', input: [{ type: 'text', text: 'run' }] });
    // The approval is a serverRequest (has id + method), not a notification.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(client.serverRequests.length, 1);
    const serverRequest = client.serverRequests[0];
    assert.equal(serverRequest.method, 'item/commandExecution/requestApproval');
    assert.equal(typeof serverRequest.id, 'number');

    client.replyServerRequest(serverRequest.id, { decision: 'accept' });
    await requestPromise;
    const completed = await client.waitForNotification('turn/completed');
    assert.equal(completed.params.turn.status, 'completed');
  } finally {
    await terminate(client);
  }
});

test('duplicate-terminal: peer emits duplicated terminal and a late item', async () => {
  const client = startPeer('duplicate-terminal');
  try {
    await client.request('initialize', {
      clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');

    await client.request('turn/start', { threadId: 'th-test-root-0001', input: [{ type: 'text', text: 'x' }] });
    await client.waitForNotification('turn/completed');
    await new Promise((r) => setTimeout(r, 100));
    const terminals = client.notifications.filter((n) => n.method === 'turn/completed');
    assert.equal(terminals.length, 2, 'fixture emits the duplicate terminal');
    const lateItem = client.notifications.filter(
      (n) => n.method === 'item/completed' && n.params.item.id === 'item-agent-4'
    );
    assert.equal(lateItem.length, 1, 'late item after terminal is staged');
  } finally {
    await terminate(client);
  }
});

test('disconnect-mid-turn: ack arrives but the process dies without a terminal', async () => {
  const client = startPeer('disconnect-mid-turn');
  try {
    await client.request('initialize', {
      clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    const ack = await client.request('turn/start', { threadId: 'th-test-root-0001', input: [{ type: 'text', text: 'x' }] });
    assert.ok(ack.thread, 'turn/start ack is delivered before the exit');
    const exitCode = await client.waitForExit();
    assert.notEqual(exitCode, 0);
    await new Promise((r) => setTimeout(r, 100));
    const terminals = client.notifications.filter((n) => n.method === 'turn/completed');
    assert.equal(terminals.length, 0, 'no terminal before the disconnect');
  } finally {
    if (!client.exited) client.child.kill();
    await client.waitForExit();
  }
});

test('stderr-flood: stderr bytes are drained and the turn still completes', async () => {
  const client = startPeer('stderr-flood');
  try {
    await client.request('initialize', {
      clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    await client.request('turn/start', { threadId: 'th-test-root-0001', input: [{ type: 'text', text: 'x' }] });
    const completed = await client.waitForNotification('turn/completed');
    assert.equal(completed.params.turn.status, 'completed');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(client.stderrBytes > 1024 * 1024, 'fixture emitted a stderr flood');
  } finally {
    await terminate(client);
  }
});

test('numeric-id-collision: same numeric id in both directions resolves independently', async () => {
  const client = startPeer('numeric-id-collision');
  try {
    await client.request('initialize', {
      clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    // Client turn/start gets id=1; the peer also issues server request id=1.
    const requestPromise = client.request('turn/start', { threadId: 'th-test-root-0001', input: [{ type: 'text', text: 'x' }] });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(client.serverRequests.length, 1);
    assert.equal(client.serverRequests[0].id, 1);
    client.replyServerRequest(1, { decision: 'accept' });
    await requestPromise;
    const completed = await client.waitForNotification('turn/completed');
    assert.equal(completed.params.turn.status, 'completed');
  } finally {
    await terminate(client);
  }
});

test('broken-framing: split response and multi-message chunk both parse', async () => {
  const client = startPeer('broken-framing');
  try {
    const thread = await client.request('thread/start', { cwd: '/tmp/x' });
    assert.equal(thread.thread.id, 'th-test-root-0001');
    await new Promise((r) => setTimeout(r, 50));
    const notices = client.notifications.filter((n) => n.method === 'peer/notice');
    assert.equal(notices.length, 2, 'both frames in the shared chunk arrive');
  } finally {
    await terminate(client);
  }
});

test('initialize-refusal: peer rejects the handshake', async () => {
  const client = startPeer('initialize-refusal');
  try {
    await assert.rejects(
      client.request('initialize', {
        clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      }),
      /refuses initialization/
    );
    await client.waitForExit();
  } finally {
    if (!client.exited) client.child.kill();
    await client.waitForExit();
  }
});

test('trace fixture records terminal counts without secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-peer-trace-'));
  const tracePath = join(dir, 'peer-trace.ndjson');
  const client = startPeer('early-notification', ['--trace', tracePath]);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'fixture-selfcheck', title: 'Fixture', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    await client.request('turn/start', { threadId: 'th-test-root-0001', input: [{ type: 'text', text: 'hi' }] });
    await client.waitForNotification('turn/completed');
    // Give the peer a moment to finish recording its trace before the kill.
    await new Promise((r) => setTimeout(r, 100));
    await terminate(client);
  } finally {
    if (!client.exited) client.child.kill();
    await client.waitForExit();
  }
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(tracePath, 'utf8').trim().split('\n');
  const header = JSON.parse(lines[0]);
  assert.equal(header.traceVersion, 1);
  const events = lines.slice(1).map((l) => JSON.parse(l));
  const terminalEvents = events.filter((e) => e.kind === 'notify' && e.method === 'turn/completed');
  assert.equal(terminalEvents.length, 1, 'trace terminal count matches the wire');
  const raw = lines.join('\n');
  assert.ok(!raw.includes('secret'), 'fixture trace contains no secret placeholder leakage');
});
