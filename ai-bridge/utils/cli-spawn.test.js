/**
 * Unit tests for utils/cli-spawn.js — story 1.10 review fix M3.
 *
 * The win32 taskkill branch itself cannot run on this macOS/Linux CI box and
 * the codebase has NO platform-faking precedent (cli-path.test.js handles the
 * same constraint by extracting the win32 logic into exported pure helpers —
 * that pattern is reused here for the argument vector). The branch is
 * therefore inspection-verified; what IS pinned here:
 * - win32TreeKillArgs: the /T /F tree-kill argument contract and the
 *   untrustworthy-pid fallback (a garbage pid must fall back, never spawn
 *   `taskkill /PID undefined`).
 * - killChildTree on the current (non-win32) platform: a live child in its
 *   own process group actually dies — the semantics every killer shares.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { win32TreeKillArgs, killChildTree } from './cli-spawn.js';

const waitFor = async (predicate, deadlineMs) => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await predicate();
};

test('win32TreeKillArgs mirrors the Java manual-cancel taskkill invocation', () => {
  // PlatformUtils.terminateProcess: "taskkill", "/F", "/T", "/PID", <pid>
  assert.deepEqual(win32TreeKillArgs(4321), ['/PID', '4321', '/T', '/F']);
});

test('win32TreeKillArgs rejects untrustworthy pids so the caller falls back', () => {
  for (const bad of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '123']) {
    assert.equal(win32TreeKillArgs(bad), null, `pid=${String(bad)} must fall back to the direct kill`);
  }
});

test('killChildTree terminates a live child on the current (non-win32) platform', async () => {
  if (process.platform === 'win32') {
    return; // the direct-kill fallback path; exercised on Windows only
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: true, // same shape runCliStreaming spawns with off Windows
  });
  assert.ok(child.pid > 0, 'the fixture child spawned');
  await new Promise((resolve) => setTimeout(resolve, 150)); // let it start

  killChildTree(child, 'test');

  const exited = await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    5000,
  );
  assert.ok(exited, 'killChildTree must terminate the child (and its group)');
});

test('killChildTree is a no-op for an already-killed child', () => {
  // No real child behind this handle: if the guard is broken the win32 branch
  // would spawn taskkill /PID undefined (non-win32: process.kill(-undefined)).
  assert.doesNotThrow(() => killChildTree({ killed: true, pid: 1 }, 'test'));
});
