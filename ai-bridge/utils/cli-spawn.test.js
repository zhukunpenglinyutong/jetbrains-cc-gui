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
import {
  win32TreeKillArgs,
  killChildTree,
  posixTreeKillEscalate,
  runCliStreaming,
  spawnCliSync,
  trimPartialUtf8Head,
} from './cli-spawn.js';
import { decodeCliOutput } from './cli-path.js';

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

// posixTreeKillEscalate: the injected kill/timer seams make the
// SIGTERM→SIGKILL escalation deterministic without real timing or platform
// fakes (same rationale as the win32TreeKillArgs pins above).

/** Fake child + recorded calls, shared shape across the escalation pins. */
function makeEscalationHarness({ killFn } = {}) {
  const calls = [];
  const child = {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    kill: (signal) => calls.push(`handle:${signal}`),
  };
  const timers = [];
  const unrefd = [];
  const deps = {
    killFn: killFn ?? ((pid, signal) => calls.push(`${pid}:${signal}`)),
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref: () => unrefd.push('timer') };
    },
    clearTimeoutFn: () => {},
  };
  return { child, calls, timers, unrefd, deps };
}

test('posixTreeKillEscalate sends SIGTERM to the group, then SIGKILL after the window', () => {
  const { child, calls, timers, unrefd, deps } = makeEscalationHarness();

  const disarmer = posixTreeKillEscalate(child, { escalateAfterMs: 5000, ...deps });

  assert.deepEqual(calls, ['-4321:SIGTERM'], 'graceful signal goes to the process group first');
  assert.equal(timers.length, 1, 'exactly one escalation timer armed');
  assert.equal(timers[0].ms, 5000);
  assert.equal(typeof disarmer, 'function', 'a disarmer is returned');

  // The child ignored SIGTERM (still alive when the window elapses).
  timers[0].fn();
  assert.deepEqual(calls, ['-4321:SIGTERM', '-4321:SIGKILL'], 'the window ends in SIGKILL');
  assert.deepEqual(unrefd, ['timer'], 'the escalation timer must be unref’d');
});

test('posixTreeKillEscalate skips SIGKILL when the child is already reaped', () => {
  const { child, calls, timers, deps } = makeEscalationHarness({
    // The graceful kill lands: Node records the exit on the handle.
    killFn: (pid, signal) => {
      calls.push(`${pid}:${signal}`);
      child.exitCode = 0;
    },
  });

  posixTreeKillEscalate(child, deps);
  assert.deepEqual(calls, ['-4321:SIGTERM']);

  timers[0].fn();
  assert.deepEqual(calls, ['-4321:SIGTERM'], 'a reaped child gets no follow-up signal');
});

test('posixTreeKillEscalate falls back to the handle kill when the group is gone', () => {
  // ESRCH-shaped failure: the group id no longer resolves, the direct handle
  // kill is the only signal that can still reach the child.
  const { child, calls, deps } = makeEscalationHarness({
    killFn: () => {
      throw new Error('kill ESRCH');
    },
  });

  posixTreeKillEscalate(child, deps);

  assert.deepEqual(calls, ['handle:SIGTERM']);
});

test('posixTreeKillEscalate falls back to the handle kill for the SIGKILL escalation too', () => {
  // The group id no longer resolves (ESRCH on EVERY group attempt — a dead
  // group stays dead) but the child lingers on its handle; the escalation
  // must degrade the same way as the first signal, not throw past
  // killChildTree's guard.
  const { child, calls, timers, deps } = makeEscalationHarness({
    killFn: () => {
      throw new Error('kill ESRCH');
    },
  });

  posixTreeKillEscalate(child, deps);
  assert.deepEqual(calls, ['handle:SIGTERM']);

  timers[0].fn();
  assert.deepEqual(
    calls,
    ['handle:SIGTERM', 'handle:SIGKILL'],
    'SIGTERM fell back to the handle; the escalation must fall back the same way',
  );
});

test('Story 012 AC-1: posixTreeKillEscalate catches EPERM/ESRCH from both killFn(-pid) and child.kill fallback on SIGTERM and SIGKILL', () => {
  const { child, calls, timers, deps } = makeEscalationHarness({
    killFn: () => {
      const err = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    },
  });
  child.kill = (signal) => {
    calls.push(`handle-fail:${signal}`);
    const err = new Error('kill EPERM');
    err.code = 'EPERM';
    throw err;
  };

  // 1. Initial SIGTERM: when both killFn(-pid) and child.kill throw, posixTreeKillEscalate must NOT throw synchronously.
  assert.doesNotThrow(() => {
    posixTreeKillEscalate(child, deps);
  }, 'initial SIGTERM must swallow errors from both killFn and child.kill');

  assert.deepEqual(calls, ['handle-fail:SIGTERM']);
  assert.equal(timers.length, 1);

  // 2. Delayed SIGKILL: when the timer fires and child is still alive, and both throw, the timer callback must NOT throw.
  assert.doesNotThrow(() => {
    timers[0].fn();
  }, 'escalation SIGKILL callback must swallow errors from both killFn and child.kill');

  assert.deepEqual(calls, ['handle-fail:SIGTERM', 'handle-fail:SIGKILL']);
});

test('a UTF-8 character split across stderr chunks survives decoding', async () => {
  // Review repro: decodeCliOutput used to run on each stderr chunk, so a
  // multi-byte character cut at a chunk boundary turned into U+FFFD and the
  // per-chunk GBK fallback then garbled the whole chunk into mojibake. The
  // stream now decodes incrementally with StringDecoder and only re-decodes
  // the complete tail at close, so split characters survive on every platform
  // (the GBK retry is win32-only and never sees partial sequences).
  const text = '错误：找不到会话文件，请重新登录';
  const bytes = Buffer.from(text, 'utf8');
  const split = 7; // lands INSIDE the third multi-byte character
  const asArray = (buf) => JSON.stringify([...buf]);
  const script = ''
    + `process.stderr.write(Buffer.from(${asArray(bytes.subarray(0, split))}));`
    + 'process.exitCode = 2;'
    + `setTimeout(() => process.stderr.write(Buffer.concat([Buffer.from(${asArray(bytes.subarray(split))}), Buffer.from('\\n')])), 30);`;
  const result = await runCliStreaming({
    bin: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    label: 'SplitCli',
    onLine: () => {},
    emitEndStream: false,
    onError: () => { /* capture via the resolved errorMessage instead */ },
  });
  assert.equal(result.code, 2);
  assert.ok(
    result.errorMessage.includes(text),
    `the reassembled tail must equal the original text: ${result.errorMessage}`,
  );
  assert.equal(result.errorMessage.includes('\uFFFD'), false);
  // The GBK mis-read of the same bytes ('閿欒' etc.) must never appear.
  assert.equal(result.errorMessage.includes('閿'), false);
  assert.equal(result.errorMessage.includes('鎵'), false);
});

test('a healthy run resolves without an error message', async () => {
  const result = await runCliStreaming({
    bin: process.execPath,
    args: ['-e', 'console.log("ok")'],
    cwd: process.cwd(),
    label: 'OkCli',
    onLine: () => {},
    emitEndStream: false,
    onError: () => {},
  });
  assert.equal(result.code, 0);
  assert.equal(result.hadError, false);
  assert.equal(result.errorMessage, undefined);
});

test('a byte-capped stderr tail that starts mid-character still decodes as UTF-8 on win32', () => {
  const text = '错误：找不到会话文件';
  const cut = Buffer.from(text, 'utf8').subarray(1); // tail cap landed inside the first character
  // Repro: the leading continuation bytes turn into U+FFFD and win32 re-decodes everything as GBK.
  assert.notEqual(decodeCliOutput(cut, { forceWindows: true }), text.slice(1));
  assert.equal(decodeCliOutput(trimPartialUtf8Head(cut), { forceWindows: true }), text.slice(1));
  const whole = Buffer.from(text, 'utf8');
  assert.equal(trimPartialUtf8Head(whole), whole);
});

test('spawnCliSync runs a CLI synchronously and returns its output', () => {
  const result = spawnCliSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
});
