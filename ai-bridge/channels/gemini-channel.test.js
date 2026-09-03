/**
 * Dispatcher-level tests for the Gemini channel (Story 1.2 review patches).
 *
 * These spawn `channel-manager.js gemini …` exactly like the Java
 * MarkerCliBridge does (command + JSON stdin gated by GEMINI_USE_STDIN), so a
 * dropped registration, a broken provider id, or a stdin-contract change fails
 * here rather than only inside the IDE (pattern:
 * channel-manager.protocol.test.mjs).
 *
 * The CLI binary is a generated fake (same approach as
 * services/gemini/message-service.test.js) so no real `agy` is needed.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const bridgeDir = dirname(fileURLToPath(import.meta.url));
const channelManager = join(bridgeDir, '..', 'channel-manager.js');
const fixturesDir = join(bridgeDir, '..', 'services', 'gemini', 'fixtures');

const FAKE_CLI_BODY = `
import fs from 'node:fs';
const fixture = process.env.FIXTURE_FILE || '';
const exitCode = Number(process.env.FIXTURE_EXIT ?? '0');
// With FAKE_ECHO_ARGV=1 the fake reports its argv on stderr; cli-spawn
// forwards CLI stderr to the channel's stderr, so the test can pin the exact
// flags the dispatcher handed the CLI.
if (process.env.FAKE_ECHO_ARGV === '1') {
  process.stderr.write('ARGV:' + JSON.stringify(process.argv.slice(2)) + '\\n');
}
const payload = fixture
  ? fs.readFileSync(fixture, 'utf8').split('\\n').filter(Boolean).map((l) => l + '\\n').join('')
  : '';
process.stdout.write(payload, () => process.exit(exitCode));
`;

/** Cross-platform launcher: spawnable on POSIX (shebang) and Windows (.cmd). */
function writeFakeCli(dir) {
  const body = join(dir, 'fake-agy.mjs');
  writeFileSync(body, FAKE_CLI_BODY, 'utf8');
  if (process.platform === 'win32') {
    const cmd = join(dir, 'fake-agy.cmd');
    writeFileSync(cmd, `@echo off\r\nnode "${body}" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = join(dir, 'fake-agy');
  writeFileSync(sh, `#!/bin/sh\nexec node "${body}" "$@"\n`, 'utf8');
  chmodSync(sh, 0o755);
  return sh;
}

const TMP_DIR = mkdtempSync(join(tmpdir(), 'gemini-channel-test-'));
const FAKE_CLI = writeFakeCli(TMP_DIR);
after(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.IDEA_PROJECT_PATH;
  delete env.PROJECT_PATH;
  return env;
}

test('gemini is dispatched by channel-manager: listModels answers the live catalog (P-8d)', () => {
  const result = spawnSync(process.execPath, [channelManager, 'gemini', 'listModels'], {
    cwd: bridgeDir,
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
    env: baseEnv({
      GEMINI_BIN: FAKE_CLI,
      FIXTURE_FILE: join(fixturesDir, 'models-catalog.tsv'),
      FIXTURE_EXIT: '0',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.success, true);
  assert.equal(response.provider, 'gemini');
  assert.equal(response.defaultModel, 'auto');
  // The 'auto' sentinel leads; the catalog follows verbatim.
  assert.equal(response.models[0].id, 'auto');
  assert.equal(response.models[0].label, 'Default (CLI)');
  assert.equal(response.models.length, 15, JSON.stringify(response.models));
  assert.deepEqual(
    response.models.slice(1).map((m) => m.id),
    ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
      'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
      'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
      'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'],
  );
});

test('gemini listModels answers an honest failure payload on a CLI error (AC4)', () => {
  const result = spawnSync(process.execPath, [channelManager, 'gemini', 'listModels'], {
    cwd: bridgeDir,
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
    env: baseEnv({
      GEMINI_BIN: FAKE_CLI,
      FIXTURE_FILE: join(fixturesDir, 'models-catalog.tsv'),
      FIXTURE_EXIT: '3',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.success, false);
  assert.equal(response.provider, 'gemini');
  assert.equal(response.defaultModel, 'auto');
  assert.deepEqual(response.models, []);
  assert.match(response.error, /exited with code 3/);
});

test('an empty message is rejected through the marker protocol, never spawned (P-7)', () => {
  const result = spawnSync(
    process.execPath,
    [channelManager, 'gemini', 'send'],
    {
      cwd: bridgeDir,
      input: JSON.stringify({ message: '   ', sessionId: '', cwd: tmpdir() }),
      env: baseEnv({ GEMINI_USE_STDIN: 'true' }),
      encoding: 'utf8',
      timeout: 15_000,
    }
  );

  assert.equal(result.status, 0, result.stderr);
  // Markers are well-formed: stream opens, error, stream closes exactly once.
  assert.match(result.stdout, /^\[MESSAGE_START\]\n\[STREAM_START\]\n/);
  const sendError = result.stdout.split('\n').find((l) => l.startsWith('[SEND_ERROR]'));
  assert.ok(sendError, 'the rejection must surface as [SEND_ERROR]');
  assert.match(JSON.parse(sendError.slice('[SEND_ERROR]'.length)).error, /message is empty/);
  assert.equal(result.stdout.split('\n').filter((l) => l === '[STREAM_END]').length, 1);
  const payload = result.stdout.split('\n').find((l) => l.startsWith('{"success"'));
  assert.equal(JSON.parse(payload).success, false);
  // No CLI was spawned: no fixture markers, no session id, no deltas.
  assert.doesNotMatch(result.stdout, /\[SESSION_ID\]/);
});

test('a missing / non-string message is rejected too, never spawned (P-7)', () => {
  for (const stdinPayload of ['{}', JSON.stringify({ message: null }), '[]']) {
    const result = spawnSync(
      process.execPath,
      [channelManager, 'gemini', 'send'],
      {
        cwd: bridgeDir,
        input: stdinPayload,
        env: baseEnv({ GEMINI_USE_STDIN: 'true' }),
        encoding: 'utf8',
        timeout: 15_000,
      }
    );

    assert.equal(result.status, 0, `${stdinPayload}: ${result.stderr}`);
    const sendError = result.stdout.split('\n').find((l) => l.startsWith('[SEND_ERROR]'));
    assert.ok(sendError, `${stdinPayload}: blank send must surface as [SEND_ERROR]`);
    assert.match(JSON.parse(sendError.slice('[SEND_ERROR]'.length)).error, /message is empty/);
    assert.equal(JSON.parse(result.stdout.split('\n').find((l) => l.startsWith('{"success"'))).success, false);
  }
});

test('gemini send routes through channel-manager and plumbs requestedCwd end to end', () => {
  const requested = join(tmpdir(), `gemini-dispatch-missing-${Date.now()}`);
  const result = spawnSync(
    process.execPath,
    [channelManager, 'gemini', 'send'],
    {
      cwd: bridgeDir,
      input: JSON.stringify({
        message: 'hello world',
        sessionId: '',
        cwd: tmpdir(), // guarded workspace (exists)
        requestedCwd: requested, // pre-clamp request (does not exist)
        model: '',
        reasoningEffort: '',
        // Keys the Java payload carries from Story 1.1/1.5 that this story's
        // channel does not consume yet — they must be accepted, not fatal.
        permissionMode: 'acceptEdits',
        preset: null,
        attachments: [],
      }),
      env: baseEnv({
        GEMINI_USE_STDIN: 'true',
        GEMINI_BIN: FAKE_CLI,
        FIXTURE_FILE: join(fixturesDir, 'success-text-turn.jsonl'),
        FIXTURE_EXIT: '0',
      }),
      encoding: 'utf8',
      timeout: 15_000,
    }
  );

  assert.equal(result.status, 0, result.stderr);
  // Full marker stream, ending with the success payload.
  assert.match(result.stdout, /^\[MESSAGE_START\]\n\[STREAM_START\]\n/);
  assert.match(result.stdout, /\[SESSION_ID\] 6f1c2a54-93b7-4c0e-8a41-7d2e5b9c1a01/);
  const deltas = result.stdout
    .split('\n')
    .filter((l) => l.startsWith('[CONTENT_DELTA]'))
    .map((l) => JSON.parse(l.slice('[CONTENT_DELTA]'.length)));
  assert.ok(deltas.includes('All done.\n'), JSON.stringify(deltas));
  const payload = JSON.parse(result.stdout.split('\n').find((l) => l.startsWith('{"success"')));
  assert.equal(payload.success, true);
  // BS-1: the pre-clamp request reaches the service and the notice fires.
  const notice = result.stdout
    .split('\n')
    .map((l) => (l.startsWith('[CONTENT_DELTA]') ? JSON.parse(l.slice('[CONTENT_DELTA]'.length)) : ''))
    .find((t) => String(t).startsWith('[Notice] Working directory substituted'));
  assert.ok(notice, `substitution must be visible end to end: ${result.stdout.slice(0, 600)}`);
  assert.ok(notice.includes(requested));
  assert.match(notice, /\(directory does not exist\)\./);
});

test('gemini send forwards the picked model as --model and never --effort', () => {
  const result = spawnSync(
    process.execPath,
    [channelManager, 'gemini', 'send'],
    {
      cwd: bridgeDir,
      input: JSON.stringify({
        message: 'hello world',
        sessionId: '',
        cwd: tmpdir(),
        model: 'gemini-3.7-flash-medium',
        reasoningEffort: '', // the webview never sends an effort for gemini
      }),
      env: baseEnv({
        GEMINI_USE_STDIN: 'true',
        GEMINI_BIN: FAKE_CLI,
        FIXTURE_FILE: join(fixturesDir, 'success-text-turn.jsonl'),
        FIXTURE_EXIT: '0',
        FAKE_ECHO_ARGV: '1',
      }),
      encoding: 'utf8',
      timeout: 15_000,
    }
  );

  assert.equal(result.status, 0, result.stderr);
  // The argv echo rides the CLI stderr bridge into the channel's stderr.
  const argvLine = result.stderr.split('\n').find((l) => l.startsWith('ARGV:'));
  assert.ok(argvLine, `the fake CLI must echo its argv: ${result.stderr.slice(0, 600)}`);
  const argv = JSON.parse(argvLine.slice('ARGV:'.length));
  const modelIndex = argv.indexOf('--model');
  assert.ok(modelIndex >= 0, `--model must be forwarded: ${JSON.stringify(argv)}`);
  assert.equal(argv[modelIndex + 1], 'gemini-3.7-flash-medium');
  assert.ok(!argv.includes('--effort'), `--effort must never be sent: ${JSON.stringify(argv)}`);
  // And the turn still completes — the flags ride a real, successful send.
  const payload = JSON.parse(result.stdout.split('\n').find((l) => l.startsWith('{"success"')));
  assert.equal(payload.success, true);
});
