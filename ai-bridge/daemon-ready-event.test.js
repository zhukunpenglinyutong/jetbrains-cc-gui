import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), 'daemon.js');

async function readReadyEvent(extraEnv) {
  const home = mkdtempSync(join(tmpdir(), 'daemon-ready-'));
  const { WSL_DISTRO_NAME: ignored, ...env } = process.env;
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...env, HOME: home, USERPROFILE: home, ...extraEnv },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = line.startsWith('{') ? JSON.parse(line) : null;
      if (message?.type === 'daemon' && message.event === 'ready') {
        return message;
      }
    }
    throw new Error('daemon exited before signaling ready');
  } finally {
    child.kill();
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

test('the ready event reports the WSL distro the daemon runs in', async () => {
  const ready = await readReadyEvent({ WSL_DISTRO_NAME: 'Debian' });

  assert.equal(ready.wslDistro, 'Debian');
});

test('the ready event names no distro outside WSL', async () => {
  const ready = await readReadyEvent({});

  assert.equal('wslDistro' in ready, false);
});
