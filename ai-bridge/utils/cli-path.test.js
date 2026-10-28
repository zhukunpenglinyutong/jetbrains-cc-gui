import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import {
  decodeCliOutput,
  isWindowsCmdShim,
  isDeadCmdShim,
  quoteCmdArg,
  resolveCliSpawn,
  selectWindowsWhereMatch,
  resolveWindowsSpawnableBin,
  resolveOmpCliPath,
  resolveCliPath,
  commonCliBinDirs,
  versionManagerBinDirs,
  whichViaLoginShell,
  enrichPathWithBinDirs,
  buildCliSpawnEnv,
} from './cli-path.js';

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

test('resolveCliSpawn launches spaced .cmd shims via cmd with the quoted full path', () => {
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
  // /s strips the outer quotes, leaving the shim's quoted full path as one
  // command token — required so %~dp0 inside the shim resolves to the
  // script's own directory, not the child's CWD.
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\opencode.cmd" "models""']);
  assert.match(invocation.options.env.PATH, /^C:\\Program Files\\nodejs;/);
});

test('resolveCliSpawn strips a previously quoted .cmd path', () => {
  const invocation = resolveCliSpawn(
    '"C:\\Program Files\\nodejs\\opencode.cmd"',
    ['models'],
    { env: { PATH: 'C:\\Windows\\system32' } },
    true,
  );
  assert.equal(invocation.args[3], '""C:\\Program Files\\nodejs\\opencode.cmd" "models""');
  assert.match(invocation.args[3], /opencode\.cmd/);
});

test('resolveCliSpawn lets a %~dp0-based shim read its own directory (regression)', async () => {
  // Regression for the MiniMax mcode failure: a shim resolved through
  // MINIMAX_BIN reads sibling files via %~dp0. Invoking it by bare name
  // through a PATH lookup made %~dp0 expand to the child's CWD, so the run
  // died with cmd's localized "file not found" and exit 1. The quoted
  // full-path invocation must give the shim its real directory.
  if (process.platform !== 'win32') return;
  const { spawn } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'cc-gui-dp0-spawn-'));
  mkdirSync(join(root, 'inner dir'), { recursive: true });
  const marker = 'sibling-present';
  writeFileSync(join(root, 'inner dir', 'release'), marker);
  const shim = join(root, 'inner dir', 'mcode.cmd');
  writeFileSync(shim, '@echo off\r\nset /p REL=<"%~dp0release"\r\n echo %REL%\r\n');

  const invocation = resolveCliSpawn(shim, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(invocation.file, invocation.args, invocation.options);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve(`${out} [exit=${code}]`));
  });
  assert.match(stdout, new RegExp(marker));
  assert.match(stdout, /exit=0/);
});

test('resolveCliSpawn leaves .exe and non-Windows targets as a direct spawn', () => {  const exe = resolveCliSpawn(
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
  // Full quoted shim path (spaces included) as the command token.
  assert.equal(invocation.args[3].startsWith('""C:\\Program Files\\nodejs\\opencode.cmd"'), true);
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

test('enrichPathWithBinDirs prepends binDirs as an ordered block (no reversal)', () => {
  const sep = process.platform === 'win32' ? ';' : ':';
  const env = { PATH: '/base/bin' };
  enrichPathWithBinDirs(env, ['/newest/bin', '/older/bin', '/oldest/bin']);
  const parts = env.PATH.split(sep);
  // Priority order survives: newest first, oldest last, base PATH appended.
  assert.deepEqual(parts, ['/newest/bin', '/older/bin', '/oldest/bin', '/base/bin']);
});

test('enrichPathWithBinDirs skips duplicates already on PATH', () => {
  const sep = process.platform === 'win32' ? ';' : ':';
  const env = { PATH: ['', '/a/bin'].join(sep) };
  enrichPathWithBinDirs(env, ['/a/bin', '/b/bin', '/b/bin']);
  const parts = env.PATH.split(sep).filter(Boolean);
  assert.deepEqual(parts, ['/b/bin', '/a/bin']);
});

test('buildCliSpawnEnv leads PATH with the resolved binary own dir', () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'cc-gui-spawn-env-'));
  const env = buildCliSpawnEnv(join(home, '.hermes', 'node', 'bin', 'pi'), home, { PATH: '/usr/bin' });
  const parts = env.PATH.split(':');
  assert.equal(parts[0], join(home, '.hermes', 'node', 'bin'));
  // Bare binary names (PATH lookup fallback) add no dir.
  const bare = buildCliSpawnEnv('pi', home, { PATH: '/usr/bin' });
  assert.notEqual(bare.PATH.split(':')[0], 'pi');
  assert.ok(bare.PATH.split(':').pop() === '/usr/bin');
});

test('isDeadCmdShim flags a shim whose last quoted target is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-gui-dead-shim-'));
  // Mirrors the real stale-install shape: an earlier `set "VAR=path"` line,
  // then a delegation to a target that no longer exists.
  const dead = join(root, 'minimax.cmd');
  writeFileSync(dead, '@echo off\r\nset "MINIMAX_DATA_DIR=X:\\data"\r\n"X:\\npm-global\\mcode.cmd" %*\r\n');
  assert.equal(isDeadCmdShim(dead, { forceWindows: true }), true);
});

test('isDeadCmdShim keeps a shim whose last quoted target exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-gui-alive-shim-'));
  // Runtime-joined absolute path: matches the drive-letter regex on win32 and
  // exists there; on POSIX the regex never matches, so the shim is alive too.
  const target = join(root, 'mcode.cmd');
  writeFileSync(target, '@echo off\r\n');
  const alive = join(root, 'minimax.cmd');
  writeFileSync(alive, `@echo off\r\n"${target}" %*\r\n`);
  assert.equal(isDeadCmdShim(alive, { forceWindows: true }), false);
});

test('isDeadCmdShim cannot-verify cases stay alive', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-gui-unverif-shim-'));
  // Unresolved %VAR% in the target: statically unknowable.
  const withVar = join(root, 'mgr.cmd');
  writeFileSync(withVar, '@echo off\r\n"%~dp0releases\\%MCODE_RELEASE%\\.mcode-launcher.cmd" %*\r\n');
  assert.equal(isDeadCmdShim(withVar, { forceWindows: true }), false);
  // No quoted absolute target at all.
  const plain = join(root, 'plain.cmd');
  writeFileSync(plain, '@echo off\r\nnode server.js\r\n');
  assert.equal(isDeadCmdShim(plain, { forceWindows: true }), false);
  // Missing file and non-shim extensions.
  assert.equal(isDeadCmdShim(join(root, 'missing.cmd'), { forceWindows: true }), false);
  assert.equal(isDeadCmdShim(join(root, 'minimax.exe'), { forceWindows: true }), false);
  // %~dp0-relative target that is genuinely missing (win32 semantics).
  const dp0Dead = join(root, 'dp0-dead.cmd');
  writeFileSync(dp0Dead, '@echo off\r\n"%~dp0gone\\target.cmd" %*\r\n');
  assert.equal(isDeadCmdShim(dp0Dead, { forceWindows: true }), process.platform === 'win32' ? true : false);
});

test('isDeadCmdShim honors %~dp0 targets that exist next to the shim', () => {
  if (process.platform !== 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'cc-gui-dp0-alive-'));
  mkdirSync(join(root, 'releases'), { recursive: true });
  writeFileSync(join(root, 'releases', 'mcode.cmd'), '@echo off\r\n');
  const shim = join(root, 'minimax.cmd');
  writeFileSync(shim, '@echo off\r\n"%~dp0releases\\mcode.cmd" %*\r\n');
  assert.equal(isDeadCmdShim(shim), false);
});

test('resolveCliPath skips a dead home shim and falls through to the next candidate', () => {
  // Windows-only: only there can a .cmd candidate be recognized as a dead shim.
  if (process.platform !== 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'cc-gui-skip-dead-'));
  const staleDir = join(root, 'stale');
  const freshDir = join(root, 'fresh');
  mkdirSync(staleDir, { recursive: true });
  mkdirSync(freshDir, { recursive: true });
  const name = 'ccgui-deadtest-cli-3fb1';
  // Stale shim delegates to a removed install.
  writeFileSync(join(staleDir, `${name}.cmd`), '@echo off\r\n"X:\\removed-install\\cli.cmd" %*\r\n');
  // Fresh shim delegates to an existing sibling.
  writeFileSync(join(freshDir, 'real-target.cmd'), '@echo off\r\n');
  writeFileSync(join(freshDir, `${name}.cmd`), `@echo off\r\n"${join(freshDir, 'real-target.cmd')}" %*\r\n`);

  // A never-on-PATH binary name keeps the which/login-shell lookups from
  // short-circuiting, so discovery walks the home candidates in order.
  const resolved = resolveCliPath({
    binaryName: name,
    envKeys: [],
    homeCandidates: [`${root}/stale/{bin}`, `${root}/fresh/{bin}`],
  });
  assert.equal(normalize(resolved), normalize(join(freshDir, `${name}.cmd`)));
});
