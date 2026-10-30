import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const daemonPath = fileURLToPath(new URL('./daemon.js', import.meta.url));
const fakeQueryUrl = new URL('./services/claude/testing/scripted-query.js', import.meta.url).href;

for (const [mode, method] of [['success', 'claude.send'], ['success', 'claude.sendWithAttachments'], ['interrupt-failure', 'claude.send'], ['close-failure', 'claude.send'], ['queued', 'claude.send']]) {
  test(`daemon ${method} reports ${mode} on the original request, separately from Stop`, { timeout: 10_000 }, async () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), 'cc-gui-daemon-cancel-'));
    const packageDir = join(fixtureHome, '.codemoss/dependencies/claude-sdk/node_modules/@anthropic-ai/claude-agent-sdk');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(fixtureHome, '.codemoss/config.json'), JSON.stringify({ claude: { current: '__cli_login__', providers: {} } }));
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module', main: 'sdk.mjs', version: '0.3.296' }));
    writeFileSync(join(packageDir, 'sdk.mjs'), `
      import { createScriptedQuery } from ${JSON.stringify(fakeQueryUrl)};
      export function query(args) {
        const query = createScriptedQuery(args);
        query.waitForInput().then(input => {
          console.log('[TEST_INPUT_RECEIVED]');
          if (input.message.content[0]?.text === 'complete') query.channel.enqueue({ type: 'result', is_error: false });
        });
        query.interrupt = async () => {
          if (${JSON.stringify(mode)} === 'interrupt-failure') throw new Error('native rejected interrupt');
        };
        const close = query.close;
        query.close = () => {
          close();
          if (${JSON.stringify(mode)} === 'close-failure') throw new Error('native cleanup failed');
        };
        return query;
      }
    `);
    const child = spawn(process.execPath, [daemonPath], {
      cwd: fixtureHome, env: { ...process.env, HOME: fixtureHome, USERPROFILE: fixtureHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    const messages = [];
    const waiting = new Set();
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      messages.push(message);
      for (const waiter of waiting) {
        if (waiter.predicate(message)) {
          waiting.delete(waiter);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
      }
    });
    function waitFor(predicate) {
      const message = messages.find(predicate);
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiter.timeout = setTimeout(() => {
          waiting.delete(waiter);
          reject(new Error(`Daemon response timed out: ${stderr}`));
        }, 5000);
        waiting.add(waiter);
      });
    }
    try {
      await waitFor(message => message.type === 'daemon' && message.event === 'ready');
      if (mode === 'queued') {
        const write = (...requests) => child.stdin.write(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
        const owner = { cwd: fixtureHome, sessionId: 'cancel-session', runtimeSessionEpoch: 'cancel-epoch' };
        const other = { cwd: fixtureHome, sessionId: 'other-session', runtimeSessionEpoch: 'other-epoch' };
        write({ id: 'active', method, params: { ...other, message: 'keep working' } });
        await waitFor(message => message.id === 'active' && message.line?.includes('[TEST_INPUT_RECEIVED]'));
        write(
          { id: 'queued', method, params: { ...owner, message: 'cancel queued input' } },
          { id: 'wrong-stop', method: 'claude.abortTurn', params: { ...owner, runtimeSessionEpoch: 'stale' } },
        );
        const wrongStop = await waitFor(message => message.id === 'wrong-stop' && message.done);
        assert.equal(wrongStop.success, false);
        assert.deepEqual(wrongStop.result, { stopped: false });
        assert.match(wrongStop.error, /No matching Claude work/);
        assert.equal(messages.some(message => message.id === 'queued' && message.done), false);
        write(
          { id: 'queued-stop', method: 'claude.abortTurn', params: owner },
          { id: 'later', method, params: { ...owner, message: 'complete' } },
        );
        const queuedResult = await waitFor(message => message.id === 'queued' && message.done);
        const queuedStop = await waitFor(message => message.id === 'queued-stop' && message.done);
        assert.equal(queuedResult.aborted, true);
        assert.equal(queuedResult.result.outcome, 'cancelled');
        assert.equal(queuedStop.success, true);
        assert.equal(messages.some(message => message.id === 'active' && message.done), false,
          'cancelling a queued owner must not clear the active request');
        write({ id: 'active-stop', method: 'claude.abortTurn', params: other });
        assert.equal((await waitFor(message => message.id === 'active' && message.done)).aborted, true);
        assert.equal((await waitFor(message => message.id === 'later' && message.done)).success, true,
          'a later send in the same epoch must survive the earlier Stop');
        assert.equal(messages.filter(message => message.id === 'queued' && message.done).length, 1);
        assert.equal(messages.some(message => message.id === 'queued' && message.line?.includes('[TEST_INPUT_RECEIVED]')), false);
        return;
      }
      child.stdin.write(JSON.stringify({ id: 'send', method, params: {
        cwd: fixtureHome, sessionId: 'cancel-session', runtimeSessionEpoch: 'cancel-epoch', message: 'keep working',
      } }) + '\n');
      await waitFor(message => message.id === 'send' && message.line?.includes('[TEST_INPUT_RECEIVED]'));
      child.stdin.write(JSON.stringify({ id: 'stop', method: 'claude.abortTurn', params: {
        sessionId: 'cancel-session', runtimeSessionEpoch: 'cancel-epoch',
      } }) + '\n');
      const [sendResult, stopResult] = await Promise.all([
        waitFor(message => message.id === 'send' && message.done),
        waitFor(message => message.id === 'stop' && message.done),
      ]);
      assert.equal(sendResult.success, false);
      assert.equal(stopResult.success, mode === 'success');
      if (mode === 'success') {
        assert.equal(sendResult.aborted, true);
        assert.equal(sendResult.result.outcome, 'cancelled');
        assert.deepEqual(stopResult.result, { stopped: true });
      } else {
        assert.equal(sendResult.aborted, undefined);
        assert.equal(sendResult.result.outcome, 'failed');
        assert.match(sendResult.error, /native (rejected interrupt|cleanup failed)/);
      }
    } finally {
      for (const waiter of waiting) clearTimeout(waiter.timeout);
      lines.close();
      child.kill('SIGTERM');
      await exited;
      rmSync(fixtureHome, { recursive: true, force: true });
    }
  });
}
