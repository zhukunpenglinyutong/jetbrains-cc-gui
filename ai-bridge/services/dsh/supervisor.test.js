import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCliSpawn } from '../../utils/cli-path.js';
import { looksLikeDshHostCommand, stopSpawnedHost } from './supervisor.js';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('looksLikeDshHostCommand matches the recorded bin path or basename', () => {
  assert.equal(
    looksLikeDshHostCommand(
      '/home/u/.hermes/node/bin/dsh web --host 127.0.0.1',
      '/home/u/.hermes/node/bin/dsh'
    ),
    true
  );
  assert.equal(looksLikeDshHostCommand('node /usr/local/bin/dsh web', '/usr/local/bin/dsh'), true);
  // A shim may show only the basename, not the recorded absolute path.
  assert.equal(looksLikeDshHostCommand('dsh.exe web --port 3080', 'C:\\tools\\dsh.exe'), true);
});

test('looksLikeDshHostCommand accepts dsh-looking tokens when no bin is recorded', () => {
  assert.equal(looksLikeDshHostCommand('dsh web --port 3080', null), true);
  assert.equal(looksLikeDshHostCommand('/usr/local/bin/dsh web', ''), true);
  assert.equal(looksLikeDshHostCommand('node /opt/dsh/dist/dsh.js web', null), true);
  assert.equal(looksLikeDshHostCommand('dsh.cmd web', undefined), true);
});

test('looksLikeDshHostCommand rejects unrelated processes (PID reuse guard)', () => {
  assert.equal(looksLikeDshHostCommand('', null), false);
  assert.equal(looksLikeDshHostCommand('/usr/bin/adsh --serve', null), false);
  assert.equal(looksLikeDshHostCommand('vim /tmp/notes-dsh.txt', null), false);
  assert.equal(looksLikeDshHostCommand('node server.js --name mydsh', null), false);
});

test('stopSpawnedHost preserves another origin and returns the reused pid', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-stop-test-'));
  const previousHome = process.env.HOME;
  const stateFile = join(home, '.codemoss', 'dsh-host.json');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.env.HOME = home;
  try {
    mkdirSync(join(home, '.codemoss'));
    writeFileSync(stateFile, JSON.stringify({
      pid: child.pid, bin: 'dsh.cmd', origin: 'http://127.0.0.1:3080',
    }));
    assert.deepEqual(await stopSpawnedHost({ host: '127.0.0.1', port: 3081 }), {
      success: true, stopped: false, reason: 'no-spawned-host',
    });
    assert.ok(existsSync(stateFile));
    const result = await stopSpawnedHost({ host: '127.0.0.1', port: 3080 });
    assert.deepEqual(result, { success: true, stopped: false, reason: 'pid-reused', pid: child.pid });
    assert.equal(isAlive(child.pid), true);
    assert.equal(existsSync(stateFile), false);
  } finally {
    child.kill();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('stopSpawnedHost terminates the Windows cmd shim and its children', {
  skip: process.platform !== 'win32',
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-stop-tree-test-'));
  const previousHome = process.env.HOME;
  const stateFile = join(home, '.codemoss', 'dsh-host.json');
  const childPidFile = join(home, 'child.pid').replaceAll('\\', '/');
  const shim = join(home, 'dsh.cmd');
  writeFileSync(shim,
    `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync('${childPidFile}', String(process.pid)); setInterval(() => {}, 1000)"\r\n`);
  const invocation = resolveCliSpawn(shim, ['web', '--host', '127.0.0.1', '--port', '3080']);
  const child = spawn(invocation.file, invocation.args, { ...invocation.options, stdio: 'ignore' });
  process.env.HOME = home;
  try {
    mkdirSync(join(home, '.codemoss'));
    writeFileSync(stateFile, JSON.stringify({
      pid: child.pid, bin: shim, origin: 'http://127.0.0.1:3080',
    }));
    const deadline = Date.now() + 5000;
    while (!existsSync(childPidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(existsSync(childPidFile));
    const descendantPid = Number(readFileSync(childPidFile, 'utf8'));
    assert.ok(descendantPid > 0);
    assert.deepEqual(await stopSpawnedHost({ host: '127.0.0.1', port: 3080 }), {
      success: true, stopped: true, pid: child.pid,
    });
    assert.equal(isAlive(child.pid), false);
    assert.equal(isAlive(descendantPid), false);
    assert.equal(existsSync(stateFile), false);
  } finally {
    for (const pid of [child.pid, Number(existsSync(childPidFile) ? readFileSync(childPidFile, 'utf8') : 0)]) {
      if (isAlive(pid)) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
      }
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
