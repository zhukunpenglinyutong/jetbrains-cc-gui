/**
 * End-to-end scheduling of grok.getPlanUsage against the real daemon.js and a
 * fake `grok agent stdio` (GROK_CLI_PATH). A poll and a chat turn must never
 * wait on each other, and the poll must not write into the turn's stream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(here, '../../daemon.js');
const FAKE_AGENT = join(here, 'testing/fake-grok-agent.mjs');
const WAIT_MS = 15_000;

// Outside Windows the daemon spawns GROK_CLI_PATH directly, so it must be executable
// even in a checkout that dropped the file mode.
if (process.platform !== 'win32') {
  chmodSync(FAKE_AGENT, 0o755);
}

/** Parsed stdout messages plus a waiter that resolves on the first match. */
function collectMessages(stream) {
  const messages = [];
  const listeners = new Set();
  createInterface({ input: stream }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    messages.push(msg);
    for (const listener of listeners) listener(msg);
  });

  const waitFor = (predicate, label) => new Promise((resolve, reject) => {
    const hit = messages.find(predicate);
    if (hit) {
      resolve(hit);
      return;
    }
    const listener = (msg) => {
      if (!predicate(msg)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(msg);
    };
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`timed out waiting for ${label}`));
    }, WAIT_MS);
    listeners.add(listener);
  });

  return { messages, waitFor };
}

async function stopDaemon(child, exited, home) {
  child.stdin.end();
  const killer = setTimeout(() => child.kill('SIGKILL'), 8_000);
  await exited;
  clearTimeout(killer);
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A slow agent exit on Windows can hold the temp dir; it is not part of the assertion.
  }
}

function startDaemon(extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'grok-plan-usage-'));
  const agentLog = join(home, 'agent.log');
  const child = spawn(process.execPath, [DAEMON], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: 'test',
      GROK_CLI_PATH: FAKE_AGENT,
      FAKE_GROK_LOG: agentLog,
      ...extraEnv,
    },
  });
  child.stderr.resume();
  // A daemon that died early must fail an assertion, not crash the file with EPIPE.
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const { messages, waitFor } = collectMessages(child.stdout);

  return {
    home,
    messages,
    waitFor,
    send: (id, method, params) => child.stdin.write(JSON.stringify({ id, method, params }) + '\n'),
    agentRequests: () => (existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('\n').filter(Boolean) : []),
    stop: () => stopDaemon(child, exited, home),
  };
}

const isDone = (id) => (msg) => msg.id === id && msg.done === true;

function turnParams(home) {
  return {
    message: 'hello',
    cwd: home,
    sessionId: '',
    permissionMode: 'default',
    model: '',
    authMethod: 'oauth',
    apiKey: '',
    baseUrl: '',
    streaming: true,
    runtimeSessionEpoch: 'plan-usage-test',
  };
}

function usageParams(home) {
  return { cwd: home, authMethod: 'oauth', apiKey: '', baseUrl: '', ephemeral: true };
}

test('a plan-usage poll is answered while a chat turn is still streaming', async () => {
  const daemon = startDaemon({ FAKE_GROK_TURN_MS: '3000' });
  try {
    await daemon.waitFor((msg) => msg.event === 'ready', 'daemon ready');
    daemon.send('turn-1', 'grok.send', turnParams(daemon.home));
    await daemon.waitFor(
      (msg) => msg.id === 'turn-1' && typeof msg.line === 'string' && msg.line.startsWith('[CONTENT_DELTA]'),
      'first streamed chunk',
    );

    daemon.send('usage-1', 'grok.getPlanUsage', usageParams(daemon.home));
    const usage = await daemon.waitFor(isDone('usage-1'), 'plan usage reply');
    assert.equal(
      daemon.messages.some(isDone('turn-1')),
      false,
      'the poll must not wait for the turn to finish',
    );
    assert.equal(usage.success, true);
    assert.equal(usage.result.present, true);
    assert.equal(usage.result.capacity_pct, 42);

    await daemon.waitFor(isDone('turn-1'), 'turn end');
    assert.equal(daemon.messages.filter((msg) => msg.id === 'usage-1' && !msg.done).length, 0);
    const turnLines = daemon.messages.filter((msg) => msg.id === 'turn-1' && typeof msg.line === 'string');
    assert.ok(turnLines.length > 0);
    assert.ok(turnLines.every((msg) => !/billing|getPlanUsage/i.test(msg.line)), 'no poll output in the turn stream');
  } finally {
    await daemon.stop();
  }
});

test('a chat turn starts and finishes while a cold plan-usage poll hangs on billing', async () => {
  const daemon = startDaemon({ FAKE_GROK_BILLING: 'hang', FAKE_GROK_TURN_MS: '500' });
  try {
    await daemon.waitFor((msg) => msg.event === 'ready', 'daemon ready');
    daemon.send('usage-1', 'grok.getPlanUsage', usageParams(daemon.home));
    const deadline = Date.now() + WAIT_MS;
    while (!daemon.agentRequests().includes('_x.ai/billing') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(daemon.agentRequests().includes('_x.ai/billing'), 'the cold poll reached billing');

    daemon.send('turn-1', 'grok.send', turnParams(daemon.home));
    const turn = await daemon.waitFor(isDone('turn-1'), 'turn end');
    assert.equal(turn.success, true);
    assert.equal(
      daemon.messages.some(isDone('usage-1')),
      false,
      'the turn must not queue behind the hung poll',
    );
  } finally {
    await daemon.stop();
  }
});
