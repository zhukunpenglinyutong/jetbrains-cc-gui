import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import {
  decodeCliOutput,
  isWindowsCmdShim,
  quoteCmdArg,
  resolveCliSpawn,
  selectWindowsWhereMatch,
  resolveWindowsSpawnableBin,
  resolveOmpCliPath,
  resolveCliPath,
  resolveGeminiCliPath,
  verifyAgyBinary,
  parseSemver,
  compareSemver,
  AGY_MIN_VERSION,
  commonCliBinDirs,
  versionManagerBinDirs,
  whichViaLoginShell,
} from './cli-path.js';

const REAL_AGY_HELP = [
  'Usage: agy [options] [command]',
  'Options:',
  '  --conversation <id>   Continue an existing conversation',
  '  --effort <level>      Set the reasoning effort',
  '  --sandbox             Run commands inside the sandbox',
  'Commands:',
  '  models                List available models',
  '',
].join('\n');

// Near-miss flags sharing substrings with the required ones - a substring
// match would pass, a word-boundary match must reject all of them.
const LOOKALIKE_HELP = [
  'Usage: gemini [options]',
  '  --conversation-mode   Shared conversation context',
  '  --effort-max          Maximum effort preset',
  '  --sandbox-mode        Select sandbox mode',
  '  --show-models         Print the model table and exit',
  '',
].join('\n');

/**
 * Write an executable fake CLI (node script with a shebang) into a temp dir
 * and return its path. verifyAgyBinary then exercises a REAL child process:
 * spawnSync, shebang resolution, output decoding and exit/signal handling.
 */
async function writeFakeCli(dir, {
  version = '1.1.22',
  versionLines = [],
  versionExit = 0,
  versionStderr = '',
  helpText = REAL_AGY_HELP,
  helpExit = 0,
} = {}) {
  const script = [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    "if (args.includes('--version')) {",
    ...versionLines.map((line) => `  console.log(${JSON.stringify(line)});`),
    ...(version ? [`  console.log(${JSON.stringify(version)});`] : []),
    ...(versionStderr ? [`  console.error(${JSON.stringify(versionStderr)});`] : []),
    `  process.exit(${versionExit});`,
    '}',
    "if (args.includes('--help')) {",
    `  console.log(${JSON.stringify(helpText)});`,
    `  process.exit(${helpExit});`,
    '}',
    'process.exit(1);',
    '',
  ].join('\n');
  const bin = join(dir, 'agy');
  await writeFile(bin, script, 'utf8');
  await chmod(bin, 0o755);
  if (process.platform === 'win32') {
    // A shebang script without an extension cannot be executed on Windows;
    // hand verifyAgyBinary the .cmd shim instead (same idiom as
    // services/gemini/message-service.test.js), which its resolveCliSpawn
    // discipline runs through cmd.exe.
    const cmd = join(dir, 'agy.cmd');
    await writeFile(cmd, `@echo off\r\nnode "${bin}" %*\r\n`, 'utf8');
    return cmd;
  }
  return bin;
}

async function withFakeCliDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-verify-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('isWindowsCmdShim detects .cmd/.bat only on win32-style paths', () => {
  // Function gates on process.platform; we only assert the regex half via
  // known Windows-like paths when running on Windows, and always assert
  // non-matching extensions return false on any platform.
  assert.equal(isWindowsCmdShim('opencode.exe'), false);
  assert.equal(isWindowsCmdShim('pi'), false);
  assert.equal(isWindowsCmdShim('C:\\Users\\a\\AppData\\Roaming\\npm\\pi'), false);
  if (process.platform === 'win32') {
    assert.equal(isWindowsCmdShim('C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd'), true);
    assert.equal(isWindowsCmdShim('opencode.bat'), true);
  } else {
    // Non-Windows: always false even for .cmd paths
    assert.equal(isWindowsCmdShim('C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd'), false);
  }
});

test('selectWindowsWhereMatch prefers .cmd over extensionless npm shim', () => {
  const chosen = selectWindowsWhereMatch([
    'C:\\Users\\83429\\AppData\\Roaming\\npm\\pi',
    'C:\\Users\\83429\\AppData\\Roaming\\npm\\pi.cmd',
  ]);
  assert.equal(chosen, 'C:\\Users\\83429\\AppData\\Roaming\\npm\\pi.cmd');
});

test('selectWindowsWhereMatch prefers .exe when present', () => {
  const chosen = selectWindowsWhereMatch([
    'D:\\develop\\node-v24.13.1-win-x64\\opencode',
    'D:\\develop\\node-v24.13.1-win-x64\\opencode.exe',
  ]);
  assert.equal(chosen, 'D:\\develop\\node-v24.13.1-win-x64\\opencode.exe');
});

test('selectWindowsWhereMatch prefers .cmd over .ps1-only noise and keeps first good match', () => {
  const chosen = selectWindowsWhereMatch([
    'D:\\software\\nvm4w\\nodejs\\opencode',
    'D:\\software\\nvm4w\\nodejs\\opencode.ps1',
    'D:\\software\\nvm4w\\nodejs\\opencode.cmd',
  ]);
  assert.equal(chosen, 'D:\\software\\nvm4w\\nodejs\\opencode.cmd');
});

test('selectWindowsWhereMatch falls back to first line when no spawnable extension', () => {
  const chosen = selectWindowsWhereMatch([
    'C:\\tools\\pi',
    'C:\\other\\pi',
  ]);
  assert.equal(chosen, 'C:\\tools\\pi');
});

test('selectWindowsWhereMatch ignores blanks', () => {
  assert.equal(selectWindowsWhereMatch(['', '  ', 'C:\\x\\pi.cmd']), 'C:\\x\\pi.cmd');
  assert.equal(selectWindowsWhereMatch([]), null);
  assert.equal(selectWindowsWhereMatch(null), null);
});

test('resolveWindowsSpawnableBin upgrades extensionless path when sibling .cmd exists', () => {
  const exists = (p) => p === 'C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd';
  const resolved = resolveWindowsSpawnableBin(
    'C:\\Users\\a\\AppData\\Roaming\\npm\\pi',
    exists,
    true, // force Windows behavior for cross-platform unit tests
  );
  assert.equal(resolved, 'C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd');
});

test('resolveWindowsSpawnableBin prefers .exe over .cmd when both exist', () => {
  const exists = (p) =>
    p === 'D:\\node\\opencode.cmd' || p === 'D:\\node\\opencode.exe';
  const resolved = resolveWindowsSpawnableBin('D:\\node\\opencode', exists, true);
  assert.equal(resolved, 'D:\\node\\opencode.exe');
});

test('resolveWindowsSpawnableBin leaves .cmd paths unchanged', () => {
  const resolved = resolveWindowsSpawnableBin(
    'C:\\npm\\pi.cmd',
    () => false,
    true,
  );
  assert.equal(resolved, 'C:\\npm\\pi.cmd');
});

test('resolveWindowsSpawnableBin leaves bare names unchanged', () => {
  // Bare names rely on PATHEXT at spawn time; do not invent a path.
  const resolved = resolveWindowsSpawnableBin('pi', () => true, true);
  assert.equal(resolved, 'pi');
});

test('resolveWindowsSpawnableBin no-ops when forceWindows is false', () => {
  const exists = (p) => p === '/home/u/.local/bin/pi.cmd';
  const resolved = resolveWindowsSpawnableBin('/home/u/.local/bin/pi', exists, false);
  assert.equal(resolved, '/home/u/.local/bin/pi');
});

test('resolveWindowsSpawnableBin handles paths with spaces', () => {
  const base = 'C:\\Program Files\\nodejs\\opencode';
  const exists = (p) => p === `${base}.cmd`;
  const resolved = resolveWindowsSpawnableBin(base, exists, true);
  assert.equal(resolved, `${base}.cmd`);
});

test('resolveOmpCliPath honors OMP_BIN env override', () => {
  const saved = {
    OMP_BIN: process.env.OMP_BIN,
    OMP_PATH: process.env.OMP_PATH,
    OMP_CLI_PATH: process.env.OMP_CLI_PATH,
  };
  try {
    process.env.OMP_BIN = '/tmp/custom-omp/bin/omp';
    delete process.env.OMP_PATH;
    delete process.env.OMP_CLI_PATH;
    assert.equal(resolveOmpCliPath(), '/tmp/custom-omp/bin/omp');

    process.env.OMP_BIN = '';
    process.env.OMP_PATH = '/tmp/alt-omp/bin/omp';
    assert.equal(resolveOmpCliPath(), '/tmp/alt-omp/bin/omp');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('resolveCliPath expands {localAppData} candidates (OMP Windows installer layout)', () => {
  // Fake a Windows native-installer layout: %LOCALAPPDATA%\omp\<binary>.
  // A never-on-PATH binary name keeps which/login-shell lookups from short-circuiting.
  const root = mkdtempSync(join(tmpdir(), 'ccgui-localappdata-'));
  const binDir = join(root, 'omp');
  mkdirSync(binDir, { recursive: true });
  const name = 'ccgui-test-cli-9f8e7d';
  for (const ext of process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : ['']) {
    writeFileSync(join(binDir, name + ext), '');
  }
  const saved = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = root;
    const resolved = resolveCliPath({
      binaryName: name,
      envKeys: [],
      homeCandidates: ['{localAppData}/omp/{bin}'],
    });
    assert.equal(dirname(normalize(resolved)), binDir);
  } finally {
    if (saved === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = saved;
    }
  }
});

test('versionManagerBinDirs scans nvm/fnm roots newest-first and lists static managers', () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'cc-gui-vm-home-'));
  mkdirSync(join(home, '.nvm', 'versions', 'node', 'v22.22.3', 'bin'), { recursive: true });
  mkdirSync(join(home, '.nvm', 'versions', 'node', 'v24.11.1', 'bin'), { recursive: true });
  mkdirSync(join(home, '.nvm', 'versions', 'node', 'v9.11.2', 'bin'), { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'fnm', 'node-versions', 'v20.1.0', 'installation', 'bin'), { recursive: true });
  const dirs = versionManagerBinDirs(home);
  // Static single-node managers are always listed.
  assert.ok(dirs.includes(join(home, '.volta', 'bin')), 'expected volta bin dir');
  assert.ok(dirs.includes(join(home, '.nvmd', 'bin')), 'expected nvmd bin dir');
  // Numeric (not lexicographic) descending order: v24 > v22 > v9.
  const nvmDirs = dirs.filter((dir) => dir.includes(join('.nvm', 'versions', 'node')));
  assert.deepEqual(nvmDirs, [
    join(home, '.nvm', 'versions', 'node', 'v24.11.1', 'bin'),
    join(home, '.nvm', 'versions', 'node', 'v22.22.3', 'bin'),
    join(home, '.nvm', 'versions', 'node', 'v9.11.2', 'bin'),
  ]);
  assert.ok(
    dirs.includes(join(home, '.local', 'share', 'fnm', 'node-versions', 'v20.1.0', 'installation', 'bin')),
    'expected fnm installation bin dir',
  );
});

test('resolveCliPath finds a CLI shim installed under an nvm version dir', () => {
  if (process.platform === 'win32') return;
  const fakeHome = mkdtempSync(join(tmpdir(), 'cc-gui-nvm-home-'));
  const binDir = join(fakeHome, '.nvm', 'versions', 'node', 'v22.22.3', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'cc-gui-fake-cli'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  // resolveCliPath reads os.homedir(), which honors $HOME on POSIX.
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const resolved = resolveCliPath({ binaryName: 'cc-gui-fake-cli', envKeys: [], homeCandidates: [] });
    assert.equal(resolved, join(binDir, 'cc-gui-fake-cli'));
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
  }
});

test('commonCliBinDirs includes the OMP bin dir after the PI entry', () => {
  const dirs = commonCliBinDirs('/home/tester');
  const piIndex = dirs.indexOf(join('/home/tester', '.pi', 'bin'));
  const ompIndex = dirs.indexOf(join('/home/tester', '.omp', 'bin'));
  assert.ok(piIndex !== -1, 'expected .pi/bin entry');
  assert.ok(ompIndex !== -1, 'expected .omp/bin entry');
  assert.equal(ompIndex, piIndex + 1);
});

test('quoteCmdArg wraps and escapes cmd metacharacters', () => {
  assert.equal(quoteCmdArg('models'), '"models"');
  assert.equal(quoteCmdArg('C:\\Program Files\\nodejs\\opencode.cmd'), '"C:\\Program Files\\nodejs\\opencode.cmd"');
  assert.equal(quoteCmdArg('say "hi"'), '"say ""hi"""');
  assert.equal(quoteCmdArg('%PATH%'), '"%%PATH%%"');
});

test('decodeCliOutput keeps valid UTF-8 and recovers GBK stderr', () => {
  assert.equal(decodeCliOutput('opencode/big-pickle'), 'opencode/big-pickle');
  assert.equal(decodeCliOutput(Buffer.from('opencode/big-pickle')), 'opencode/big-pickle');
  let gbkSupported = false;
  for (const label of ['gbk', 'gb18030']) {
    try {
      // eslint-disable-next-line no-new
      new TextDecoder(label);
      gbkSupported = true;
      break;
    } catch {
      // Node without full ICU
    }
  }
  if (!gbkSupported) return;
  // GBK for 不是内部或外部命令 — the cmd.exe message after `'C:\\Program'`.
  const gbk = Buffer.from([0xB2, 0xBB, 0xCA, 0xC7, 0xC4, 0xDA, 0xB2, 0xBF, 0xBB, 0xF2, 0xCD, 0xE2, 0xB2, 0xBF, 0xC3, 0xFC, 0xC1, 0xEE]);
  const decoded = decodeCliOutput(gbk);
  assert.equal(decoded.includes('\uFFFD'), false);
  assert.match(decoded, /命令/);
});

test('resolveCliSpawn launches spaced .cmd shims via cmd basename + PATH', () => {
  const env = { PATH: 'C:\\Windows\\system32', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const invocation = resolveCliSpawn(
    'C:\\Program Files\\nodejs\\opencode.cmd',
    ['models'],
    { env },
    true,
  );
  assert.equal(invocation.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  // /s strips the outer quotes, leaving `"opencode.cmd" "models"`.
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', '""opencode.cmd" "models""']);
  assert.match(invocation.options.env.PATH, /^C:\\Program Files\\nodejs;/);
  // The command token must not contain the spaced prefix that cmd splits on.
  assert.equal(invocation.args[3].includes('C:\\Program'), false);
});

test('resolveCliSpawn strips a previously quoted .cmd path', () => {
  const invocation = resolveCliSpawn(
    '"C:\\Program Files\\nodejs\\opencode.cmd"',
    ['models'],
    { env: { PATH: 'C:\\Windows\\system32' } },
    true,
  );
  assert.equal(invocation.args[3].includes('C:\\Program'), false);
  assert.match(invocation.args[3], /opencode\.cmd/);
});

test('resolveCliSpawn leaves .exe and non-Windows targets as a direct spawn', () => {
  const exe = resolveCliSpawn(
    'C:\\Program Files\\nodejs\\opencode.exe',
    ['models'],
    { env: { PATH: 'C:\\Windows\\system32' } },
    true,
  );
  assert.equal(exe.file, 'C:\\Program Files\\nodejs\\opencode.exe');
  assert.deepEqual(exe.args, ['models']);
  assert.notEqual(exe.options.shell, true);

  const posix = resolveCliSpawn(
    'C:\\Program Files\\nodejs\\opencode.cmd',
    ['models'],
    {},
    false,
  );
  assert.equal(posix.file, 'C:\\Program Files\\nodejs\\opencode.cmd');
  assert.deepEqual(posix.args, ['models']);
});

test('resolveCliSpawn file-redirect quotes both the shim and the dest path', () => {
  const invocation = resolveCliSpawn(
    'C:\\Program Files\\nodejs\\opencode.cmd',
    ['models'],
    { env: { PATH: 'C:\\Windows\\system32' }, redirectTo: 'C:\\Users\\a\\AppData\\Local\\Temp\\models.txt' },
    true,
  );
  assert.equal(invocation.file.endsWith('cmd.exe') || invocation.file === 'cmd.exe', true);
  assert.match(invocation.args[3], /opencode\.cmd/);
  assert.match(invocation.args[3], />/);
  assert.match(invocation.args[3], /models\.txt/);
  assert.equal(invocation.args[3].includes('C:\\Program'), false);
});

test('whichViaLoginShell rejects unsafe binary names without spawning', () => {
  assert.equal(whichViaLoginShell(''), null);
  assert.equal(whichViaLoginShell('omp; rm -rf /'), null);
  assert.equal(whichViaLoginShell('../omp'), null);
  assert.equal(whichViaLoginShell('$(whoami)'), null);
});

test('whichViaLoginShell resolves a PATH binary via an allowlisted shell', (t) => {
  if (process.platform === 'win32') {
    t.skip('login-shell fallback is POSIX-only');
    return;
  }
  // `sh` is always on PATH; `command -v sh` prints its absolute path. On
  // distros where /bin symlinks to /usr/bin (e.g. Ubuntu CI runners) the
  // resolved path is /usr/bin/sh instead of /bin/sh.
  const resolved = whichViaLoginShell('sh', '/bin/sh');
  assert.ok(
    resolved === '/bin/sh' || resolved === '/usr/bin/sh',
    `expected /bin/sh or /usr/bin/sh, got ${resolved}`,
  );
});

test('whichViaLoginShell returns null for a missing binary', (t) => {
  if (process.platform === 'win32') {
    t.skip('login-shell fallback is POSIX-only');
    return;
  }
  assert.equal(whichViaLoginShell('definitely-not-a-real-cli-9f8e7d', '/bin/sh'), null);
});

test('resolveGeminiCliPath respects env override precedence', () => {
  const originalBin = process.env.GEMINI_BIN;
  const originalPath = process.env.GEMINI_PATH;
  const originalCliPath = process.env.GEMINI_CLI_PATH;

  try {
    delete process.env.GEMINI_BIN;
    delete process.env.GEMINI_PATH;
    delete process.env.GEMINI_CLI_PATH;

    process.env.GEMINI_CLI_PATH = '/custom/path/to/gemini-cli-path';
    assert.equal(resolveGeminiCliPath(), '/custom/path/to/gemini-cli-path');

    process.env.GEMINI_PATH = '/custom/path/to/gemini-path';
    assert.equal(resolveGeminiCliPath(), '/custom/path/to/gemini-path');

    process.env.GEMINI_BIN = '/custom/path/to/gemini-bin';
    assert.equal(resolveGeminiCliPath(), '/custom/path/to/gemini-bin');
  } finally {
    if (originalBin !== undefined) process.env.GEMINI_BIN = originalBin;
    else delete process.env.GEMINI_BIN;
    if (originalPath !== undefined) process.env.GEMINI_PATH = originalPath;
    else delete process.env.GEMINI_PATH;
    if (originalCliPath !== undefined) process.env.GEMINI_CLI_PATH = originalCliPath;
    else delete process.env.GEMINI_CLI_PATH;
  }
});

test('parseSemver and compareSemver handle version checks correctly', () => {
  assert.deepEqual(parseSemver('1.1.22'), {
    major: 1,
    minor: 1,
    patch: 22,
    prerelease: null,
    build: null,
    raw: '1.1.22',
  });
  assert.deepEqual(parseSemver('v1.1.11'), {
    major: 1,
    minor: 1,
    patch: 11,
    prerelease: null,
    build: null,
    raw: 'v1.1.11',
  });
  assert.equal(parseSemver('not a version'), null);
  assert.equal(parseSemver('agy version 1.1.22'), null);

  assert.equal(compareSemver('1.1.11', '1.1.11'), 0);
  assert.ok(compareSemver('1.1.22', '1.1.11') > 0);
  assert.ok(compareSemver('1.1.10', '1.1.11') < 0);
  assert.ok(compareSemver('1.2.0', '1.1.11') > 0);
  assert.ok(compareSemver('2.0.0', '1.1.11') > 0);
});

test('verifyAgyBinary returns not_found for non-existent binary', () => {
  const result = verifyAgyBinary('/non/existent/path/to/agy_binary_xyz_123');
  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'not_found');
});

test('verifyAgyBinary accepts a real agy child process', async () => {
  await withFakeCliDir(async (dir) => {
    const bin = await writeFakeCli(dir, { version: '1.1.22' });
    const result = verifyAgyBinary(bin);

    assert.equal(result.ok, true);
    assert.equal(result.available, true);
    assert.equal(result.version, '1.1.22');
    assert.equal(result.path, bin);
  });
});

test('verifyAgyBinary enforces the exact floor: 1.1.11 passes, 1.1.10 gets the upgrade hint', async () => {
  await withFakeCliDir(async (dir) => {
    const atFloor = await writeFakeCli(dir, { version: '1.1.11' });
    assert.deepEqual(
      { ok: verifyAgyBinary(atFloor).ok, version: verifyAgyBinary(atFloor).version },
      { ok: true, version: '1.1.11' },
    );

    const belowFloor = await writeFakeCli(dir, { version: '1.1.10' });
    const result = verifyAgyBinary(belowFloor);
    assert.equal(result.ok, false);
    assert.equal(result.available, false);
    assert.equal(result.reason, 'unsupported_version');
    assert.equal(result.version, '1.1.10');
    assert.match(result.error, /1\.1\.11/);
    assert.match(result.error, /agy update/);
  });
});

test('verifyAgyBinary rejects a real lookalike child with near-miss flags', async () => {
  await withFakeCliDir(async (dir) => {
    const bin = await writeFakeCli(dir, { helpText: LOOKALIKE_HELP });
    const result = verifyAgyBinary(bin);

    assert.equal(result.ok, false);
    assert.equal(result.available, false);
    assert.equal(result.reason, 'lookalike');
    assert.match(result.error, /GEMINI_BIN/);
  });
});

test('verifyAgyBinary accepts the version printed alongside an update notice', async () => {
  await withFakeCliDir(async (dir) => {
    const bin = await writeFakeCli(dir, {
      versionLines: ['A new version of agy is available. Run `agy update` to upgrade.'],
      version: '1.1.22',
    });
    const result = verifyAgyBinary(bin);

    assert.equal(result.ok, true);
    assert.equal(result.version, '1.1.22');
  });
});

test('verifyAgyBinary reports a crashing --version child as spawn_failed, not lookalike', async () => {
  await withFakeCliDir(async (dir) => {
    const bin = await writeFakeCli(dir, {
      version: null,
      versionExit: 127,
      versionStderr: 'dyld[12345]: Library not loaded: /usr/lib/libbroken.dylib',
    });
    const result = verifyAgyBinary(bin);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'spawn_failed');
    assert.match(result.error, /127/);
    assert.match(result.error, /dyld/);
  });
});

test('verifyAgyBinary routes Windows .cmd shims through cmd.exe (forceWindows)', () => {
  const captures = [];
  const result = verifyAgyBinary('C:\\Users\\dev\\AppData\\Roaming\\npm\\agy.cmd', {
    forceWindows: true,
    spawnSyncFn: (file, args, options) => {
      captures.push({ file, args, options });
      // In the cmd.exe route the args collapse into one command string, so
      // detect the probe flag from the joined invocation.
      const command = args.join(' ');
      if (command.includes('--version')) return { status: 0, stdout: '1.1.22\n', stderr: '', error: null };
      return { status: 0, stdout: REAL_AGY_HELP, stderr: '', error: null };
    },
  });

  // Both probes go through resolveCliSpawn's cmd.exe route: cmd /d /s /c with
  // the shim invoked by basename (CVE-2024-27980 EINVAL workaround).
  assert.equal(captures.length, 2);
  assert.match(captures[0].file, /cmd\.exe$/i);
  assert.deepEqual(captures[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(captures[0].args[3], /"agy\.cmd" "--version"/);
  assert.match(captures[1].args[3], /"agy\.cmd" "--help"/);
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.1.22');
});

test('verifyAgyBinary fails on lookalike binary with unexpected version banner', () => {
  const result = verifyAgyBinary(process.execPath, {
    spawnSyncFn: (file, args) => {
      const flag = args[0];
      if (flag === '--version') {
        return { status: 0, stdout: 'Google Gemini CLI v0.5.0 (Experimental)\n', stderr: '', error: null };
      }
      return { status: 0, stdout: 'models', stderr: '', error: null };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'lookalike');
  assert.match(result.error, /GEMINI_BIN/);
});

test('compareSemver handles prerelease versions and invalid inputs correctly', () => {
  assert.ok(compareSemver('1.1.11-alpha.1', '1.1.11-beta.1') < 0);
  assert.ok(compareSemver('1.1.11-beta.1', '1.1.11-alpha.1') > 0);
  assert.equal(compareSemver('1.1.11-alpha.1', '1.1.11-alpha.1'), 0);
  assert.equal(compareSemver({}, {}), 0);
});

test('verifyAgyBinary handles null options and timeouts', () => {
  const notFound = verifyAgyBinary('/non/existent/path/for/null_options', null);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, 'not_found');

  const timeoutResult = verifyAgyBinary(process.execPath, {
    spawnSyncFn: () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: { code: 'ETIMEDOUT', message: 'timed out' },
    }),
  });
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.reason, 'timeout');
  assert.match(timeoutResult.error, /timed out/i);
});

test('verifyAgyBinary fails on lookalike binary missing distinctive flags in --help', () => {
  const result = verifyAgyBinary(process.execPath, {
    spawnSyncFn: (file, args) => {
      const flag = args[0];
      if (flag === '--version') {
        return { status: 0, stdout: '1.1.22\n', stderr: '', error: null };
      }
      if (flag === '--help') {
        // Missing --sandbox and models
        return { status: 0, stdout: 'Usage: gemini --conversation <id> --effort <lvl>', stderr: '', error: null };
      }
      return { status: 1, stdout: '', stderr: '', error: null };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'lookalike');
  assert.match(result.error, /GEMINI_BIN/);
});
