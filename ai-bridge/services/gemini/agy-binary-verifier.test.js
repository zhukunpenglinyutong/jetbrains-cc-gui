import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGY_MIN_VERSION,
  AGY_REQUIRED_HELP_FLAGS,
  compareSemver,
  parseSemver,
  verifyAgyBinary,
} from './agy-binary-verifier.js';

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

const LOOKALIKE_HELP = [
  'Usage: gemini [options]',
  '  --conversation-mode   Shared conversation context',
  '  --effort-max          Maximum effort preset',
  '  --sandbox-mode        Select sandbox mode',
  '  --show-models         Print the model table and exit',
  '',
].join('\n');

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

test('Story 006 AC-2: ai-bridge/utils/cli-path.js line count is strictly below 800 lines', () => {
  const cliPathFile = fileURLToPath(new URL('../../utils/cli-path.js', import.meta.url));
  const content = readFileSync(cliPathFile, 'utf8');
  const lines = content.split('\n').length;
  assert.ok(lines < 800, `cli-path.js must be reduced below 800 lines (currently ${lines})`);
});

test('Story 006 AC-2: compareSemver returns NaN on unparseable inputs so invalid version comparisons fail', async () => {
  const res1 = compareSemver('not-a-version', '1.1.15');
  assert.ok(Number.isNaN(res1), `compareSemver('not-a-version', '1.1.15') must be NaN, got: ${res1}`);
  assert.equal(res1 >= 0, false, 'invalid version >= 0 must evaluate to false');

  const res2 = compareSemver('1.1.15', 'not-a-version');
  assert.ok(Number.isNaN(res2), `compareSemver('1.1.15', 'not-a-version') must be NaN, got: ${res2}`);

  const res3 = compareSemver(null, '1.1.15');
  assert.ok(Number.isNaN(res3), `compareSemver(null, '1.1.15') must be NaN, got: ${res3}`);

  const res4 = compareSemver('1.1.15', undefined);
  assert.ok(Number.isNaN(res4), `compareSemver('1.1.15', undefined) must be NaN, got: ${res4}`);

  const res5 = compareSemver({}, {});
  assert.ok(Number.isNaN(res5), `compareSemver({}, {}) must be NaN, got: ${res5}`);
});

test('Story 006 AC-2: agy-binary-verifier exports AGY_MIN_VERSION, AGY_REQUIRED_HELP_FLAGS, parseSemver, and verifyAgyBinary', async () => {
  const mod = await import('./agy-binary-verifier.js');
  assert.equal(mod.AGY_MIN_VERSION, '1.1.15');
  assert.deepEqual(mod.AGY_REQUIRED_HELP_FLAGS, ['--conversation', '--effort', '--sandbox', 'models']);
  assert.equal(typeof mod.parseSemver, 'function');
  assert.equal(typeof mod.compareSemver, 'function');
  assert.equal(typeof mod.verifyAgyBinary, 'function');

  assert.deepEqual(mod.parseSemver('1.1.22'), {
    major: 1,
    minor: 1,
    patch: 22,
    prerelease: null,
    build: null,
    raw: '1.1.22',
  });

  const notFound = mod.verifyAgyBinary('/non/existent/path/for/test', null);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, 'not_found');
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

test('verifyAgyBinary enforces the exact floor: 1.1.15 passes, 1.1.14 gets the upgrade hint', async () => {
  await withFakeCliDir(async (dir) => {
    const atFloor = await writeFakeCli(dir, { version: '1.1.15' });
    assert.deepEqual(
      { ok: verifyAgyBinary(atFloor).ok, version: verifyAgyBinary(atFloor).version },
      { ok: true, version: '1.1.15' },
    );

    const belowFloor = await writeFakeCli(dir, { version: '1.1.14' });
    const result = verifyAgyBinary(belowFloor);
    assert.equal(result.ok, false);
    assert.equal(result.available, false);
    assert.equal(result.reason, 'unsupported_version');
    assert.equal(result.version, '1.1.14');
    assert.match(result.error, /1\.1\.15/);
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
      const command = args.join(' ');
      if (command.includes('--version')) return { status: 0, stdout: '1.1.22\n', stderr: '', error: null };
      return { status: 0, stdout: REAL_AGY_HELP, stderr: '', error: null };
    },
  });

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
  assert.ok(Number.isNaN(compareSemver({}, {})));
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
