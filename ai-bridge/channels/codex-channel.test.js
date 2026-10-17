import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the standalone Codex channel exits after reaping its native transport', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-channel-'));
  const child = spawn(process.execPath, [resolve('ai-bridge/channel-manager.js'), 'codex', 'send'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'codex'), CODEX_USE_STDIN: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ channelId: 'probe', cwd: home, message: 'fixture',
    codexCommandPrefix: [process.execPath, resolve('ai-bridge/services/codex/testing/codex-stdio-peer.js'),
      '--scenario', 'early-notification'],
  }));
  try {
    const result = await Promise.race([
      new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code))),
      new Promise((resolveTimeout) => { const timer = setTimeout(() => resolveTimeout('timeout'), 5000); timer.unref(); }),
    ]);
    assert.equal(result, 0, 'the completed command exits naturally');
  } finally { child.kill(); }
});
