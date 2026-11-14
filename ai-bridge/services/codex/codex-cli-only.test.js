import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

test('legacy SDK preferences still use native catalogs, history and cancellation in the production daemon',
  { timeout: 30_000 }, async t => {
    const home = mkdtempSync(join(tmpdir(), 'codex-cli-only-'));
    const config = join(home, '.codemoss');
    const native = join(home, '.codex');
    const sdk = join(config, 'dependencies/codex-sdk/node_modules/@openai/codex-sdk');
    mkdirSync(sdk, { recursive: true });
    mkdirSync(native);
    writeFileSync(join(config, 'config.json'), JSON.stringify({ codexRuntimeBackend: 'sdk', aiTitleGenerationEnabled: false }));
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
    writeFileSync(join(sdk, 'index.js'), 'throw new Error("Legacy SDK must never be imported");');
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: native,
      CLAUDE_PERMISSION_DIR: join(home, 'permissions'), CLAUDE_SESSION_ID: 'cli-only-fixture' };
    for (const key of Object.keys(env)) {
      if (/API_KEY|TOKEN|SECRET|AUTHORIZATION|NODE_OPTIONS/i.test(key)) delete env[key];
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../daemon.js', import.meta.url))], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const frames = [];
    const waiters = new Set();
    let diagnostics = '';
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try { frames.push(JSON.parse(line)); } catch { diagnostics += line + '\n'; }
      for (const wake of waiters) wake();
    });
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    const closed = new Promise(resolve => child.once('close', resolve));
    t.after(async () => {
      child.stdin.end();
      const kill = setTimeout(() => child.kill(), 6000);
      try { await closed; }
      finally { clearTimeout(kill); lines.close(); rmSync(home, { recursive: true, force: true }); }
    });
    const waitFor = predicate => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Daemon receipt/event missing: ${diagnostics}`));
      }, 15_000);
      function check() {
        const result = frames.find(predicate);
        if (!result) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(result);
      }
      waiters.add(check);
      check();
    });
    const host = { channelId: 'cli-host', sessionEpoch: 'cli-epoch', runtimeBackend: 'sdk', authMode: 'cli_login', cwd: home,
      codexCommandPrefix: [process.execPath, fileURLToPath(new URL('./testing/codex-stdio-peer.js', import.meta.url)),
        '--scenario', 'async-question', '--quiet'] };
    const send = (id, method, params = {}) => child.stdin.write(JSON.stringify({ id, method, params: { ...host, ...params } }) + '\n');
    const receipt = id => waitFor(frame => frame.id === id && frame.done === true);
    await waitFor(frame => frame.type === 'daemon' && frame.event === 'ready');
    send('models', 'codex.listModels');
    send('skills', 'codex.listSkills');
    send('mcp', 'codex.getMcpStatus');
    send('history', 'codex.readHistoryPage', { threadId: 'th-test-root-0001' });
    const [models, skills, mcp, history] = await Promise.all(['models', 'skills', 'mcp', 'history'].map(receipt));
    for (const result of [models, skills, mcp, history]) assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(models.result.data[0].id, 'test-model');
    assert.equal(skills.result.data[0].skills[0].name, 'test-skill');
    assert.equal(mcp.result.data[0].name, 'fixture-mcp');
    assert.ok(history.result.messages.length > 0);
    send('running', 'codex.send', { message: 'fixture' });
    await waitFor(frame => frame.type === 'daemon' && frame.event === 'codex_event'
      && frame.channelId === host.channelId && frame.kind === 'interactionRequested');
    send('stop', 'codex.abortTurn');
    const [stop, turn] = await Promise.all(['stop', 'running'].map(receipt));
    assert.equal(stop.success, true);
    assert.equal(stop.result.stopped, true);
    assert.equal(stop.result.reason, 'interrupted');
    assert.equal(turn.success, false);
    assert.equal(turn.result.outcome, 'interrupted');
    for (const id of ['models', 'skills', 'mcp', 'history', 'stop', 'running']) {
      assert.equal(frames.filter(frame => frame.id === id && frame.done).length, 1);
    }
    assert.doesNotMatch(diagnostics, /Legacy SDK must never|Uncaught exception|then is not a function/);
  });
