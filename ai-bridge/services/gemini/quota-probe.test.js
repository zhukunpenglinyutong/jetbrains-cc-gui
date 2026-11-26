import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseUsageOutput, probeAntigravityQuota } from './quota-probe.js';

const USAGE = {
  status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [] } },
};
const probeScript = fileURLToPath(new URL('./quota-probe.js', import.meta.url));

function fixture(t, reply) {
  const root = mkdtempSync(join(tmpdir(), 'quota probe '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'home'));
  const stub = join(root, 'agy peer.cjs');
  writeFileSync(stub, `
    if (Object.keys(process.env).some(key => /^(GEMINI_API_KEY|GOOGLE_GEMINI_BASE_URL)$/i.test(key))) process.exit(99);
    const args = process.argv.slice(2).join(' ');
    if (args === '--version') {
      console.log('Notice: wrapper compatible with v99.0.0.');
      console.log('1.1.11');
    } else if (args === '--print /usage --output-format json') {
      ${reply}
    } else {
      process.exit(3);
    }
  `);
  const windows = process.platform === 'win32';
  const bin = join(root, windows ? 'agy.cmd' : 'agy');
  writeFileSync(bin, windows
    ? `@echo off\r\n"${process.execPath}" "%~dp0agy peer.cjs" %*\r\n`
    : '#!/bin/sh\nexec "$FIXTURE_NODE" "$(dirname "$0")/agy peer.cjs" "$@"\n', { mode: 0o755 });
  return spawnSync(process.execPath, [probeScript], {
    encoding: 'utf8', timeout: 15_000,
    env: {
      ...process.env,
      HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
      GEMINI_BIN: bin, FIXTURE_NODE: process.execPath,
      GeMiNi_Api_KeY: 'fixture', GOOGLE_GEMINI_BASE_URL: 'https://example.invalid',
    },
  });
}

test('queries the same selected launcher with EOF on stdin and a clean auth environment', (t) => {
  const result = fixture(t, `
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stderr.write('{"status":"ERROR"}\\n'.repeat(8000));
      process.stdout.write(' '.repeat(70_000) + ${JSON.stringify(JSON.stringify(USAGE, null, 2))});
    });
  `);
  assert.equal(result.status, 0, result.error?.message);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { status: 'SUCCESS', command: USAGE.command });
});

test('does not forward quota from a nonzero exit or an oversized response', async (t) => {
  for (const [label, reply] of [
    ['failed CLI', `console.log(${JSON.stringify(JSON.stringify(USAGE))}); process.exitCode = 1;`],
    ['over limit', "process.stdout.write('x'.repeat(300_000));"],
  ]) {
    await t.test(label, (subtest) => {
      const result = fixture(subtest, reply);
      assert.equal(result.status, 0, result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout), { status: 'unavailable', reasonCode: 'query_failed' });
    });
  }
});

test('refuses to dispatch /usage without an unambiguous supported release version', async () => {
  for (const version of ['99.0.0 mentioned in a warning', '1.1.10', '1.1.11-rc.1', '1.1.10\n7.0.0', '1.2.x', '']) {
    const result = await probeAntigravityQuota({
      findCli: () => 'fixture-agy',
      run: (_, args) => {
        assert.deepEqual(args, ['--version']);
        return version;
      },
    });
    assert.deepEqual(result, { status: 'unavailable', reasonCode: 'cli_outdated', minimumVersion: '1.1.11' });
  }
});

test('distinguishes a mistaken model turn from missing quota, probe timeout and broken execution', async () => {
  const outcomes = [
    [{ status: 'SUCCESS', num_turns: 1, response: 'raw chat text' }, 'cli_outdated', true],
    [{ status: 'SUCCESS', num_turns: 0 }, 'no_quota', undefined],
    [{ status: 'ERROR', error: 'raw error text' }, 'query_failed', undefined],
    [null, 'query_failed', undefined],
  ];
  for (const [output, reason, legacy] of outcomes) {
    const result = await probeAntigravityQuota({ findCli: () => 'fixture-agy', run: (_, args) => (
      args[0] === '--version' ? 'v1.5.18+build' : output && JSON.stringify(output)
    ) });
    assert.equal(result.reasonCode, reason);
    assert.equal(result.legacyModelTurn, legacy);
    assert.doesNotMatch(JSON.stringify(result), /raw (?:chat|error) text/);
  }
  for (const [code, reason] of [['ETIMEDOUT', 'timeout'], ['ENOENT', 'cli_missing']]) {
    const result = await probeAntigravityQuota({ findCli: () => 'fixture-agy', run: () => {
      throw Object.assign(new Error('private launcher information'), { code });
    } });
    assert.deepEqual(result, { status: 'unavailable', reasonCode: reason });
  }
});

test('reads pretty JSON or one-line CLI results surrounded by diagnostics', () => {
  assert.deepEqual(parseUsageOutput(JSON.stringify(USAGE, null, 2)), USAGE);
  assert.deepEqual(parseUsageOutput(`note\n${JSON.stringify(USAGE)}\n{"status":"ERROR","diagnostic":true}\n`), USAGE);
  const bom = String.fromCharCode(0xFEFF);
  assert.deepEqual(parseUsageOutput(bom + JSON.stringify(USAGE, null, 2)), USAGE);
  assert.equal(parseUsageOutput('not json\n{broken\n'), null);
});
