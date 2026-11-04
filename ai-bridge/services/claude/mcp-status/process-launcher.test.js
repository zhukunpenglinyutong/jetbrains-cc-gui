import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findWindowsCommand, prepareStdioLaunch, resolveWindowsCommand } from './process-launcher.js';
import { getStdioServerTools } from './stdio-tools-getter.js';
import { verifyStdioServerStatus } from './stdio-verifier.js';

test('finds the first PATH executable in PATHEXT order', async () => {
  const listings = {
    'C:\\Users\\张三\\bin': ['uvx', 'UVX.CMD', 'uvx.exe'],
    'D:\\later': ['uvx.exe', 'codegraph.cmd']
  };
  const list = async directory => listings[directory] ?? [];
  // Mixed-case key, a quoted entry and a relative entry, as Windows allows.
  const env = { Path: '"C:\\Users\\张三\\bin";relative;D:\\later', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(await findWindowsCommand('uvx', env, list), 'C:\\Users\\张三\\bin\\uvx.exe');
  assert.equal(await findWindowsCommand('CodeGraph', env, list), 'D:\\later\\codegraph.cmd');
  assert.equal(await findWindowsCommand('missing', env, list), null);
  assert.equal(await findWindowsCommand('bin\\uvx', env, async () => ['uvx.exe']), null);
});

test('lists real PATH directories and ignores folders named like executables', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ccg path lookup '));
  try {
    await writeFile(path.join(directory, 'Fixture.CMD'), '');
    await mkdir(path.join(directory, 'trap.exe'));
    assert.equal(await findWindowsCommand('fixture', { PATH: directory }), path.win32.join(directory, 'Fixture.CMD'));
    assert.equal(await findWindowsCommand('trap', { PATH: directory }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stops walking PATH once the lookup times out', async () => {
  const listed = [];
  const slow = directory => {
    listed.push(directory);
    return new Promise(resolve => setTimeout(resolve, 30, []));
  };
  assert.equal(await findWindowsCommand('npx', { PATH: 'C:\\offline;C:\\next' }, slow, 10), null);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(listed, ['C:\\offline']);
});

test('keeps the configured command when PATH has no executable', async () => {
  const none = async () => null;
  assert.deepEqual(await resolveWindowsCommand('npx', {}, 'win32', none), { command: 'npx', useShell: true });
  assert.deepEqual(await resolveWindowsCommand('mytool', {}, 'win32', none), { command: 'mytool', useShell: false });
});

test('keeps trailing backslashes literal inside quoted batch arguments', () => {
  const launch = prepareStdioLaunch({ command: 'tool.cmd', useShell: true }, ['C:\\data\\', 'C:\\a\\\\', 'a\\b']);
  assert.deepEqual(launch.args, ['"C:\\data\\\\"', '"C:\\a\\\\\\\\"', '"a\\b"']);
});

test('names the refused character without echoing the argument', () => {
  assert.throws(
    () => prepareStdioLaunch({ command: 'npx', useShell: true }, ['postgresql://u:p%40ss@db']),
    error => /unsafe shell metacharacter "%".*env/.test(error.message) && !error.message.includes('p%40ss')
  );
});

test('rejects shell expansion in resolved paths and arguments', () => {
  for (const value of ['%PATH%', '!PATH!', 'a"b', 'a^b', 'a&b', 'a\nb']) {
    assert.throws(() => prepareStdioLaunch({ command: value, useShell: true }, []), /unsafe shell/);
    assert.throws(() => prepareStdioLaunch({ command: 'tool.cmd', useShell: true }, [value]), /unsafe shell/);
  }
  assert.deepEqual(prepareStdioLaunch({ command: 'node.exe', useShell: false }, ['a&b']), {
    command: 'node.exe', useShell: false, args: ['a&b']
  });
});

test('launches resolved and explicit Windows shims in paths containing spaces', {
  skip: process.platform !== 'win32'
}, async () => {
  // Non-ASCII characters cover PATH lookup outside the console code page.
  const root = await mkdtemp(path.join(os.tmpdir(), 'ccg mcp 中文 shim '));
  const shim = path.join(root, 'fixture-mcp.cmd');
  const script = path.join(root, 'fixture.mjs');
  // %~dp0 keeps the batch file ASCII; cmd.exe reads batch files in the OEM code page.
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`, 'utf8');
  await writeFile(script, `
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
    protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'shim', version: '1' }
  } }));
  if (request.id === 2) console.log(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {
    tools: [{ name: 'args', description: JSON.stringify(process.argv.slice(2)), inputSchema: { type: 'object' } }]
  } }));
});
`, 'utf8');
  try {
    const args = ['value with spaces', 'C:\\Program Files (x86)\\fixture', '', 'C:\\trailing\\'];
    for (const command of ['fixture-mcp', shim]) {
      // Run from another directory so the bare name can only come from PATH.
      const config = { command, args, cwd: os.tmpdir(), env: { PATH: `${root}${path.delimiter}${process.env.PATH}` } };
      const tools = await getStdioServerTools('space-shim', config);
      assert.equal(tools.error, null);
      assert.deepEqual(JSON.parse(tools.tools[0].description), args);
      const status = await verifyStdioServerStatus('space-shim', config);
      assert.equal(status.status, 'connected');
    }
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('ccg mcp 中文 shim '));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
