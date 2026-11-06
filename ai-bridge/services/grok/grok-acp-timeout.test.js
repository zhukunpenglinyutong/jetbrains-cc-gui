/**
 * ACP timeout must recycle the client — otherwise the next session/prompt hangs
 * on a still-busy agent (RuntimeException: ACP timeout waiting for session/prompt).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GrokAcpClient,
  resolveTurnPromptTimeoutMs,
  TURN_PROMPT_TIMEOUT_MS,
  MAX_TURN_PROMPT_TIMEOUT_MS,
} from './grok-acp-client.js';
import { AcpTerminalHost } from './acp-terminal-host.js';
import { formatGrokError } from './grok-event-normalizer.js';
import {
  __testing,
  getContextUsagePersistent,
} from './persistent-acp-service.js';
import { extractUsedTokens } from './grok-utils.js';

const { resetRegistry, createTestRuntime, forceSetActiveTurn, getRuntimes } = __testing;

function mockClientForRequest(options = {}) {
  const client = new GrokAcpClient({ env: {}, cwd: '/tmp', ...options });
  let killed = false;
  client.proc = {
    stdin: { write: () => {} },
    get killed() {
      return killed;
    },
    // Mirror Node's ChildProcess: exitCode is null while the process is still
    // running and a number once it has exited. grok-acp-client gates kill() on
    // `exitCode === null` (real liveness), not on `killed` (which only signals
    // that kill() was *called*), so the mock must expose exitCode too.
    get exitCode() {
      return killed ? 0 : null;
    },
    kill() {
      killed = true;
    },
  };
  client.closed = false;
  return client;
}

test('request timeout rejects with ACP_TIMEOUT and marks client unhealthy', async () => {
  const client = mockClientForRequest();

  await assert.rejects(
    () => client.request('session/prompt', { sessionId: 's1', prompt: [] }, 30),
    (err) => {
      assert.match(err.message, /ACP timeout waiting for session\/prompt/);
      assert.equal(err.code, 'ACP_TIMEOUT');
      return true;
    },
  );

  assert.equal(client.closed, true, 'client must be closed after timeout');
  assert.equal(client.unhealthy, true, 'client must be unhealthy after timeout');
  assert.equal(client.pending.size, 0);
  assert.ok(client.proc.killed, 'agent process must be killed so next turn can recover');
  assert.equal(client.isUnhealthy(), true);
});

test('request soft timeout (recycleOnTimeout:false) does not kill the agent', async () => {
  const client = mockClientForRequest();

  await assert.rejects(
    () =>
      client.request(
        'session/prompt',
        { sessionId: 's1', prompt: [{ type: 'text', text: '/always-approve off' }] },
        30,
        { recycleOnTimeout: false },
      ),
    (err) => err.code === 'ACP_TIMEOUT',
  );

  assert.equal(client.closed, false, 'control-plane timeout must not close client');
  assert.equal(client.unhealthy, undefined);
  assert.equal(client.proc.killed, false, 'must not kill mid-turn agent');
  assert.equal(client.pending.size, 0);
});

test('markUnhealthy rejects other in-flight requests', async () => {
  const client = mockClientForRequest();

  const p1 = client.request('session/prompt', { sessionId: 's1', prompt: [] }, 60_000);
  const p2 = client.request('initialize', {}, 60_000);
  assert.equal(client.pending.size, 2);

  client.markUnhealthy('forced', { killProcess: true });

  await assert.rejects(p1, /forced|ACP/);
  await assert.rejects(p2, /forced|ACP/);
  assert.equal(client.pending.size, 0);
  assert.equal(client.closed, true);
});

test('extractUsedTokens prefers total_tokens then sums parts', () => {
  assert.equal(extractUsedTokens(null), 0);
  assert.equal(extractUsedTokens({ total_tokens: 99, input_tokens: 1 }), 99);
  assert.equal(extractUsedTokens({ input_tokens: 10, output_tokens: 5 }), 15);
  assert.equal(extractUsedTokens({ prompt_tokens: 3, completion_tokens: 2 }), 5);
});

test('getContextUsagePersistent reads runtime.lastUsedTokens after usage remember', async () => {
  resetRegistry();
  const rt = createTestRuntime('timeout-rt', { model: 'grok-4.6', permissionMode: 'default' });
  rt.lastUsedTokens = 12_345;
  forceSetActiveTurn(rt);

  const payload = await getContextUsagePersistent({ maxTokens: 500_000 });
  assert.equal(payload.totalTokens, 12_345);
  assert.equal(payload.maxTokens, 500_000);
  assert.equal(payload.model, 'grok-4.6');
  assert.equal(payload.source, 'grok-synthesized');
});

test('createTestRuntime can simulate unhealthy client for recycle path', () => {
  resetRegistry();
  const client = {
    activeSessionId: 's',
    closed: true,
    unhealthy: true,
    isUnhealthy: () => true,
  };
  const rt = createTestRuntime('dead-rt', { client, sessionId: 's' });
  assert.equal(getRuntimes().length, 1);
  assert.ok(rt.client.unhealthy);
});

test('default turn prompt timeout is at least 30 minutes (long agentic runs)', () => {
  assert.ok(
    TURN_PROMPT_TIMEOUT_MS >= 30 * 60 * 1000,
    `expected >= 30m, got ${TURN_PROMPT_TIMEOUT_MS}ms`,
  );
  assert.equal(resolveTurnPromptTimeoutMs({}), 60 * 60 * 1000);
});

test('resolveTurnPromptTimeoutMs honors GROK_ACP_TURN_TIMEOUT_MS with clamps', () => {
  assert.equal(resolveTurnPromptTimeoutMs({ GROK_ACP_TURN_TIMEOUT_MS: '900000' }), 900_000);
  // below 5m floor
  assert.equal(resolveTurnPromptTimeoutMs({ GROK_ACP_TURN_TIMEOUT_MS: '1000' }), 5 * 60 * 1000);
  // above 4h ceiling
  assert.equal(
    resolveTurnPromptTimeoutMs({ GROK_ACP_TURN_TIMEOUT_MS: String(99 * 60 * 60 * 1000) }),
    4 * 60 * 60 * 1000,
  );
  assert.equal(resolveTurnPromptTimeoutMs({ GROK_ACP_TURN_TIMEOUT_MS: 'nope' }), 60 * 60 * 1000);
});

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function createFakeGrokCli(t, onMessageBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-acp-timeout-cli-'));
  const scriptPath = path.join(dir, 'fake-grok.mjs');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');
    return;
  }
  ${onMessageBody}
});
`,
    { mode: 0o755 },
  );
  const prevCliPath = process.env.GROK_CLI_PATH;
  process.env.GROK_CLI_PATH = scriptPath;
  t.after(() => {
    if (prevCliPath === undefined) {
      delete process.env.GROK_CLI_PATH;
    } else {
      process.env.GROK_CLI_PATH = prevCliPath;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  return scriptPath;
}

async function startWarmClient(t, options = {}) {
  const client = new GrokAcpClient(options);
  client.start();
  t.after(() => client.close());
  await client.request('initialize', {}, 5000);
  return client;
}

test('Story 013 AC-1: GrokAcpClient.request slides timeout on real JSON-RPC notifications and stderr chunks, then times out on true silence', async (t) => {
  createFakeGrokCli(
    t,
    `
    const mode = msg.params?.mode;
    if (mode === 'stream-notifications') {
      let count = 0;
      const iv = setInterval(() => {
        count += 1;
        if (count <= 3) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk-' + count } },
          }) + '\\n');
        } else {
          clearInterval(iv);
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn' },
          }) + '\\n');
        }
      }, 35);
    } else if (mode === 'stderr-then-silence') {
      setTimeout(() => process.stderr.write('[grok] progress tick 1\\n'), 35);
      setTimeout(() => process.stderr.write('[grok] progress tick 2\\n'), 70);
    }
    `,
  );

  const notifications = [];
  const stderrChunks = [];
  const client = await startWarmClient(t, {
    onNotification: (method, params) => notifications.push({ method, params }),
    onStderr: (chunk) => stderrChunks.push(chunk),
  });

  // 1. Streaming notifications keep an 80ms timeout window alive across ~140ms
  const res = await client.request('session/prompt', { sessionId: 's1', mode: 'stream-notifications' }, 80);
  assert.deepEqual(res, { stopReason: 'end_turn' });
  assert.equal(notifications.length, 3);

  // 2. Stderr chunks at 35ms and 70ms keep a 60ms timeout window alive past 90ms, then silence times out
  const startedAt = Date.now();
  await assert.rejects(
    () => client.request('session/prompt', { sessionId: 's1', mode: 'stderr-then-silence' }, 60),
    (err) => {
      assert.equal(err.code, 'ACP_TIMEOUT');
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 110, `expected stderr ticks to slide timeout past 110ms, got ${elapsed}ms`);
  assert.ok(stderrChunks.join('').includes('progress tick 2'));
});

test('Story 013 AC-2: GrokAcpClient.request defers timeout while real onServerRequest permission prompt or terminal/wait_for_exit is in flight', async (t) => {
  createFakeGrokCli(
    t,
    `
    if (msg.method === 'session/prompt') {
      globalThis.promptId = msg.id;
      // 1. Ask client for permission
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 501,
        method: 'session/request_permission',
        params: { toolCall: { name: 'Bash' } },
      }) + '\\n');
      return;
    }
    if (msg.id === 501) {
      // 2. Spawn a terminal command that runs silently for 110ms
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 502,
        method: 'terminal/create',
        params: {
          sessionId: 's1',
          command: ${JSON.stringify(process.execPath)},
          args: ['-e', 'setTimeout(() => process.exit(0), 110)'],
        },
      }) + '\\n');
      return;
    }
    if (msg.id === 502) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 503,
        method: 'terminal/wait_for_exit',
        params: { terminalId: msg.result?.terminalId },
      }) + '\\n');
      return;
    }
    if (msg.id === 503) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: globalThis.promptId,
        result: { stopReason: 'end_turn', exitCode: msg.result?.exitCode },
      }) + '\\n');
    }
    `,
  );

  const terminalHost = new AcpTerminalHost({ authorizeCreate: async () => true });
  const client = await startWarmClient(t, {
    terminalHost,
    onServerRequest: async (method, _params, id, acp) => {
      if (method === 'session/request_permission') {
        await new Promise((r) => setTimeout(r, 110));
        acp.respond(id, { outcome: { outcome: 'selected', optionId: 'allow' } });
        return true;
      }
      return false;
    },
  });

  // Both the 110ms permission prompt and 110ms silent wait_for_exit exceed the 50ms timeout window
  const result = await client.request('session/prompt', { sessionId: 's1', prompt: [] }, 50);
  assert.deepEqual(result, { stopReason: 'end_turn', exitCode: 0 });
  assert.equal(client.activeServerRequests, 0);
});

test('Review item 1a: a background terminal command (dev server) without wait_for_exit does not keep a hung turn alive', async (t) => {
  createFakeGrokCli(
    t,
    `
    if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 601,
        method: 'terminal/create',
        params: {
          sessionId: 's1',
          command: ${JSON.stringify(process.execPath)},
          args: ['-e', 'setInterval(() => process.stdout.write("tick\\\\n"), 20)'],
        },
      }) + '\\n');
    }
    // After terminal/create responds (id 601), agent hangs and never replies to session/prompt.
    `,
  );

  const terminalHost = new AcpTerminalHost({ authorizeCreate: async () => true });
  const client = await startWarmClient(t, { terminalHost });

  const startedAt = Date.now();
  await assert.rejects(
    () => client.request('session/prompt', { sessionId: 's1', prompt: [] }, 80),
    (err) => err.code === 'ACP_TIMEOUT',
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 800, `hung turn with chatty background terminal must time out promptly, took ${elapsed}ms`);
});

test('Review item 1b: a command that backgrounds a child holding stdio (`sleep 30 &`) finishes wait_for_exit and lets a hung turn time out', async (t) => {
  createFakeGrokCli(
    t,
    `
    if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 701,
        method: 'terminal/create',
        params: {
          sessionId: 's1',
          command: ${JSON.stringify(process.execPath)},
          args: [
            '-e',
            'import("node:child_process").then(({ spawn }) => { spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { stdio: "inherit" }); process.exit(0); })',
          ],
        },
      }) + '\\n');
      return;
    }
    if (msg.id === 701) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 702,
        method: 'terminal/wait_for_exit',
        params: { terminalId: msg.result.terminalId },
      }) + '\\n');
    }
    // After wait_for_exit responds (id 702), agent hangs.
    `,
  );

  const terminalHost = new AcpTerminalHost({ authorizeCreate: async () => true });
  const client = await startWarmClient(t, { terminalHost });

  const startedAt = Date.now();
  await assert.rejects(
    () => client.request('session/prompt', { sessionId: 's1', prompt: [] }, 80),
    (err) => err.code === 'ACP_TIMEOUT',
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1200, `backgrounded child holding pipe must not block wait_for_exit or timeout (took ${elapsed}ms)`);
});

test('Review item 1c: hard cap on total request time terminates a hung turn despite continuous stderr retry output or stuck active work', async (t) => {
  assert.equal(MAX_TURN_PROMPT_TIMEOUT_MS, 4 * 60 * 60 * 1000);
  createFakeGrokCli(
    t,
    `
    if (msg.method === 'session/prompt') {
      setInterval(() => {
        process.stderr.write('[grok] retrying request...\\n');
      }, 20);
    }
    `,
  );

  const client = await startWarmClient(t);

  const startedAt = Date.now();
  await assert.rejects(
    () => client.request('session/prompt', { sessionId: 's1', prompt: [] }, 80, { maxTimeoutMs: 180 }),
    (err) => err.code === 'ACP_TIMEOUT',
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 150 && elapsed < 700, `expected hard cap around 180ms, got ${elapsed}ms`);
  assert.equal(client.isUnhealthy(), true);
});

test('Review item 2: formatGrokError returns original ACP_TIMEOUT message even when stderr contains .403Z timestamps or oauth logs', () => {
  const err403Timestamp = Object.assign(new Error('ACP timeout waiting for session/prompt'), {
    code: 'ACP_TIMEOUT',
    method: 'session/prompt',
    stderr: '2026-11-04T12:40:31.403Z [INFO] Grok agent started\n',
  });
  assert.equal(formatGrokError(err403Timestamp), 'ACP timeout waiting for session/prompt');

  const errOauthLog = Object.assign(new Error('ACP timeout waiting for session/prompt'), {
    code: 'ACP_TIMEOUT',
    method: 'session/prompt',
    stderr: '[GROK-ACP] oauth token refreshed successfully\n',
  });
  assert.equal(formatGrokError(errOauthLog), 'ACP timeout waiting for session/prompt');
});

test('Review item 3: soft timeouts (recycleOnTimeout: false) hold their fixed deadline without sliding or deferring on active work', async (t) => {
  createFakeGrokCli(
    t,
    `
    if (msg.method === 'session/prompt') {
      // Keep streaming notifications and open a server request while _x.ai/billing is ignored
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 801,
        method: 'session/request_permission',
        params: { toolCall: { name: 'Bash' } },
      }) + '\\n');
      const iv = setInterval(() => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } },
        }) + '\\n');
      }, 20);
      setTimeout(() => {
        clearInterval(iv);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn' },
        }) + '\\n');
      }, 240);
    }
    // Deliberately never reply to _x.ai/billing
    `,
  );

  const client = await startWarmClient(t, {
    onServerRequest: async (_method, _params, id, acp) => {
      await new Promise((r) => setTimeout(r, 200));
      acp.respond(id, { outcome: { outcome: 'selected', optionId: 'allow' } });
      return true;
    },
  });

  const turnPromise = client.request('session/prompt', { sessionId: 's1', prompt: [] }, 500);
  await new Promise((r) => setTimeout(r, 30));

  const softStart = Date.now();
  await assert.rejects(
    () => client.request('_x.ai/billing', {}, 60, { recycleOnTimeout: false }),
    (err) => err.code === 'ACP_TIMEOUT',
  );
  const softElapsed = Date.now() - softStart;
  assert.ok(softElapsed < 160, `soft request must fire at its 60ms deadline without sliding/deferring (took ${softElapsed}ms)`);
  assert.equal(client.closed, false, 'soft timeout must leave client open');
  assert.equal(client.isUnhealthy(), false, 'soft timeout must not mark client unhealthy');

  const turnRes = await turnPromise;
  assert.deepEqual(turnRes, { stopReason: 'end_turn' });
});

test('Review item 4: AcpTerminalHost runs absolute-path commands with args through login shell so profile env vars are preserved', async (t) => {
  if (process.platform === 'win32') return;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-profile-'));
  const profileLine = 'export MY_PROFILE_VAR="from_profile"\n';
  for (const rc of ['.zprofile', '.zshenv', '.bash_profile', '.profile']) {
    fs.writeFileSync(path.join(fakeHome, rc), profileLine, 'utf8');
  }

  const host = new AcpTerminalHost({
    defaultCwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fakeHome,
      ZDOTDIR: fakeHome,
    },
    authorizeCreate: async () => true,
  });
  t.after(async () => {
    await host.disposeAll();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  const { terminalId } = await host.create({
    sessionId: 's1',
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.MY_PROFILE_VAR || ""); process.exit(process.env.MY_PROFILE_VAR ? 0 : 1);'],
  });
  const waited = await host.waitForExit({ terminalId });
  const out = await host.output({ terminalId });
  assert.equal(waited.exitCode, 0, `expected exit 0 with login profile var, got output: ${out.output}`);
  assert.equal(out.output.trim(), 'from_profile');
});

test('Review items 5 & 6: release() gives grandchild SIGTERM handler time to clean up, and kill/release terminate real grandchild processes', async (t) => {
  if (process.platform === 'win32') return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-term-grandchild-'));
  const host = new AcpTerminalHost({
    defaultCwd: tmpDir,
    authorizeCreate: async () => true,
  });
  t.after(async () => {
    await host.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Grandchild with SIGTERM cleanup handler + release()
  const pidFile1 = path.join(tmpDir, 'grandchild1.pid');
  const cleanedFile1 = path.join(tmpDir, 'cleaned1.txt');
  const grandchildScript1 = path.join(tmpDir, 'grandchild1.mjs');
  fs.writeFileSync(
    grandchildScript1,
    `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(pidFile1)}, String(process.pid));
    process.on('SIGTERM', () => {
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(cleanedFile1)}, 'cleaned');
        process.exit(0);
      }, 40);
    });
    setInterval(() => {}, 1000);
    `,
  );

  const { terminalId: t1 } = await host.create({
    sessionId: 's1',
    command: process.execPath,
    args: [grandchildScript1],
  });

  const waitPid = async (file) => {
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(file) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return Number(fs.readFileSync(file, 'utf8').trim());
  };

  const grandchildPid1 = await waitPid(pidFile1);
  assert.ok(isPidAlive(grandchildPid1), 'grandchild 1 should be running before release()');

  await host.release({ terminalId: t1 });
  assert.equal(fs.existsSync(cleanedFile1), true, 'release() must give grandchild SIGTERM handler time to clean up');
  assert.equal(isPidAlive(grandchildPid1), false, 'grandchild 1 must be terminated after release()');

  // 2. Grandchild that ignores SIGTERM is killed by SIGKILL after ~500ms on kill()
  const pidFile2 = path.join(tmpDir, 'grandchild2.pid');
  const grandchildScript2 = path.join(tmpDir, 'grandchild2.mjs');
  fs.writeFileSync(
    grandchildScript2,
    `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(pidFile2)}, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    `,
  );

  const { terminalId: t2 } = await host.create({
    sessionId: 's1',
    command: process.execPath,
    args: [grandchildScript2],
  });

  const grandchildPid2 = await waitPid(pidFile2);
  assert.ok(isPidAlive(grandchildPid2), 'grandchild 2 should be running before kill()');

  await host.kill({ terminalId: t2 });
  assert.equal(isPidAlive(grandchildPid2), false, 'grandchild 2 ignoring SIGTERM must be killed by SIGKILL');
  await host.release({ terminalId: t2 });
});


