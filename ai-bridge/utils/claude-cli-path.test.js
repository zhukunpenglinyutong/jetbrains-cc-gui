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
  adaptCmdInvocation,
} from './claude-cli-path.js';
import { resolveCliSpawn } from './cli-path.js';

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

function cmdInvocation(args, cwd) {
  return adaptCmdInvocation(
    resolveCliSpawn('C:\\tools\\work.cmd', args, { cwd, env: { PATH: 'C:\\Windows' } }, true),
    { command: 'C:\\tools\\work.cmd', args, cwd },
  );
}

test('an argument with a percent sign is passed through the environment, not the command line', () => {
  const invocation = cmdInvocation(['--mcp', 'http://x/a%3Db', 'plain']);
  const line = invocation.args[3];
  assert.equal(invocation.options.env.CLAUDE_GUI_ARG_0, 'http://x/a%3Db');
  assert.ok(line.includes('"%CLAUDE_GUI_ARG_0%"'));
  assert.ok(line.includes('"plain"'));
  assert.ok(!line.includes('%3D'));
});

test('a double quote inside a percent argument is doubled for cmd', () => {
  const invocation = cmdInvocation(['{"u":"100%"}']);
  assert.equal(invocation.options.env.CLAUDE_GUI_ARG_0, '{""u"":""100%""}');
});

test('arguments without a percent sign leave the command line as it was', () => {
  const args = ['--settings', '{"env":{"A":"1"}}'];
  const before = resolveCliSpawn('C:\\tools\\work.cmd', args, { env: { PATH: 'C:\\Windows' } }, true);
  const after = adaptCmdInvocation(before, { args });
  assert.deepEqual(after.args, before.args);
  assert.equal(after.options.cwd, before.options.cwd);
  assert.equal('CLAUDE_GUI_ARG_0' in after.options.env, false);
});

test('a batch launcher is refused in a UNC working directory with an explanation', () => {
  const unc = '\\\\wsl.localhost\\Ubuntu\\home\\me\\project';
  assert.throws(
    () => cmdInvocation(['--resume=abc'], unc),
    (error) => error.message.includes('"C:\\tools\\work.cmd"')
      && error.message.includes(unc)
      && error.message.includes('.exe')
      && error.message.includes('.js/.mjs'),
  );
});

test('the spawner starts nothing for a batch launcher in a UNC working directory', () => {
  const { calls, spawner } = makeSpawner();
  assert.throws(() => spawner({ ...SDK_SPAWN, cwd: '\\\\srv\\share\\project' }), /network folder/);
  assert.equal(calls.length, 0);
});

test('a local working directory stays the process directory', () => {
  const invocation = cmdInvocation(['--resume=abc'], 'C:\\project');
  assert.equal(invocation.options.cwd, 'C:\\project');
  assert.equal(invocation.args[3].includes('pushd'), false);
});

test('an invocation that does not go through cmd.exe is returned as it is', () => {
  const direct = resolveCliSpawn('C:\\tools\\claude.exe', ['a%b'], { cwd: '\\\\srv\\share' }, true);
  assert.equal(adaptCmdInvocation(direct, { args: ['a%b'], cwd: '\\\\srv\\share' }), direct);
});

const onWindows = process.platform === 'win32';

test('a real .cmd launcher receives percent signs and quotes exactly as given', { skip: !onWindows }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude launcher percent '));
  try {
    writeFileSync(join(dir, 'echo.js'), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const launcher = join(dir, 'work.cmd');
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    const args = ['--mcp', 'http://x/a%3Db', '100%', '%PATH%', 'q"uote %x', '{"u":"a%40b"}'];

    const spawned = createBatchLauncherSpawner()({ command: launcher, args, cwd: dir, env: process.env });
    let stdout = '';
    spawned.stdout.on('data', (chunk) => { stdout += chunk; });
    const exit = new Promise((resolve) => spawned.on('exit', resolve));
    spawned.stdin.end();
    await exit;
    assert.deepEqual(JSON.parse(stdout), args);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
