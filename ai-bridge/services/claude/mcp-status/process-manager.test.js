/**
 * Tests for safeKillProcess in process-manager.js
 *
 * Regression test for #1721: killing the client process is not enough for
 * `docker run -i --rm` MCP servers - the container only terminates when its
 * stdin receives EOF. safeKillProcess must close stdin FIRST and give EOF a
 * grace period to propagate before falling back to signals.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { safeKillProcess } from './process-manager.js';

/**
 * Spawn a child that mimics a `docker run -i --rm` MCP server:
 * it ignores SIGTERM (the signal can't reach the container anyway) and only
 * exits when its stdin reaches EOF - exactly like a dockerised MCP server
 * whose CLI client closed the stream (which makes --rm fire).
 */
function spawnStdinDrivenChild() {
  return spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => { /* ignore: mimic docker client dying */ });
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('data', () => { /* keep reading */ });
    // Stay alive until stdin EOF
    setInterval(() => {}, 1000);
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Resolve when the child exits, or reject after the timeout.
 * @returns {Promise<number>} exit code (null when killed by a signal)
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('safeKillProcess closes stdin so stdin-driven children exit gracefully', async () => {
  const child = spawnStdinDrivenChild();
  assert.ok(child.stdin, 'child should have a piped stdin');

  const exited = waitForExit(child, 10000);
  safeKillProcess(child, 'test-server');
  const code = await exited;

  // Exit code 0 = the child observed stdin EOF and exited by itself,
  // exactly like a `docker run -i --rm` container cleaning up.
  assert.equal(code, 0);
});

test('safeKillProcess is a no-op for null/already-dead children', async () => {
  // null child must not throw
  safeKillProcess(null, 'null-server');

  // stdin already destroyed must not throw
  const child = spawnStdinDrivenChild();
  child.stdin.destroy();
  safeKillProcess(child, 'dead-server');
  assert.ok(true);
});

test('safeKillProcess is idempotent when called twice', async () => {
  const child = spawnStdinDrivenChild();
  const exited = waitForExit(child, 10000);
  safeKillProcess(child, 'double-server');
  safeKillProcess(child, 'double-server');
  const code = await exited;
  assert.equal(code, 0);
});
