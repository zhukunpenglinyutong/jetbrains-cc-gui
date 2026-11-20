import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  getClaudeCliPathOverride,
  claudeCliSdkOptions,
  createBatchLauncherSpawner,
} from './claude-cli-path.js';

/**
 * Runs `fn` with CLAUDE_CODE_PATH set to `value` (or unset when `value === undefined`),
 * restoring the previous environment afterwards so tests stay isolated.
 */
function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CODE_PATH');
  const prev = process.env.CLAUDE_CODE_PATH;
  if (value === undefined) {
    delete process.env.CLAUDE_CODE_PATH;
  } else {
    process.env.CLAUDE_CODE_PATH = value;
  }
  try {
    return fn();
  } finally {
    if (had) process.env.CLAUDE_CODE_PATH = prev;
    else delete process.env.CLAUDE_CODE_PATH;
  }
}

test('returns null when CLAUDE_CODE_PATH is unset', () => {
  withEnv(undefined, () => {
    assert.equal(getClaudeCliPathOverride(), null);
  });
});

test('returns null when CLAUDE_CODE_PATH is blank/whitespace only', () => {
  withEnv('   \t  ', () => {
    assert.equal(getClaudeCliPathOverride(), null);
  });
});

test('trims surrounding whitespace from the configured path', () => {
  withEnv('  /usr/local/bin/claude  ', () => {
    assert.equal(getClaudeCliPathOverride(), '/usr/local/bin/claude');
  });
});

test('returns the path unchanged when already clean', () => {
  withEnv('/opt/claude/bin/claude', () => {
    assert.equal(getClaudeCliPathOverride(), '/opt/claude/bin/claude');
  });
});

test('claudeCliSdkOptions adds nothing without an override', () => {
  assert.deepEqual(claudeCliSdkOptions(null), {});
  assert.deepEqual(claudeCliSdkOptions(undefined), {});
});

test('claudeCliSdkOptions passes a regular executable straight to the SDK', () => {
  for (const override of ['C:\\tools\\claude.exe', 'C:\\tools\\launcher.js', '/opt/claude/bin/claude']) {
    assert.deepEqual(
      claudeCliSdkOptions(override, { forceWindows: true }),
      { pathToClaudeCodeExecutable: override },
    );
  }
});

test('claudeCliSdkOptions leaves a .cmd path alone off Windows', () => {
  assert.deepEqual(
    claudeCliSdkOptions('/home/me/launcher.cmd', { forceWindows: false }),
    { pathToClaudeCodeExecutable: '/home/me/launcher.cmd' },
  );
});

test('claudeCliSdkOptions gives a Windows .cmd or .bat launcher its own spawner', () => {
  for (const override of ['C:\\tools\\work.cmd', 'C:\\tools\\work.BAT', '"C:\\Program Files\\work.cmd"']) {
    const options = claudeCliSdkOptions(override, { forceWindows: true });
    assert.equal(options.pathToClaudeCodeExecutable, override);
    assert.equal(typeof options.spawnClaudeCodeProcess, 'function');
  }
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
  }

  finish(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

function makeSpawner(overrides = {}) {
  const child = new FakeChild();
  const calls = [];
  const kills = [];
  const spawner = createBatchLauncherSpawner({
    forceWindows: true,
    spawnFn: (file, args, options) => {
      calls.push({ file, args, options });
      return child;
    },
    killTree: (target) => kills.push(target),
    stderrGraceMs: 20,
    ...overrides,
  });
  return { child, calls, kills, spawner };
}

const SDK_SPAWN = {
  command: 'C:\\Users\\me\\work launcher.cmd',
  args: ['--output-format', 'stream-json', '--settings', '{"env":{"A":"1"}}'],
  cwd: 'C:\\project',
  env: { PATH: 'C:\\Windows' },
};

test('the batch launcher is started through cmd.exe with piped stdio', () => {
  const { calls, spawner } = makeSpawner();
  spawner(SDK_SPAWN);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(calls[0].file, /cmd(\.exe)?$/i);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, 'C:\\project');
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(calls[0].args[3].includes('"C:\\Users\\me\\work launcher.cmd"'));
});

test('the spawned process exposes the child streams to the SDK', () => {
  const { child, spawner } = makeSpawner();
  const spawned = spawner(SDK_SPAWN);
  assert.equal(spawned.stdin, child.stdin);
  assert.equal(spawned.stdout, child.stdout);
  assert.equal(spawned.killed, false);
  assert.equal(spawned.exitCode, null);
});

test('launcher stderr reaches the stderr option', async () => {
  const lines = [];
  const { child, spawner } = makeSpawner({ stderr: (text) => lines.push(text) });
  spawner(SDK_SPAWN);
  child.stderr.write('launcher said hello\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines, ['launcher said hello\n']);
});

test('the exit event waits for the end of stderr so no output is lost', async () => {
  const lines = [];
  const events = [];
  const { child, spawner } = makeSpawner({ stderr: (text) => lines.push(text) });
  const spawned = spawner(SDK_SPAWN);
  spawned.on('exit', (code) => events.push({ code, lines: [...lines] }));
  child.finish(1);
  assert.deepEqual(events, []);
  child.stderr.write('late failure\n');
  child.stderr.end();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(events, [{ code: 1, lines: ['late failure\n'] }]);
});

test('the exit event is delivered after the grace period when stderr never closes', async () => {
  const events = [];
  const { child, spawner } = makeSpawner();
  const spawned = spawner(SDK_SPAWN);
  spawned.on('exit', (code) => events.push(code));
  child.finish(7);
  assert.deepEqual(events, []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(events, [7]);
});

test('a spawn error is passed on to the SDK', () => {
  const { child, spawner } = makeSpawner();
  const spawned = spawner(SDK_SPAWN);
  const errors = [];
  spawned.on('error', (error) => errors.push(error.code));
  child.emit('error', Object.assign(new Error('boom'), { code: 'ENOENT' }));
  assert.deepEqual(errors, ['ENOENT']);
});

test('aborting kills the whole launcher process tree once', () => {
  const controller = new AbortController();
  const { child, kills, spawner } = makeSpawner();
  const spawned = spawner({ ...SDK_SPAWN, signal: controller.signal });
  assert.deepEqual(kills, []);
  controller.abort();
  assert.deepEqual(kills, [child]);
  assert.equal(spawned.killed, true);
  spawned.kill('SIGKILL');
  assert.deepEqual(kills, [child]);
});

test('an already aborted signal kills the launcher right away', () => {
  const controller = new AbortController();
  controller.abort();
  const { child, kills, spawner } = makeSpawner();
  spawner({ ...SDK_SPAWN, signal: controller.signal });
  assert.deepEqual(kills, [child]);
});

test('kill() takes the process tree, not just cmd.exe', () => {
  const { child, kills, spawner } = makeSpawner();
  const spawned = spawner(SDK_SPAWN);
  assert.equal(spawned.kill('SIGTERM'), true);
  assert.deepEqual(kills, [child]);
  assert.equal(spawned.killed, true);
});

const onWindows = process.platform === 'win32';

test('a real .cmd launcher runs with the SDK arguments intact', { skip: !onWindows }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude launcher (test) '));
  try {
    writeFileSync(join(dir, 'echo.js'), [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));',
      "  process.stderr.write('launcher stderr');",
      '  process.exit(3);',
      '});',
    ].join('\n'));
    const launcher = join(dir, 'work launcher.cmd');
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    const args = ['--settings', '{"env":{"A":"1","B":"x y"}}', 'two words', '--resume=abc'];

    const stderrText = [];
    const spawner = createBatchLauncherSpawner({ stderr: (text) => stderrText.push(text) });
    const spawned = spawner({ command: launcher, args, cwd: dir, env: process.env });
    let stdout = '';
    spawned.stdout.on('data', (chunk) => { stdout += chunk; });
    const exit = new Promise((resolve) => spawned.on('exit', (code) => resolve(code)));
    spawned.stdin.end('{"type":"user"}\n');

    assert.equal(await exit, 3);
    assert.deepEqual(JSON.parse(stdout), { argv: args, input: '{"type":"user"}\n' });
    assert.equal(stderrText.join(''), 'launcher stderr');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
