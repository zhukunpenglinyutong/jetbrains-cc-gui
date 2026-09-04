/**
 * Tests for the Gemini (agy) message service — Story 1.2.
 *
 * Event mapping is verified by REPLAYING live-captured stream-json fixtures
 * (fixtures/*.jsonl, recorded from agy 1.1.24) through a fake CLI process:
 * the service spawns GEMINI_BIN, which is pointed at a generated launcher
 * that emits the fixture NDJSON lines and exits with a controlled code
 * (same inline-fake-child pattern as services/claude/mcp-status/process-manager.test.js).
 *
 * Fixture provenance (live captures, sanitized: /Users/<user> -> <HOME>,
 * /tmp/<dir> -> <TMP>, tools[] truncated to a representative subset):
 * - text-turn-error-result.jsonl: text turn ending status ERROR while the
 *   partial answer WAS streamed (exit 0).
 * - tool-turn-denied.jsonl: tool ACTIVE -> state ERROR (permission denied),
 *   result SUCCESS (exit 0).
 * - tool-turn-completed.jsonl: tool ACTIVE -> DONE with output, then result
 *   ERROR (quota), exit 1.
 * - timeout-error.jsonl: --print-timeout abort — user_input then result
 *   ERROR "timeout waiting for response", exit 1 (proves --print-timeout
 *   bounds the TOTAL turn wait, hence the explicit 8760h flag).
 * - slash-clear-error-result.jsonl: "/clear" in print mode — result-only
 *   ERROR (no init/steps) with the CLI's explanatory error text, empty
 *   conversation_id, zero usage, exit 2 (re-captured live from agy 1.1.26
 *   2026-09-03; closes the Story 1.2 deferred recapture item).
 *
 * Synthetic fixtures (built from the live-verified shapes after the quota
 * died — the scenarios themselves are documented CLI behaviour):
 * success-text-turn / multi-delta-streaming / invalid-status /
 * multi-tool-turn / tool-unnamed-steps / tool-unnamed-interleaved /
 * no-result-early-exit / double-result / error-response-only.
 * Story 1.3 added: new-conversation-after-reset (fresh conversation id B
 * after a reset — pairs with success-text-turn's id A in the AC5 test).
 * Code review loop 3 added: success-no-deltas (SUCCESS without any
 * text_delta step) and tool-active-no-terminal (ACTIVE tool the result
 * closes without a DONE/ERROR step).
 *
 * The unauthenticated stderr shape is NOT captured live (reproducing it would
 * disturb the developer's CLI credentials, per Story 1.2 Task 1d) — the auth
 * classifier is exercised against a synthetic best-effort stderr string.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getRealHomeDir } from '../../utils/path-utils.js';
import { GeminiPermissionMapper } from '../../utils/permission-mapper.js';
import { GROK_MAX_IMAGE_BYTES } from '../../utils/cli-image-input.js';

const SERVICE_DIR = fileURLToPath(new URL('.', import.meta.url));
const SERVICE_PATH = join(SERVICE_DIR, 'message-service.js');
const FIXTURES_DIR = join(SERVICE_DIR, 'fixtures');
const BRIDGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

const FAKE_CLI_BODY = `
import fs from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
const fixture = process.env.FIXTURE_FILE || '';
const exitCode = Number(process.env.FIXTURE_EXIT ?? '0');
const stderr = process.env.FIXTURE_STDERR || '';
if (process.env.FAKE_ECHO_ARGV === '1') {
  process.stderr.write('ARGV:' + JSON.stringify(process.argv.slice(2)) + '\\n');
}
if (process.env.FAKE_ECHO_CWD === '1') {
  process.stderr.write('CWD:' + process.cwd() + '\\n');
}
if (stderr) process.stderr.write(stderr);
const payload = fixture
  ? fs.readFileSync(fixture, 'utf8').split('\\n').filter(Boolean).map((l) => l + '\\n').join('')
  : '';
if (process.env.FAKE_ECHO_INIT_PERM === '1') {
  // Stand-in for the live CLI's init echo: report the posture the "CLI"
  // acknowledged, read from the fixture it is about to replay, so tests
  // assert what flowed through the spawned child — not the file on disk.
  const firstLine = payload ? payload.split('\\n')[0] : '';
  let echoedPerm = '';
  try { echoedPerm = (JSON.parse(firstLine).init || {}).permission_mode ?? ''; } catch {}
  process.stderr.write('INIT_PERM:' + echoedPerm + '\\n');
}
if (process.env.FAKE_ECHO_IMAGE_STATS === '1') {
  // Story 1.6: stat every [Image #N: path] the service injected into the
  // prompt — on-disk proof the referenced file was materialized while the
  // "CLI" ran (the parent test asserts cleanup after the child exits).
  const promptIdx = process.argv.indexOf('-p');
  const prompt = promptIdx >= 0 ? (process.argv[promptIdx + 1] || '') : '';
  const stats = [...prompt.matchAll(/\\[Image #\\d+: ([^\\]]+)\\]/g)].map((m) => {
    try {
      return { path: m[1], exists: true, size: fs.statSync(m[1]).size };
    } catch {
      return { path: m[1], exists: false, size: -1 };
    }
  });
  process.stderr.write('IMGSTAT:' + JSON.stringify(stats) + '\\n');
}
// Story 1.10 modes: the watchdog tests need a CLI that can be ALIVE while
// silent (the canonical hang), alive while slowly producing output (the
// legitimate silent-ish build), and one that leaves a grandchild behind so
// the tree-kill can be proven. Every mode carries a hard self-exit cap so a
// red-phase harness kill can never leak a detached fake process.
const mode = process.env.FAKE_MODE || '';
if (mode) {
  const lifetime = Number(process.env.FAKE_LIFETIME_MS || '15000');
  const CONV = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const keepAlive = setInterval(() => {}, 1000000);
  const initLine = JSON.stringify({ event: 'init', conversation_id: CONV, init: { cwd: process.cwd(), tools: [], permission_mode: 'default' } });
  const deltaLine = (i) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: CONV, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'tick ' + i } });
  const unknownLine = (i) => JSON.stringify({ event: 'mystery_event_' + i, payload: { n: i, note: 'unknown-but-parseable' } });
  const resultLine = JSON.stringify({ event: 'result', result: { conversation_id: CONV, duration_seconds: 1, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 }, status: 'SUCCESS', response: 'done', error: null } });
  const write = (s) => new Promise((res) => process.stdout.write(s + '\\n', res));
  if (mode === 'silent-hang' || mode === 'delta-then-hang' || mode === 'hang-with-grandchild') {
    if (process.env.FAKE_HANG_INIT === '1') await write(initLine);
    if (mode === 'delta-then-hang') {
      await write(deltaLine(1));
      await write(deltaLine(2));
    }
    if (mode === 'hang-with-grandchild' && process.env.FAKE_GC_PID_FILE) {
      const gcCode = "import fs from 'node:fs';fs.writeFileSync(process.env.FAKE_GC_PID_FILE, String(process.pid));setInterval(() => {}, 1000000);setTimeout(() => process.exit(0), Number(process.env.FAKE_LIFETIME_MS || '15000'));";
      spawnChild(process.execPath, ['--input-type=module', '-e', gcCode], { stdio: 'ignore' });
    }
    setTimeout(() => process.exit(42), lifetime);
  } else if (mode === 'slow-emit') {
    const interval = Number(process.env.FAKE_EMIT_INTERVAL_MS || '500');
    const total = Number(process.env.FAKE_EMIT_LINES || '8');
    const kind = process.env.FAKE_EMIT_KIND || 'delta';
    await write(initLine);
    for (let i = 1; i <= total; i++) {
      await write(kind === 'unknown' ? unknownLine(i) : deltaLine(i));
      await new Promise((res) => setTimeout(res, interval));
    }
    await write(resultLine);
    process.exit(0);
  } else {
    process.exit(43); // unknown mode: visible in the exit code, never a silent hang
  }
} else {
  process.stdout.write(payload, () => process.exit(exitCode));
}
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

const RUNNER = `
const { sendMessage } = await import(process.env.SERVICE_PATH);
let attachments = [];
if (process.env.SVC_ATTACHMENTS_FILE) {
  attachments = JSON.parse(await (await import('node:fs/promises')).readFile(process.env.SVC_ATTACHMENTS_FILE, 'utf8'));
}
await sendMessage(
  'hello world',
  process.env.SVC_SESSION_ID || '',
  process.env.SVC_CWD || '',
  process.env.SVC_MODEL || '',
  process.env.SVC_REASONING_EFFORT || '',
  attachments,
  process.env.SVC_REQUESTED_CWD || '',
  process.env.SVC_PERMISSION_MODE || ''
);
`;

/**
 * Run sendMessage in a child node process against the fake CLI and collect
 * the service's protocol output (stdout is the marker protocol; diagnostics
 * go to stderr).
 */
function runService({
  fixture,
  exitCode = 0,
  stderr = '',
  cwd = '',
  sessionId = '',
  model = '',
  reasoningEffort = '',
  requestedCwd = '',
  permissionMode = '',
  attachmentsFile = '',
  geminiBin = '',
  echoArgv = false,
  echoCwd = false,
  echoInitPerm = false,
  echoImageStats = false,
  extraEnv = {},
  // Story 1.10 watchdog harness: hang/slow-emit fake-CLI modes plus a bounded
  // run. timeoutMs SIGTERMs the runner (the same path the JVM's dispose uses
  // — cli-spawn's parent-signal handler tears the fake tree down) so a turn
  // that is NEVER reaped still resolves; `timedOut` tells the two apart.
  mode = '',
  hangInit = false,
  emitKind = '',
  emitIntervalMs = '',
  emitLines = '',
  gcPidFile = '',
  lifetimeMs = '',
  timeoutMs = 0,
}) {
  const fakeCli = globalThis.__geminiFakeCli;
  const env = { ...process.env };
  delete env.IDEA_PROJECT_PATH; // keep selectWorkingDirectory deterministic
  delete env.PROJECT_PATH;
  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = value;
  }
  env.GEMINI_BIN = geminiBin || fakeCli;
  env.FIXTURE_FILE = fixture ? join(FIXTURES_DIR, fixture) : '';
  env.FIXTURE_EXIT = String(exitCode);
  env.FIXTURE_STDERR = stderr;
  env.FAKE_ECHO_ARGV = echoArgv ? '1' : '';
  env.FAKE_ECHO_CWD = echoCwd ? '1' : '';
  env.FAKE_ECHO_INIT_PERM = echoInitPerm ? '1' : '';
  env.FAKE_ECHO_IMAGE_STATS = echoImageStats ? '1' : '';
  env.SERVICE_PATH = SERVICE_PATH;
  env.SVC_CWD = cwd;
  env.SVC_SESSION_ID = sessionId;
  env.SVC_MODEL = model;
  env.SVC_REASONING_EFFORT = reasoningEffort;
  env.SVC_REQUESTED_CWD = requestedCwd;
  env.SVC_PERMISSION_MODE = permissionMode;
  env.SVC_ATTACHMENTS_FILE = attachmentsFile;
  env.FAKE_MODE = mode;
  env.FAKE_HANG_INIT = hangInit ? '1' : '';
  env.FAKE_EMIT_KIND = emitKind;
  env.FAKE_EMIT_INTERVAL_MS = emitIntervalMs;
  env.FAKE_EMIT_LINES = emitLines;
  env.FAKE_GC_PID_FILE = gcPidFile;
  env.FAKE_LIFETIME_MS = lifetimeMs;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', RUNNER], {
      env,
      cwd: BRIDGE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrOut = '';
    let timedOut = false;
    let hardKill = null;
    let killer = null;
    if (timeoutMs > 0) {
      killer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        hardKill = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, 5000);
      }, timeoutMs);
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderrOut += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (killer) clearTimeout(killer);
      if (hardKill) clearTimeout(hardKill);
      resolve({ code, stdout, stderr: stderrOut, timedOut });
    });
  });
}

const MARKER_RE = /^\[(MESSAGE_START|STREAM_START|STREAM_END|MESSAGE_END|SESSION_ID|CONTENT_DELTA|THINKING_DELTA|USAGE|SEND_ERROR|MESSAGE)\]/;

/** Protocol lines only: markers and the final bare-JSON payload. */
function protocolLines(stdout) {
  return stdout.split('\n').filter((l) => MARKER_RE.test(l) || l.startsWith('{'));
}

function markers(stdout, name) {
  return protocolLines(stdout).filter((l) => l.startsWith(`[${name}]`));
}

function decodeStringMarker(line) {
  const payload = line.slice(line.indexOf(']') + 1).trim();
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/** Parse [MESSAGE] markers into their Claude-compatible message objects. */
function messageMarkers(stdout) {
  return markers(stdout, 'MESSAGE').map((line) => {
    const payload = JSON.parse(line.slice('[MESSAGE]'.length).trim());
    return payload?.message?.content?.[0] ?? {};
  });
}

/** Parse the final bare `{"success":...}` payload line, if any. */
function finalPayload(stdout) {
  const line = protocolLines(stdout).find((l) => l.startsWith('{"success"'));
  return line ? JSON.parse(line) : null;
}

// Fake CLI + tmp workspace, created once for the whole file and removed at the
// end (P-10: no leftover mkdtemp dirs).
const TMP_DIR = mkdtempSync(join(tmpdir(), 'gemini-msgsvc-test-'));
globalThis.__geminiFakeCli = writeFakeCli(TMP_DIR);
const tempDirs = [TMP_DIR];
after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Same as makeTempDir but rooted at an arbitrary parent (e.g. the home dir). */
function makeTempDirAt(parent, prefix) {
  const dir = mkdtempSync(join(parent, prefix));
  tempDirs.push(dir);
  return dir;
}

/** Cheap path comparison aligned with normalizePathForComparison. */
function normalize(p) {
  return String(p || '').replace(/\/+$/, '');
}

/** Write an attachments JSON file for the runner (env values must stay small). */
function writeAttachmentsFile(attachments) {
  const file = join(TMP_DIR, `att-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(attachments), 'utf8');
  return file;
}

test('Story 1.10 review L4/L2 pins: reap window wording and classifier immunity', async () => {
  const { buildIdleReapMessage, formatGeminiError, isGeminiAuthError } =
    await import('./message-service.js');
  // L4: exact 1 is singular — "1 minutes" never ships.
  assert.match(buildIdleReapMessage(1, true), /no output from the Gemini CLI \(agy\) for 1 minute\./);
  assert.match(buildIdleReapMessage(30, true), /for 30 minutes\./);
  assert.match(buildIdleReapMessage(1.5, true), /for 1\.5 minutes\./);
  assert.match(buildIdleReapMessage(0.05, false), /for 3 seconds\./);
  const oneSecond = buildIdleReapMessage(1 / 60, true);
  assert.match(oneSecond, /for 1 second\./, `got: ${oneSecond}`);
  // L2 at the unit level: the message names authentication as a LIKELY cause,
  // so it must never trip the classifier that emitFailure runs it through —
  // a trip would rewrap the whole cause+remedy set into the auth template.
  const text = buildIdleReapMessage(0.05, true);
  assert.equal(isGeminiAuthError(text), false, 'the reap message must not match isGeminiAuthError');
  assert.equal(formatGeminiError(text), text, 'formatGeminiError must pass the reap message through unrewrapped');
});

test('buildGeminiArgs emits the print-mode stream contract', async () => {
  const { buildGeminiArgs } = await import('./message-service.js');
  const args = buildGeminiArgs({ message: 'hi', sessionId: 'abc-123' });
  assert.deepEqual(args, [
    '-p', 'hi',
    '--output-format', 'stream-json',
    // --print-timeout bounds the TOTAL turn wait on the live CLI (a 1s cap
    // aborted a ~6s turn), so an effectively unbounded value is required.
    '--print-timeout', '8760h',
    '--conversation', 'abc-123',
  ]);
});

test('buildGeminiArgs omits --conversation without a usable session id', async () => {
  const { buildGeminiArgs } = await import('./message-service.js');
  for (const sessionId of ['', 'undefined', 'null', '.', 'a/b']) {
    const args = buildGeminiArgs({ message: 'hi', sessionId });
    assert.ok(!args.includes('--conversation'), `sessionId=${sessionId}`);
    assert.ok(!args.includes('--model'), 'no model flag without a model id');
  }
});

test('normalizeGeminiModelId keeps real slugs and collapses sentinels to none', async () => {
  const { normalizeGeminiModelId } = await import('./message-service.js');
  for (const slug of ['gemini-3.7-flash-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6',
    'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']) {
    assert.equal(normalizeGeminiModelId(slug), slug, `slug=${slug}`);
  }
  // Cross-vendor slugs are REAL agy catalog entries — the service never
  // strips them (the Java side pins the same contract for gemini).
  for (const none of ['', '   ', 'auto', 'AUTO', 'default', '__config_default__', '(default)',
    'undefined', 'null', '-flag-like', '--effort', 42, null, undefined]) {
    assert.equal(normalizeGeminiModelId(none), '', `model=${String(none)}`);
  }
});

test('buildGeminiArgs forwards a picked model as --model <full-slug>', async () => {
  const { buildGeminiArgs } = await import('./message-service.js');
  const args = buildGeminiArgs({ message: 'hi', sessionId: '', model: 'gemini-3.7-flash-high' });
  const idx = args.indexOf('--model');
  assert.notEqual(idx, -1, JSON.stringify(args));
  assert.equal(args[idx + 1], 'gemini-3.7-flash-high');
  // No separate effort flag: the tier is baked into the full slug, and some
  // slugs reject --effort outright.
  assert.ok(!args.includes('--effort'), JSON.stringify(args));
});

test('buildGeminiArgs appends the permission flags for each unified mode', async () => {
  const { buildGeminiArgs } = await import('./message-service.js');
  const table = [
    ['plan', ['--mode', 'plan']],
    ['acceptEdits', ['--mode', 'accept-edits']],
    ['bypassPermissions', ['--dangerously-skip-permissions']],
    ['sandbox', ['--sandbox']],
  ];
  for (const [mode, flags] of table) {
    const args = buildGeminiArgs({ message: 'hi', permissionMode: mode });
    assert.deepEqual(args.slice(-flags.length), flags, `mode=${mode}: ${JSON.stringify(args)}`);
  }
  // default (and anything unrecognized) spawns with zero posture flags.
  for (const mode of ['default', '', undefined, 'bogus']) {
    const args = buildGeminiArgs({ message: 'hi', permissionMode: mode });
    assert.ok(!args.includes('--mode'), `no --mode for ${String(mode)}: ${JSON.stringify(args)}`);
    assert.ok(!args.includes('--sandbox'), `no --sandbox for ${String(mode)}`);
    assert.ok(!args.includes('--dangerously-skip-permissions'), `no bypass for ${String(mode)}`);
  }
});

test('sendMessage forwards the permission mode into the spawned CLI args (AC1)', async () => {
  // Expected flags come from the mapper itself — this test pins the FORWARDING
  // (mode -> mapper -> spawn argv); the literal mode->flags table is pinned by
  // permission-mapper.test.js, the single place it is spelled out.
  const modes = ['plan', 'acceptEdits', 'bypassPermissions', 'sandbox', 'default'];
  for (const mode of modes) {
    const flags = GeminiPermissionMapper.toProvider(mode).args;
    const run = await runService({
      fixture: 'success-text-turn.jsonl',
      permissionMode: mode,
      echoArgv: true,
    });
    assert.equal(run.code, 0, `mode=${mode}: ${run.stderr.slice(0, 400)}`);
    const argvLine = run.stderr.split('\n').find((l) => l.startsWith('ARGV:'));
    assert.ok(argvLine, `missing ARGV echo for ${mode}: ${run.stderr.slice(0, 400)}`);
    const argv = JSON.parse(argvLine.slice('ARGV:'.length));
    for (const flag of flags) {
      assert.ok(argv.includes(flag), `mode=${mode}: missing ${flag} in ${JSON.stringify(argv)}`);
    }
    if (flags.length === 0) {
      assert.ok(
        !argv.includes('--mode') && !argv.includes('--sandbox')
        && !argv.includes('--dangerously-skip-permissions'),
        `mode=${mode}: posture flags leaked: ${JSON.stringify(argv)}`
      );
    }
  }
});

test('AC6 conformance: mode -> spawn flags -> CLI-acknowledged posture', async () => {
  // Conformance source of truth is the LIVE probe table (Task 0, agy 1.1.25):
  // every posture echoes init.permission_mode "request-review" except
  // --dangerously-skip-permissions, which the CLI acknowledges as
  // "always-proceed". What this test enforces against that table: each mode
  // spawns exactly its mapper flag set, the replayed child echoes the
  // table's posture (INIT_PERM — read from what the spawned child reported,
  // not from the fixture file on disk), and the turn completes. UI label and
  // backend posture can never diverge.
  const table = [
    ['default', 'success-text-turn.jsonl', 'request-review'],
    ['plan', 'success-text-turn.jsonl', 'request-review'],
    ['acceptEdits', 'success-text-turn.jsonl', 'request-review'],
    ['bypassPermissions', 'bypass-always-proceed.jsonl', 'always-proceed'],
    ['sandbox', 'success-text-turn.jsonl', 'request-review'],
  ];
  for (const [mode, fixture, posture] of table) {
    const flags = GeminiPermissionMapper.toProvider(mode).args;
    const run = await runService({ fixture, permissionMode: mode, echoArgv: true, echoInitPerm: true });
    assert.equal(run.code, 0, `mode=${mode}: ${run.stderr.slice(0, 400)}`);
    const argvLine = run.stderr.split('\n').find((l) => l.startsWith('ARGV:'));
    assert.ok(argvLine, `mode=${mode}: missing ARGV echo: ${run.stderr.slice(0, 400)}`);
    const argv = JSON.parse(argvLine.slice('ARGV:'.length));
    for (const flag of flags) {
      assert.ok(argv.includes(flag), `mode=${mode}: missing ${flag} in ${JSON.stringify(argv)}`);
    }
    const permLine = run.stderr.split('\n').find((l) => l.startsWith('INIT_PERM:'));
    assert.ok(permLine, `mode=${mode}: missing INIT_PERM echo: ${run.stderr.slice(0, 400)}`);
    assert.equal(permLine.slice('INIT_PERM:'.length), posture,
      `mode=${mode} spawns ${JSON.stringify(flags)}; replayed CLI acknowledges "${posture}"`);
    assert.equal(finalPayload(run.stdout).success, true, `mode=${mode}: turn must complete`);
  }
});

test('buildGeminiArgs omits --model for sentinel and blank model ids', async () => {
  const { buildGeminiArgs } = await import('./message-service.js');
  for (const model of ['', 'auto', 'default', '__config_default__', '(default)', '-dash-led']) {
    const args = buildGeminiArgs({ message: 'hi', sessionId: 'abc-123', model });
    assert.ok(!args.includes('--model'), `model=${model}: ${JSON.stringify(args)}`);
  }
});

test('a picked model slug reaches the CLI verbatim and --effort is never sent', async () => {
  // gemini-family slug AND a cross-vendor catalog slug (claude-*) must both
  // survive the whole service path untouched.
  for (const model of ['gemini-3.7-flash-medium', 'claude-sonnet-4-6']) {
    const run = await runService({
      fixture: 'success-text-turn.jsonl',
      model,
      reasoningEffort: 'high',
      echoArgv: true,
    });
    const argvLine = run.stderr.split('\n').find((l) => l.startsWith('ARGV:'));
    assert.ok(argvLine, `missing ARGV echo for ${model}: ${run.stderr.slice(0, 400)}`);
    const argv = JSON.parse(argvLine.slice('ARGV:'.length));
    const idx = argv.indexOf('--model');
    assert.notEqual(idx, -1, `no --model in ${JSON.stringify(argv)}`);
    assert.equal(argv[idx + 1], model);
    assert.ok(!argv.includes('--effort'), `effort flag leaked for ${model}: ${JSON.stringify(argv)}`);
    assert.equal(run.code, 0, run.stderr.slice(0, 400));
  }
});

test('buildGeminiArgs guards a leading dash prompt token', async () => {
  const { buildGeminiArgs } = await import('./message-service.js');
  const args = buildGeminiArgs({ message: '-looks-like-a-flag', sessionId: '' });
  assert.equal(args[1], ' -looks-like-a-flag');
});

test('normalizeConversationId rejects dash-led ids (P-6: they would parse as CLI flags)', async () => {
  const { normalizeConversationId } = await import('./message-service.js');
  for (const bad of ['--print-timeout', '-conversation', ' -x', '--model=gemini']) {
    assert.equal(normalizeConversationId(bad), '', `sessionId=${bad}`);
  }
  for (const good of ['2ac96d6e-db37-4187-b143-6f64975415c8', 'sess_01', 'abc-123']) {
    assert.equal(normalizeConversationId(good), good.trim(), `sessionId=${good}`);
  }
});

test('classifyWorkspaceSubstitutionReason covers the closed localized set', async () => {
  const { classifyWorkspaceSubstitutionReason } = await import('./message-service.js');
  assert.equal(classifyWorkspaceSubstitutionReason(BRIDGE_DIR.replace(/\/$/, '')), 'plugin-internal directory');
  const missing = join(tmpdir(), `gemini-missing-${Date.now()}-classify`);
  assert.equal(classifyWorkspaceSubstitutionReason(missing), 'directory does not exist');
  // exists-but-file
  const filePath = join(TMP_DIR, 'plain-file.txt');
  writeFileSync(filePath, 'x', 'utf8');
  assert.equal(classifyWorkspaceSubstitutionReason(filePath), 'not a directory');
  // an existing temp directory is rejected on its own terms (R-2)…
  assert.equal(classifyWorkspaceSubstitutionReason(TMP_DIR), 'temporary directory');
  // …while an existing directory outside the project that is neither the
  // bridge dir nor a temp dir is the generic unsafe case
  assert.equal(classifyWorkspaceSubstitutionReason(homedir()), 'unsafe working directory');
});

test('auth classifier matches login failures conservatively (R-1)', async () => {
  const { isGeminiAuthError, formatGeminiError } = await import('./message-service.js');
  const positives = [
    'Error: not logged in',
    'Please sign in to continue',
    'authentication failed: token expired',
    'credentials expired, re-authentication required',
    'no active credentials found',
    'login required for this command',
  ];
  for (const text of positives) {
    assert.ok(isGeminiAuthError(text), text);
    const formatted = formatGeminiError(text);
    assert.match(formatted, /not logged in or credentials have expired/);
    assert.match(formatted, /Google Sign-In/);
    assert.match(formatted, /does not manage Google credentials/);
  }
  const negatives = [
    'Individual quota reached. Please upgrade your subscription.',
    'The stream was interrupted. Please continue the task you were working on.',
    'timeout waiting for response',
    'permission check failed for command "pwd"',
    // bare status codes / HTTP words also occur in ordinary tool output — a
    // build failure must not be flipped into a credential remedy
    'git push failed: 401 unauthorized',
    'remote: HTTP 401',
  ];
  for (const text of negatives) {
    assert.equal(isGeminiAuthError(text), false, text);
    assert.equal(formatGeminiError(text), text);
  }
});

test('replays a text turn: deltas stream live, ERROR payload beats exit 0 (AC2, AC3)', async () => {
  const { code, stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    exitCode: 0, // live capture: ERROR status with exit 0
  });

  const lines = protocolLines(stdout);
  assert.equal(lines[0], '[MESSAGE_START]');
  assert.equal(lines[1], '[STREAM_START]', 'stream markers must open before any delta');

  // text_delta from the agent_response step is forwarded as a content delta
  const deltas = markers(stdout, 'CONTENT_DELTA').map(decodeStringMarker);
  assert.ok(deltas.includes('ok\n'), JSON.stringify(deltas));

  // [USAGE] is the single canonical per-turn figure mapped from the result
  // payload (raw CLI field names never reach the wire). The turn here is an
  // ERROR result, but tokens were still consumed — usage is still reported.
  const usages = markers(stdout, 'USAGE').map((l) => JSON.parse(l.slice('[USAGE]'.length)));
  assert.equal(usages.length, 1, 'result payload is the authoritative single [USAGE]');
  assert.deepEqual(usages[0], {
    input_tokens: 18794,
    output_tokens: 147,
    cache_read_input_tokens: 0,
    thinking_tokens: 146,
  });

  // conversation_id from init becomes the session id
  assert.equal(markers(stdout, 'SESSION_ID')[0], '[SESSION_ID] 299cd332-7948-4a22-b015-e3dffd1bb939');

  // AC3: status ERROR in the payload -> [SEND_ERROR] + failure payload even
  // though the process exited 0.
  const sendErrors = markers(stdout, 'SEND_ERROR');
  assert.equal(sendErrors.length, 1);
  const sendError = JSON.parse(sendErrors[0].slice('[SEND_ERROR]'.length));
  assert.match(sendError.error, /The stream was interrupted/);

  const payload = finalPayload(stdout);
  assert.deepEqual(payload, {
    success: false,
    error: sendError.error,
    details: { status: 'ERROR', rawError: 'The stream was interrupted. Please continue the task you were working on.' },
  });

  // stream closes exactly once, after the error marker
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
  assert.equal(markers(stdout, 'MESSAGE_END').length, 1);
  assert.ok(
    lines.findIndex((l) => l.startsWith('[SEND_ERROR]')) < lines.findIndex((l) => l === '[STREAM_END]'),
    '[SEND_ERROR] must precede the stream end markers'
  );
  assert.equal(code, 0, 'success-path service never hard-exits with a truncated stdout');
});

test('replays a denied tool call: ACTIVE use then ERROR result (AC2)', async () => {
  const { stdout } = await runService({ fixture: 'tool-turn-denied.jsonl', exitCode: 0 });
  const messages = messageMarkers(stdout);

  const toolUse = messages.filter((m) => m.type === 'tool_use');
  assert.equal(toolUse.length, 1);
  assert.equal(toolUse[0].name, 'run_command');
  assert.equal(toolUse[0].id, '2');
  assert.deepEqual(toolUse[0].input, { CommandLine: 'pwd' });

  // state ERROR is a terminal tool result — the webview bubble must not hang
  const toolResults = messages.filter((m) => m.type === 'tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].tool_use_id, '2');
  assert.equal(toolResults[0].is_error, true);
  assert.match(toolResults[0].content, /TOOL_ERROR: permission check failed/);

  // result SUCCESS on the same turn closes as a success
  const payload = finalPayload(stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.sessionId, '18768ab6-721a-42b6-b56e-abb9b000657b');
  assert.equal(markers(stdout, 'SEND_ERROR').length, 0);
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
  assert.equal(markers(stdout, 'MESSAGE_END').length, 1);
});

test('replays a completed tool call: DONE output mapped, no duplicate tool_use', async () => {
  const { stdout } = await runService({ fixture: 'tool-turn-completed.jsonl', exitCode: 1 });
  const messages = messageMarkers(stdout);

  const toolUse = messages.filter((m) => m.type === 'tool_use');
  assert.equal(toolUse.length, 1, 'DONE must not re-emit the ACTIVE tool_use');

  const toolResults = messages.filter((m) => m.type === 'tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].is_error, false);
  assert.match(toolResults[0].content, /<HOME>\/\.gemini\/antigravity-cli\/scratch/);

  // result ERROR (quota) still fails the turn — payload over exit code
  const sendErrors = markers(stdout, 'SEND_ERROR');
  assert.equal(sendErrors.length, 1);
  const sendError = JSON.parse(sendErrors[0].slice('[SEND_ERROR]'.length));
  assert.match(sendError.error, /Individual quota reached/);
  assert.equal(finalPayload(stdout).success, false);
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
});

test('replays a --print-timeout abort: user_input-only turn fails cleanly', async () => {
  const { stdout } = await runService({ fixture: 'timeout-error.jsonl', exitCode: 1 });
  const payload = finalPayload(stdout);
  assert.equal(payload.success, false);
  assert.equal(payload.details.status, 'ERROR');
  assert.equal(payload.details.rawError, 'timeout waiting for response');
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
  assert.equal(markers(stdout, 'MESSAGE_END').length, 1);
});

test('nonzero exit without a result event still closes the stream once', async () => {
  const { stdout } = await runService({
    exitCode: 1,
    stderr: 'agy: crash mid-turn\n',
  });
  const sendErrors = markers(stdout, 'SEND_ERROR');
  assert.equal(sendErrors.length, 1);
  const sendError = JSON.parse(sendErrors[0].slice('[SEND_ERROR]'.length));
  assert.match(sendError.error, /crash mid-turn/);
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
  assert.equal(markers(stdout, 'MESSAGE_END').length, 1);
  // R-6: the CLI-driven failure also yields the final JSON payload — a
  // consumer that only reads the footer must still learn the turn failed.
  const payload = finalPayload(stdout);
  assert.equal(payload.success, false, 'no success payload without a result event');
  assert.match(payload.error, /crash mid-turn/);
  assert.equal(payload.details.status, 'CLI_ERROR');
});

test('unauthenticated stderr is classified as an auth failure (AC4, best-effort fixture)', async () => {
  const { stdout } = await runService({
    exitCode: 1,
    stderr: 'Error: not logged in. Run the CLI and complete sign in to continue.\n',
  });
  const sendErrors = markers(stdout, 'SEND_ERROR');
  assert.equal(sendErrors.length, 1);
  const sendError = JSON.parse(sendErrors[0].slice('[SEND_ERROR]'.length));
  assert.match(sendError.error, /authentication required/);
  assert.match(sendError.error, /Run 'agy' in an external terminal/);
  assert.match(sendError.error, /complete the interactive Google Sign-In flow/);
  assert.match(sendError.error, /does not manage Google credentials or perform Google login in-plugin/);
});

test('result-only ERROR with nonzero exit: print-mode slash command (live capture, exit 2)', async () => {
  // Live-captured from agy 1.1.26 (2026-09-03): sending "/clear" in print
  // mode yields a single result event — no init, no step_updates — with
  // status ERROR, an empty conversation_id, zero usage, an explanatory
  // `error` string, and CLI exit code 2. The result payload, not the exit
  // code, is authoritative: the user must see the CLI's own explanation,
  // not a generic CLI_ERROR footer.
  const safeDir = makeTempDir('gemini-clear-');
  const { stdout } = await runService({
    fixture: 'slash-clear-error-result.jsonl',
    exitCode: 2,
    cwd: safeDir,
  });
  assert.equal(markers(stdout, 'CONTENT_DELTA').length, 0, 'no steps precede the result');
  const sendErrors = markers(stdout, 'SEND_ERROR');
  assert.equal(sendErrors.length, 1);
  const sendError = JSON.parse(sendErrors[0].slice('[SEND_ERROR]'.length));
  assert.match(sendError.error, /\/clear is not available in print mode/);
  assert.match(sendError.error, /--disable-slash-commands/);
  const payload = finalPayload(stdout);
  assert.equal(payload.success, false);
  assert.equal(payload.details.status, 'ERROR', 'exit 2 after a parsed result must not downgrade to CLI_ERROR');
  assert.match(payload.details.rawError, /not available in print mode/);
});

test('safe requested cwd runs without a substitution notice (AC1, AC5)', async () => {
  const safeDir = makeTempDir('gemini-cwd-ok-');
  const { stdout } = await runService({ fixture: 'text-turn-error-result.jsonl', cwd: safeDir });
  const notices = markers(stdout, 'CONTENT_DELTA')
    .map(decodeStringMarker)
    .filter((t) => String(t).startsWith('[Notice]'));
  assert.equal(notices.length, 0, JSON.stringify(notices));
});

test('pre-clamp requestedCwd outside the project surfaces the notice (BS-1, AC5)', async () => {
  // Canonical AC5 case: the user's requested dir is outside the project, Java
  // clamps it to the project base before the bridge, so `cwd` (guarded) is
  // safe while `requestedCwd` names what the user asked for. The substitution
  // must still be VISIBLE.
  const guardedDir = makeTempDir('gemini-cwd-guarded-');
  const requested = join(tmpdir(), `gemini-outside-project-${Date.now()}`);
  const { stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    cwd: guardedDir,
    requestedCwd: requested,
  });
  const notice = markers(stdout, 'CONTENT_DELTA')
    .map(decodeStringMarker)
    .find((t) => String(t).startsWith('[Notice] Working directory substituted'));
  assert.ok(notice, 'the clamped substitution must never be silent');
  assert.ok(notice.includes(requested), `names the requested dir: ${notice}`);
  assert.match(notice, /\(directory does not exist\)\./);
  const turnDeltas = markers(stdout, 'CONTENT_DELTA').map(decodeStringMarker)
    .filter((t) => !String(t).startsWith('[Notice]'));
  assert.ok(turnDeltas.length > 0, 'the turn still streams after the notice');
});

test('requestedCwd equal to cwd produces no notice', async () => {
  const safeDir = makeTempDir('gemini-cwd-same-');
  const { stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    cwd: safeDir,
    requestedCwd: safeDir,
  });
  const notices = markers(stdout, 'CONTENT_DELTA')
    .map(decodeStringMarker)
    .filter((t) => String(t).startsWith('[Notice]'));
  assert.equal(notices.length, 0, JSON.stringify(notices));
});

test('bridge directory request is substituted VISIBLY (AC5, NFR2)', async () => {
  const { stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    cwd: BRIDGE_DIR.replace(/\/$/, ''),
  });
  const notices = markers(stdout, 'CONTENT_DELTA').map(decodeStringMarker);
  const notice = notices.find((t) => String(t).startsWith('[Notice] Working directory substituted'));
  assert.ok(notice, 'substitution must never be silent');
  assert.ok(notice.includes(BRIDGE_DIR.replace(/\/$/, '')), `names the requested dir: ${notice}`);
  assert.match(notice, /\(plugin-internal directory\)\./);
  const used = notice.match(/using "([^"]+)"/)[1];
  assert.notEqual(used, BRIDGE_DIR.replace(/\/$/, ''));
});

test('non-existent directory request is substituted VISIBLY (AC5)', async () => {
  const missing = join(tmpdir(), `gemini-missing-${Date.now()}-x`);
  const { stdout } = await runService({ fixture: 'text-turn-error-result.jsonl', cwd: missing });
  const notice = markers(stdout, 'CONTENT_DELTA')
    .map(decodeStringMarker)
    .find((t) => String(t).startsWith('[Notice] Working directory substituted'));
  assert.ok(notice, 'substitution must never be silent');
  assert.ok(notice.includes(missing));
  assert.match(notice, /\(directory does not exist\)\./);
});

test('error_message steps are logged to stderr, not passed silently (P-3d)', async () => {
  const { stdout, stderr } = await runService({ fixture: 'text-turn-error-result.jsonl', exitCode: 0 });
  assert.match(stderr, /\[gemini\] error_message step:/);
  // The turn itself is unaffected — stdout stays pure protocol.
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
});

test('sentinel cwd values are normalized without a notice', async () => {
  for (const sentinel of ['undefined', 'null', '']) {
    const { stdout } = await runService({ fixture: 'text-turn-error-result.jsonl', cwd: sentinel });
    const notices = markers(stdout, 'CONTENT_DELTA')
      .map(decodeStringMarker)
      .filter((t) => String(t).startsWith('[Notice]'));
    assert.equal(notices.length, 0, `sentinel=${sentinel}`);
    assert.equal(markers(stdout, 'STREAM_END').length, 1);
  }
});

test('an existing session id is echoed before spawn for multi-turn resume', async () => {
  const { stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    sessionId: '2ac96d6e-db37-4187-b143-6f64975415c8',
  });
  const sessionIds = markers(stdout, 'SESSION_ID');
  assert.equal(sessionIds[0], '[SESSION_ID] 2ac96d6e-db37-4187-b143-6f64975415c8');
});

test('CLI resolution failure leaves a well-formed stream (P-1)', async () => {
  const { code, stdout, stderr } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    geminiBin: join(TMP_DIR, 'no-such-agy-binary'),
  });
  const lines = protocolLines(stdout);
  assert.equal(lines[0], '[MESSAGE_START]');
  assert.equal(lines[1], '[STREAM_START]', 'stream markers must open before any failure');
  const sendErrors = markers(stdout, 'SEND_ERROR');
  assert.equal(sendErrors.length, 1, JSON.stringify(lines));
  assert.match(JSON.parse(sendErrors[0].slice('[SEND_ERROR]'.length)).error, /CLI not found/);
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
  assert.equal(markers(stdout, 'MESSAGE_END').length, 1);
  const endIndex = lines.findIndex((l) => l === '[STREAM_END]');
  assert.ok(
    lines.findIndex((l) => l.startsWith('[SEND_ERROR]')) < endIndex,
    '[SEND_ERROR] must precede the stream end'
  );
  // R-6: spawn failures emit the final failure payload too.
  const spawnPayload = finalPayload(stdout);
  assert.equal(spawnPayload.success, false, 'spawn failure surfaces via [SEND_ERROR] and the payload');
  assert.match(spawnPayload.error, /CLI not found/);
  assert.equal(spawnPayload.details.status, 'CLI_ERROR');
  assert.equal(code, 0, 'failure path still exits cleanly so stdout flushes');
  assert.ok(stderr.length > 0, 'diagnostics go to stderr');
});

test('a stream that closes without a result event fails loudly (P-2)', async () => {
  const { stdout } = await runService({ fixture: 'no-result-early-exit.jsonl', exitCode: 0 });
  const sendErrors = markers(stdout, 'SEND_ERROR');
  assert.equal(sendErrors.length, 1, 'exit 0 with no result must not be a silent dead turn');
  assert.match(
    JSON.parse(sendErrors[0].slice('[SEND_ERROR]'.length)).error,
    /ended without a result payload/
  );
  const payload = finalPayload(stdout);
  assert.equal(payload.success, false);
  assert.equal(payload.details.status, 'NO_RESULT');
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
  assert.equal(markers(stdout, 'MESSAGE_END').length, 1);
});

// A non-temp "project" dir for env-based workspace resolution: mkdtemp under
// the OS temp root would itself be skipped as a temp candidate, so the project
// anchor for these tests lives under the real home dir (removed in after()).
function makeProjectLikeDir() {
  return makeTempDirAt(homedir(), 'gemini-cwd-proj-');
}

test('a temp-dir workspace request names the reason "temporary directory" (R-2, AC5)', async () => {
  const projectDir = makeProjectLikeDir();
  const tempWorkspace = makeTempDir('gemini-cwd-temp-');
  const { stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    cwd: tempWorkspace,
    extraEnv: { IDEA_PROJECT_PATH: projectDir },
  });
  const notice = markers(stdout, 'CONTENT_DELTA')
    .map(decodeStringMarker)
    .find((t) => String(t).startsWith('[Notice] Working directory substituted'));
  assert.ok(notice, 'a temp workspace must never be used silently');
  assert.ok(notice.includes(tempWorkspace), `names the requested dir: ${notice}`);
  assert.match(notice, /\(temporary directory\)\./);
  const used = notice.match(/using "([^"]+)"/)[1];
  assert.equal(used, projectDir, 'the turn still runs in the env project dir');
});

test('blank cwd lands on the env project dir, never the bridge dir (R-10)', async () => {
  const projectDir = makeProjectLikeDir();
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    cwd: '',
    echoCwd: true,
    extraEnv: { IDEA_PROJECT_PATH: projectDir },
  });
  const cwdLine = stderr.split('\n').find((l) => l.startsWith('CWD:'));
  assert.ok(cwdLine, `fake CLI must echo its cwd: ${stderr.slice(0, 400)}`);
  assert.equal(cwdLine.slice('CWD:'.length), projectDir, 'env project path wins for a blank cwd');
  const notices = markers(stdout, 'CONTENT_DELTA').map(decodeStringMarker)
    .filter((t) => String(t).startsWith('[Notice]'));
  assert.equal(notices.length, 0, JSON.stringify(notices));
  assert.equal(finalPayload(stdout).success, true);
});

test('blank cwd with no project env falls through to home, never the bridge dir (R-10)', async () => {
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    cwd: '',
    echoCwd: true,
  });
  const cwdLine = stderr.split('\n').find((l) => l.startsWith('CWD:'));
  assert.ok(cwdLine, `fake CLI must echo its cwd: ${stderr.slice(0, 400)}`);
  const used = cwdLine.slice('CWD:'.length);
  const bridgeDir = BRIDGE_DIR.replace(/\/$/, '');
  assert.notEqual(
    normalize(used), normalize(bridgeDir),
    'the runner child starts in the bridge dir — it must never be chosen'
  );
  assert.equal(normalize(used), normalize(getRealHomeDir()), 'home is the fallback workspace');
  assert.equal(finalPayload(stdout).success, true);
});

test('a post-result CLI error is logged but does not override the delivered result (R-4, R-5)', async () => {
  // SUCCESS result on stdout, then a nonzero exit with stderr output: the
  // result branch already emitted its terminal markers + payload, so the late
  // error must only surface on stderr.
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 1,
    stderr: 'agy: late warning\n',
  });
  assert.equal(markers(stdout, 'SEND_ERROR').length, 0, 'no [SEND_ERROR] after a delivered result');
  assert.deepEqual(finalPayload(stdout), {
    success: true,
    sessionId: '6f1c2a54-93b7-4c0e-8a41-7d2e5b9c1a01',
  }, 'the success payload is not overwritten');
  assert.match(stderr, /post-result CLI error \(ignored\):/);
  assert.match(stderr, /gemini CLI exited with code 1[\s\S]*agy: late warning/);
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
  assert.equal(markers(stdout, 'MESSAGE_END').length, 1);
});

test('a relative requestedCwd resolves against the selected workspace (R-7)', async () => {
  const safeDir = makeTempDir('gemini-cwd-rel-');
  const { stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    cwd: safeDir,
    requestedCwd: 'relative-sub',
  });
  const notice = markers(stdout, 'CONTENT_DELTA')
    .map(decodeStringMarker)
    .find((t) => String(t).startsWith('[Notice] Working directory substituted'));
  assert.ok(notice, 'a request for a missing subdir is still a substitution');
  assert.ok(
    notice.includes(resolve(safeDir, 'relative-sub')),
    `names the RESOLVED absolute path, not the raw relative one: ${notice}`
  );
  assert.doesNotMatch(notice, /requested "relative-sub"/);
  assert.match(notice, /\(directory does not exist\)\./);
});

test('non-image attachments are announced and the turn continues (R-9)', async () => {
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'notes.txt', mediaType: 'text/plain', data: 'data:text/plain;base64,aGVsbG8=' },
    { fileName: 'shot.png', mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });
  // The old stderr-only log was superseded by the visible notice layer
  // (Story 1.6): stderr keeps a diagnostic line, and the user-facing
  // announcement goes out on the protocol stream.
  assert.match(stderr, /\[gemini\] attachment not delivered: notes\.txt \(only image attachments are supported\)/);
  assert.equal(attachmentNoticeFor(stdout, 'notes.txt'), noticeFor('notes.txt', REASON_NON_IMAGE));
  const argvLine = stderr.split('\n').find((l) => l.startsWith('ARGV:'));
  const argv = JSON.parse(argvLine.slice('ARGV:'.length));
  const prompt = argv[argv.indexOf('-p') + 1];
  assert.match(prompt, /hello world/, 'text prompt intact');
  assert.match(prompt, /\[Image #1: /, 'the image sibling still materializes');
  assert.equal(finalPayload(stdout).success, true);
});

test('a second result event never re-runs the terminal branch (P-4)', async () => {
  const { stdout } = await runService({ fixture: 'double-result.jsonl', exitCode: 0 });
  const sendErrors = markers(stdout, 'SEND_ERROR');
  assert.equal(sendErrors.length, 1);
  assert.match(JSON.parse(sendErrors[0].slice('[SEND_ERROR]'.length)).error, /first failure wins/);
  const payload = finalPayload(stdout);
  assert.equal(payload.success, false, 'the late SUCCESS must not overwrite the terminal failure');
  assert.equal(payload.details.rawError, 'first failure wins');
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
});

test('result.response (model prose) never becomes the error cause (P-5)', async () => {
  const { stdout, stderr } = await runService({ fixture: 'error-response-only.jsonl', exitCode: 0 });
  const sendError = JSON.parse(markers(stdout, 'SEND_ERROR')[0].slice('[SEND_ERROR]'.length));
  assert.equal(sendError.error, 'Turn failed with status: ERROR');
  assert.doesNotMatch(sendError.error, /moon is full/);
  // the prose is still available for diagnosis — on stderr, not in the error
  assert.match(stderr, /result\.response:.*moon is full/);
  const payload = finalPayload(stdout);
  assert.equal(payload.details.rawError, 'Turn failed with status: ERROR');
});

test('replays a SUCCESS turn: success payload, no error markers (P-9)', async () => {
  const { stdout } = await runService({ fixture: 'success-text-turn.jsonl', exitCode: 0 });
  const payload = finalPayload(stdout);
  assert.deepEqual(payload, { success: true, sessionId: '6f1c2a54-93b7-4c0e-8a41-7d2e5b9c1a01' });
  assert.equal(markers(stdout, 'SEND_ERROR').length, 0);
  const deltas = markers(stdout, 'CONTENT_DELTA').map(decodeStringMarker);
  assert.ok(deltas.includes('All done.\n'), JSON.stringify(deltas));
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
});

test('replays a multi-delta turn: deltas arrive progressively and in order (P-9)', async () => {
  const { stdout } = await runService({ fixture: 'multi-delta-streaming.jsonl', exitCode: 0 });
  const lines = protocolLines(stdout);
  const deltas = markers(stdout, 'CONTENT_DELTA').map(decodeStringMarker);
  assert.deepEqual(
    deltas,
    ['Step one', ', step two', ', step three.', '\n'],
    'each ACTIVE agent_response delta must be forwarded as it arrives'
  );
  // progressive render proof: every delta precedes the terminal markers
  const endIndex = lines.findIndex((l) => l === '[STREAM_END]');
  for (const delta of markers(stdout, 'CONTENT_DELTA')) {
    assert.ok(lines.indexOf(delta) < endIndex, 'delta must render before stream end');
  }
  const payload = finalPayload(stdout);
  assert.equal(payload.success, true);
});

test('replays a status INVALID turn: failure payload carries the status (P-9)', async () => {
  const { stdout } = await runService({ fixture: 'invalid-status.jsonl', exitCode: 0 });
  const sendError = JSON.parse(markers(stdout, 'SEND_ERROR')[0].slice('[SEND_ERROR]'.length));
  assert.match(sendError.error, /request was rejected as invalid/);
  const payload = finalPayload(stdout);
  assert.equal(payload.success, false);
  assert.equal(payload.details.status, 'INVALID');
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
});

test('replays a multi-tool turn: dedup + ordering preserved (P-3c, P-9)', async () => {
  const { stdout } = await runService({ fixture: 'multi-tool-turn.jsonl', exitCode: 0 });
  const messages = messageMarkers(stdout);

  const toolUse = messages.filter((m) => m.type === 'tool_use');
  assert.deepEqual(toolUse.map((m) => m.id), ['1', '2']);
  assert.deepEqual(toolUse.map((m) => m.name), ['list_dir', 'write_to_file']);

  const toolResults = messages.filter((m) => m.type === 'tool_result');
  assert.equal(toolResults.length, 2, 'the repeated DONE must not emit a second tool_result');
  assert.deepEqual(toolResults.map((m) => m.tool_use_id), ['1', '2']);
  assert.equal(toolResults[0].is_error, false);
  assert.match(toolResults[0].content, /a\.txt/);

  // ordering: use(1) < result(1) < use(2) < result(2)
  const order = messages.map((m) => `${m.type}:${m.type === 'tool_use' ? m.id : m.tool_use_id}`);
  assert.deepEqual(order, ['tool_use:1', 'tool_result:1', 'tool_use:2', 'tool_result:2']);
  assert.equal(finalPayload(stdout).success, true);
});

test('unnamed tool steps get unique ids and stay paired (P-3a, P-3b)', async () => {
  const { stdout } = await runService({ fixture: 'tool-unnamed-steps.jsonl', exitCode: 0 });
  const messages = messageMarkers(stdout);

  const toolUse = messages.filter((m) => m.type === 'tool_use');
  assert.deepEqual(toolUse.map((m) => m.id), ['tool-1', 'tool-2'], 'fallback ids must be unique per tool');

  const toolResults = messages.filter((m) => m.type === 'tool_result');
  assert.deepEqual(toolResults.map((m) => m.tool_use_id), ['tool-1', 'tool-2']);
  assert.equal(toolResults[1].is_error, true, 'the ERROR-state unnamed tool still closes');
  assert.match(toolResults[1].content, /TOOL_ERROR: denied/);
  assert.equal(finalPayload(stdout).success, true);
});

test('interleaved unnamed tools pair in start order, not most-recent-wins (R-3)', async () => {
  // ACTIVE a, ACTIVE b, DONE (a), ERROR (b) — none carries a step_index. The
  // first terminal state must close the FIRST tool, not the latest one.
  const { stdout } = await runService({ fixture: 'tool-unnamed-interleaved.jsonl', exitCode: 0 });
  const messages = messageMarkers(stdout);

  const toolUse = messages.filter((m) => m.type === 'tool_use');
  assert.deepEqual(toolUse.map((m) => m.id), ['tool-1', 'tool-2'], 'each ACTIVE step introduces one tool');

  const toolResults = messages.filter((m) => m.type === 'tool_result');
  assert.deepEqual(toolResults.map((m) => m.tool_use_id), ['tool-1', 'tool-2'], 'FIFO pairing');
  assert.equal(toolResults[0].is_error, false, 'DONE pairs with the first ACTIVE (read_file)');
  assert.match(toolResults[0].content, /alpha/);
  assert.equal(toolResults[1].is_error, true, 'ERROR pairs with the second ACTIVE (run_command)');
  assert.match(toolResults[1].content, /TOOL_ERROR: denied/);
  assert.equal(finalPayload(stdout).success, true);
});

test('a materialized image attachment reaches the prompt (P-9 glue)', async () => {
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'shot.png', mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });

  const argvLine = stderr.split('\n').find((l) => l.startsWith('ARGV:'));
  assert.ok(argvLine, `fake CLI must echo its argv: ${stderr.slice(0, 400)}`);
  const argv = JSON.parse(argvLine.slice('ARGV:'.length));
  const prompt = argv[argv.indexOf('-p') + 1];
  assert.match(prompt, /\[Image #1: /);
  assert.match(prompt, /cc-gui-cli-images/);
  assert.match(prompt, /shot\.png/);
  assert.match(prompt, /hello world/);
  assert.equal(finalPayload(stdout).success, true);
});

test('a failed materialization logs to stderr and the turn continues without images (P-9)', async () => {
  // 3 MB of base64 decodes past the 2 MB soft cap -> skipped with a stderr log.
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'huge.png', mediaType: 'image/png', data: `data:image/png;base64,${'A'.repeat(3_000_000)}` },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });

  assert.match(stderr, /\[cli-image\] skip oversized image/);
  const argvLine = stderr.split('\n').find((l) => l.startsWith('ARGV:'));
  const argv = JSON.parse(argvLine.slice('ARGV:'.length));
  const prompt = argv[argv.indexOf('-p') + 1];
  assert.equal(prompt, 'hello world', 'no image refs when nothing materialized');
  assert.equal(finalPayload(stdout).success, true, 'the turn is not blocked by the failure');
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
});

// -------------------------------------------------------------------------
// Code review loop 3 (2026-09-03) — regression pins for the review patches.
// -------------------------------------------------------------------------

test('a trailing-slash requestedCwd is not a substitution (code review 3)', async () => {
  const safeDir = makeTempDir('gemini-cwd-slash-');
  const { stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    cwd: safeDir,
    requestedCwd: `${safeDir}/`,
  });
  const notices = markers(stdout, 'CONTENT_DELTA')
    .map(decodeStringMarker)
    .filter((t) => String(t).startsWith('[Notice]'));
  assert.equal(notices.length, 0, JSON.stringify(notices));
});

test('a SUCCESS turn without streamed deltas falls back to result.response (code review 3)', async () => {
  const { stdout } = await runService({ fixture: 'success-no-deltas.jsonl', exitCode: 0 });
  const deltas = markers(stdout, 'CONTENT_DELTA').map(decodeStringMarker);
  assert.ok(
    deltas.includes('Recovered from a delta-less turn.'),
    `result text must render when no text_delta step arrived: ${JSON.stringify(deltas)}`
  );
  assert.equal(markers(stdout, 'SEND_ERROR').length, 0);
  const payload = finalPayload(stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.sessionId, '7ab21c90-1111-4c0e-8a41-7d2e5b9c1a01');
});

test('a tool still ACTIVE when the result arrives is closed as interrupted (code review 3)', async () => {
  const { stdout } = await runService({ fixture: 'tool-active-no-terminal.jsonl', exitCode: 0 });
  const messages = messageMarkers(stdout);
  const toolUse = messages.filter((m) => m.type === 'tool_use');
  assert.equal(toolUse.length, 1);
  const toolResults = messages.filter((m) => m.type === 'tool_result');
  assert.equal(toolResults.length, 1, 'no dangling tool bubble at stream end');
  assert.equal(toolResults[0].tool_use_id, toolUse[0].id);
  assert.equal(toolResults[0].is_error, true);
  assert.match(toolResults[0].content, /interrupted/);
  assert.equal(finalPayload(stdout).success, true);
});

test('a resumed turn does not re-emit an unchanged session id (code review 3)', async () => {
  // The pre-spawn echo and the init conversation_id are the SAME fact — the
  // webview must hear it once, not twice. (Fixture init id == resumed id.)
  const { stdout } = await runService({
    fixture: 'text-turn-error-result.jsonl',
    sessionId: '299cd332-7948-4a22-b015-e3dffd1bb939',
  });
  const sessionIds = markers(stdout, 'SESSION_ID');
  assert.equal(sessionIds.length, 1, JSON.stringify(sessionIds));
});

// -------------------------------------------------------------------------
// Story 1.3 — multi-turn continuity & conversation lifecycle (AC1, AC5)
// -------------------------------------------------------------------------

/** The fake CLI's echoed argv (spawn arguments of the agy child). */
function fakeChildArgv(stderr) {
  const argvLine = stderr.split('\n').find((l) => l.startsWith('ARGV:'));
  assert.ok(argvLine, `fake CLI must echo its argv: ${stderr.slice(0, 400)}`);
  return JSON.parse(argvLine.slice('ARGV:'.length));
}

const CONVERSATION_A = '6f1c2a54-93b7-4c0e-8a41-7d2e5b9c1a01';
const CONVERSATION_B = 'b4e1f7a2-3c58-4d0e-9a21-6f7b8c2d5e94';

test('a follow-up in the same tab resumes the prior conversation via --conversation (AC1)', async () => {
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    sessionId: CONVERSATION_A,
    echoArgv: true,
  });

  const argv = fakeChildArgv(stderr);
  const resumeAt = argv.indexOf('--conversation');
  assert.notEqual(resumeAt, -1, `follow-up must pass --conversation: ${JSON.stringify(argv)}`);
  assert.equal(argv[resumeAt + 1], CONVERSATION_A);
  // Continuity is EXPLICIT-id only: -c/--continue resolves to the CLI's most
  // recent conversation anywhere on disk and could jump into another
  // project's/tab's conversation (Story 1.3 Dev Notes) — never pass it.
  assert.equal(argv.includes('-c'), false, JSON.stringify(argv));
  assert.equal(argv.includes('--continue'), false, JSON.stringify(argv));

  // The id is announced exactly once: the pre-spawn echo; the init event
  // carries the same id and is deduped.
  assert.deepEqual(markers(stdout, 'SESSION_ID'), [`[SESSION_ID] ${CONVERSATION_A}`]);
  assert.equal(finalPayload(stdout).success, true);
});

test('after a conversation reset the next turn starts a NEW conversation (AC5)', async () => {
  // Turn 1 (fresh session): no session id in the stdin payload, so no resume
  // flag — the CLI starts a new conversation and reports its id, which the
  // service announces to the webview.
  const first = await runService({ fixture: 'success-text-turn.jsonl', echoArgv: true });
  assert.equal(
    fakeChildArgv(first.stderr).includes('--conversation'),
    false,
    'a first turn must never resume',
  );
  assert.deepEqual(markers(first.stdout, 'SESSION_ID'), [`[SESSION_ID] ${CONVERSATION_A}`]);

  // A reset (new chat tab / provider switch / gemini model change) all reduce
  // to the same bridge-level fact by design — TEMPORAL isolation on the one
  // provider-agnostic session-id slot: the next send arrives with an EMPTY
  // session id. (The webview/Java side of each trigger is pinned by hook-level
  // tests; here we pin that an empty id can never resume anything.)
  const after = await runService({
    fixture: 'new-conversation-after-reset.jsonl',
    sessionId: '',
    echoArgv: true,
  });

  const argv = fakeChildArgv(after.stderr);
  assert.equal(argv.includes('--conversation'), false, `no residual resume: ${JSON.stringify(argv)}`);
  assert.notEqual(CONVERSATION_B, CONVERSATION_A, 'fixture sanity: the two ids differ');
  // The fresh conversation's id is announced exactly once, and it is the one
  // the final payload reports back to Java's session slot.
  assert.deepEqual(markers(after.stdout, 'SESSION_ID'), [`[SESSION_ID] ${CONVERSATION_B}`]);
  assert.equal(finalPayload(after.stdout).sessionId, CONVERSATION_B);
});

// -------------------------------------------------------------------------
// Story 1.6 — image attachments: visible non-delivery notices (CAP-7, C10)
//
// Delivery (materialize + [Image #N: path] prompt injection + cleanup) is
// already wired since Story 1.2 (verify-only); what is NEW here is the
// visible layer: today a rejected attachment only console.errors on stderr
// while the user watches their file silently vanish. The contract below
// reuses the workspace-substitution channel — a pre-spawn [CONTENT_DELTA]
// notice — and a closed English reason set the webview localizes verbatim
// (localizationUtils.test.ts pins the same literals against this source).
//
// Size expectations derive from GROK_MAX_IMAGE_BYTES (the shared 2 MB per-
// image cap, C10), never a hand-typed literal. Corrupt-data nuance:
// Buffer.from(base64, 'base64') never throws — "invalid" means an empty
// payload or a zero-length decode, so tests target that, not an exception.
// -------------------------------------------------------------------------

/** The shared per-image cap, expressed the way the notice names it. */
const SIZE_LIMIT_MB = GROK_MAX_IMAGE_BYTES / (1024 * 1024);

/** The closed English reason set — kept in lockstep with localizationUtils.test.ts. */
const REASON_NON_IMAGE = 'only image attachments are supported';
const REASON_TOO_LARGE = `image exceeds the ${SIZE_LIMIT_MB} MB per-image limit`;
const REASON_INVALID = 'image data is missing or unreadable';

const ATTACHMENT_NOTICE_PREFIX = '[Notice] Attachment not delivered: ';

function noticeFor(name, reason) {
  return `${ATTACHMENT_NOTICE_PREFIX}"${name}" (${reason}).\n\n`;
}

/** All decoded attachment non-delivery notices on the protocol stream. */
function attachmentNotices(stdout) {
  return markers(stdout, 'CONTENT_DELTA')
    .map(decodeStringMarker)
    .map(String)
    .filter((t) => t.startsWith(ATTACHMENT_NOTICE_PREFIX));
}

function attachmentNoticeFor(stdout, fileName) {
  return attachmentNotices(stdout).find((t) => t.includes(`"${fileName}"`));
}

/** The [Image #N: path] references the service injected into the prompt. */
function imageRefPaths(prompt) {
  return [...String(prompt).matchAll(/\[Image #\d+: ([^\]]+)\]/g)].map((m) => m[1]);
}

function spawnedPrompt(stderr) {
  const argv = fakeChildArgv(stderr);
  return argv[argv.indexOf('-p') + 1] || '';
}

/** IMGSTAT echo: what the spawned "CLI" saw on disk for each image ref. */
function imageStats(stderr) {
  const line = stderr.split('\n').find((l) => l.startsWith('IMGSTAT:'));
  assert.ok(line, `fake CLI must echo image stats: ${stderr.slice(0, 400)}`);
  return JSON.parse(line.slice('IMGSTAT:'.length));
}

// 1x1 PNG (same bytes cli-image-input.test.js uses).
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_B64, 'base64').length;

test('Story 1.6 AC1: a valid image is materialized, referenced in the prompt, and cleaned up', async () => {
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'shot.png', mediaType: 'image/png', data: `data:image/png;base64,${TINY_PNG_B64}` },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
    echoImageStats: true,
  });

  // The model side receives the image as a file it can read: the prompt
  // references it and the file truly existed while the CLI ran.
  const stats = imageStats(stderr);
  assert.equal(stats.length, 1, JSON.stringify(stats));
  assert.equal(stats[0].exists, true, 'the referenced file must be materialized on disk');
  assert.equal(stats[0].size, TINY_PNG_BYTES, 'the materialized file holds the decoded bytes');
  assert.ok(stats[0].size <= GROK_MAX_IMAGE_BYTES, 'within the shared per-image cap');
  assert.match(stats[0].path, /cc-gui-cli-images/);
  assert.match(stats[0].path, /shot\.png/);

  const prompt = spawnedPrompt(stderr);
  assert.match(prompt, /\[Image #1: /);
  assert.ok(prompt.includes(stats[0].path), `prompt references the materialized path: ${prompt}`);
  assert.ok(prompt.includes('hello world'), 'user text survives the injection');

  // Temp hygiene: the finally-cleanup removes the file once the turn ends.
  assert.equal(existsSync(stats[0].path), false, 'cleanupMaterializedImagePaths must run after the turn');

  assert.equal(attachmentNotices(stdout).length, 0, 'a delivered image must not produce a notice');
  assert.equal(finalPayload(stdout).success, true);
});

test('Story 1.6 AC2: an explicitly non-image attachment surfaces a visible non-delivery notice', async () => {
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'notes.txt', mediaType: 'text/plain', data: 'data:text/plain;base64,aGVsbG8=' },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });

  // Zero silent drops: the user must SEE that notes.txt was not delivered and
  // why — stderr logging alone is exactly the gap this story closes.
  const notices = attachmentNotices(stdout);
  assert.equal(notices.length, 1, `expected exactly one notice, got: ${JSON.stringify(notices)}`);
  assert.equal(notices[0], noticeFor('notes.txt', REASON_NON_IMAGE));

  // The notice is the LEADING content delta — heard before any answer text.
  const lines = protocolLines(stdout);
  const noticeIndex = lines.findIndex(
    (l) => l.startsWith('[CONTENT_DELTA]') && String(decodeStringMarker(l)).startsWith(ATTACHMENT_NOTICE_PREFIX)
  );
  const firstTurnDeltaIndex = lines.findIndex(
    (l) => l.startsWith('[CONTENT_DELTA]') && !String(decodeStringMarker(l)).startsWith(ATTACHMENT_NOTICE_PREFIX)
  );
  assert.notEqual(noticeIndex, -1, 'notice present on the stream');
  assert.notEqual(firstTurnDeltaIndex, -1, 'the turn itself still streams');
  assert.ok(noticeIndex < firstTurnDeltaIndex, 'the notice must precede the answer');

  // Nothing image-like reaches the prompt; the text still sends.
  assert.equal(spawnedPrompt(stderr), 'hello world', 'a rejected attachment must not inject a path reference');
  assert.equal(finalPayload(stdout).success, true, 'the turn is not blocked by the rejection');
});

test('Story 1.6 AC3: an over-cap image surfaces a visible notice naming the file and the fixed limit', async () => {
  // Decodes to just past the shared cap (derived from the constant, C10).
  const overCap = Buffer.alloc(GROK_MAX_IMAGE_BYTES + 1024, 0x50).toString('base64');
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'huge.png', mediaType: 'image/png', data: overCap },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });

  const notices = attachmentNotices(stdout);
  assert.equal(notices.length, 1, `expected exactly one notice, got: ${JSON.stringify(notices)}`);
  // NFR10: the notice names the file AND the fixed per-image limit.
  assert.equal(notices[0], noticeFor('huge.png', REASON_TOO_LARGE));
  assert.ok(notices[0].includes(`${SIZE_LIMIT_MB} MB`), `must name the ${SIZE_LIMIT_MB} MB limit: ${notices[0]}`);
  assert.ok(notices[0].includes('huge.png'));

  assert.equal(spawnedPrompt(stderr), 'hello world', 'the oversized image must not reach the prompt');
  assert.equal(finalPayload(stdout).success, true);
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
});

test('Story 1.6 AC4: missing or undecodable image data surfaces a visible invalid-data notice', async () => {
  const attachmentsFile = writeAttachmentsFile([
    // empty payload — parseAttachmentData returns null
    { fileName: 'broken.png', mediaType: 'image/png', data: '' },
    // undecodable: Buffer.from('!!!!', 'base64') never throws — it decodes to
    // ZERO bytes, which is the invalid-data contract (no exception path).
    { fileName: 'junk.png', mediaType: 'image/png', data: '!!!!' },
    // malformed entry (non-object) — cannot be an image either
    'not-an-attachment-object',
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });

  const notices = attachmentNotices(stdout);
  assert.equal(notices.length, 3, `one notice per rejected attachment, got: ${JSON.stringify(notices)}`);
  assert.equal(attachmentNoticeFor(stdout, 'broken.png'), noticeFor('broken.png', REASON_INVALID));
  assert.equal(attachmentNoticeFor(stdout, 'junk.png'), noticeFor('junk.png', REASON_INVALID));
  const unnamed = notices.find((n) => !n.includes('broken.png') && !n.includes('junk.png'));
  assert.ok(unnamed && unnamed.includes(REASON_INVALID), `the malformed entry must produce its own notice: ${JSON.stringify(notices)}`);

  assert.equal(spawnedPrompt(stderr), 'hello world', 'no path reference for data that never materialized');
  assert.equal(finalPayload(stdout).success, true);
});

test('Story 1.6 AC5: a mixed batch yields one notice per rejection and delivers the valid ones', async () => {
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'shot.png', mediaType: 'image/png', data: `data:image/png;base64,${TINY_PNG_B64}` },
    { fileName: 'notes.txt', mediaType: 'text/plain', data: 'data:text/plain;base64,aGVsbG8=' },
    { fileName: 'huge.png', mediaType: 'image/png', data: Buffer.alloc(GROK_MAX_IMAGE_BYTES + 1024, 0x50).toString('base64') },
    { fileName: 'broken.png', mediaType: 'image/png', data: '' },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
    echoImageStats: true,
  });

  // Every invalid one gets its OWN notice with its OWN reason.
  const notices = attachmentNotices(stdout);
  assert.equal(notices.length, 3, `got: ${JSON.stringify(notices)}`);
  assert.equal(attachmentNoticeFor(stdout, 'notes.txt'), noticeFor('notes.txt', REASON_NON_IMAGE));
  assert.equal(attachmentNoticeFor(stdout, 'huge.png'), noticeFor('huge.png', REASON_TOO_LARGE));
  assert.equal(attachmentNoticeFor(stdout, 'broken.png'), noticeFor('broken.png', REASON_INVALID));

  // The valid one is still delivered — and the [Image #N] list contains
  // EXACTLY the successfully materialized files (renumbered over delivered
  // files only, honesty guard from Task 3).
  const prompt = spawnedPrompt(stderr);
  const stats = imageStats(stderr);
  assert.equal(stats.length, 1, `only the valid image materializes: ${JSON.stringify(stats)}`);
  assert.deepEqual(imageRefPaths(prompt), [stats[0].path], `prompt must reference exactly the delivered file: ${prompt}`);
  assert.match(prompt, /\[Image #1: /);
  for (const rejected of ['notes.txt', 'huge.png', 'broken.png']) {
    assert.ok(!prompt.includes(rejected), `rejected ${rejected} must not be referenced in the prompt`);
  }
  assert.ok(prompt.includes('hello world'));

  assert.equal(finalPayload(stdout).success, true);
});

test('Story 1.6: when every attachment is rejected the turn still sends the plain text message', async () => {
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'notes.txt', mediaType: 'text/plain', data: 'data:text/plain;base64,aGVsbG8=' },
    { fileName: 'broken.png', mediaType: 'image/png', data: '' },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });

  assert.equal(attachmentNotices(stdout).length, 2, 'every rejected attachment gets its own notice');
  assert.equal(spawnedPrompt(stderr), 'hello world', 'text-only send: no image references at all');
  assert.equal(finalPayload(stdout).success, true);
  assert.equal(markers(stdout, 'STREAM_END').length, 1);
});

test('Story 1.6: an image exactly at the size cap is delivered with no notice (boundary)', async () => {
  // Decodes to EXACTLY GROK_MAX_IMAGE_BYTES: `> maxBytes` rejects, `==` passes.
  const atCap = Buffer.alloc(GROK_MAX_IMAGE_BYTES, 0x50).toString('base64');
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'exact.png', mediaType: 'image/png', data: atCap },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
    echoImageStats: true,
  });

  const stats = imageStats(stderr);
  assert.equal(stats.length, 1, JSON.stringify(stats));
  assert.equal(stats[0].exists, true);
  assert.equal(stats[0].size, GROK_MAX_IMAGE_BYTES, 'the boundary case must materialize in full');

  const prompt = spawnedPrompt(stderr);
  assert.match(prompt, /\[Image #1: /);
  assert.equal(attachmentNotices(stdout).length, 0, 'a delivered image is never announced as rejected');
  assert.equal(finalPayload(stdout).success, true);
  assert.equal(existsSync(stats[0].path), false, 'cleanup runs on the happy path too');
});

test('Story 1.6: an empty-hint attachment is treated as an image, never announced as non-image', async () => {
  // Paste/drop paths send image data with NO mediaType. The shared materializer
  // treats an empty hint as "assume image" — the notice layer must not
  // pre-announce such attachments as ignored (existing stderr-filter contract).
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'from-paste.bin', data: `data:image/png;base64,${TINY_PNG_B64}` },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });

  assert.equal(attachmentNotices(stdout).length, 0, JSON.stringify(attachmentNotices(stdout)));
  assert.equal(imageRefPaths(spawnedPrompt(stderr)).length, 1, 'delivered as an image');
  assert.equal(finalPayload(stdout).success, true);
});

test('Story 1.6 review M2: a path-bearing attachment is delivered, never announced as rejected', async () => {
  // codex-style local_image passthrough: the materializer pushes att.path
  // as-is with NO data payload at all — the notice layer must not demand data
  // that was never sent (it would pre-announce a delivered file as invalid).
  const dir = makeTempDir('gemini-path-att-');
  const existing = join(dir, 'pic.png');
  writeFileSync(existing, Buffer.from(TINY_PNG_B64, 'base64'));
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'pic.png', path: existing },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
    echoImageStats: true,
  });

  assert.equal(attachmentNotices(stdout).length, 0, JSON.stringify(attachmentNotices(stdout)));
  // The passthrough path itself is referenced as the image — and it truly
  // existed while the "CLI" ran (no materialized copy in the shared subdir).
  const stats = imageStats(stderr);
  assert.deepEqual(imageRefPaths(spawnedPrompt(stderr)), [existing]);
  assert.equal(stats.length, 1, JSON.stringify(stats));
  assert.equal(stats[0].exists, true, 'the passthrough path is delivered as-is');
  assert.equal(finalPayload(stdout).success, true);
});

test('Story 1.6 review M2: an EMPTY-STRING mediaType is authoritative assume-image even against a text/plain mimeType', async () => {
  // The materializer treats ANY string mediaType (including '') as the
  // authoritative hint — '' resolves through the data-URL mime to a delivered
  // image. The notice layer must not resolve the hint differently (an empty
  // string falling through to mimeType:'text/plain' would pre-announce a
  // delivered image as non-image — the two layers would disagree).
  const attachmentsFile = writeAttachmentsFile([
    { fileName: 'paste.png', mediaType: '', mimeType: 'text/plain', data: `data:image/png;base64,${TINY_PNG_B64}` },
  ]);
  const { stdout, stderr } = await runService({
    fixture: 'success-text-turn.jsonl',
    exitCode: 0,
    attachmentsFile,
    echoArgv: true,
  });

  assert.equal(attachmentNotices(stdout).length, 0, JSON.stringify(attachmentNotices(stdout)));
  assert.equal(imageRefPaths(spawnedPrompt(stderr)).length, 1, 'delivered as an image');
  assert.equal(finalPayload(stdout).success, true);
});

// ---------------------------------------------------------------------------
// Story 1.9 — token usage accounting (AC1–AC4).
//
// Canonical [USAGE] contract under test: exactly ONE marker per turn, sourced
// from the result payload (the backend's authoritative terminal figures),
// mapped to the wire shape every downstream consumer already reads (claude
// emitUsageTag names, what util/TokenUsageUtils.java and the webview footer's
// turnUsage reader consume): input_tokens / output_tokens /
// cache_creation_input_tokens / cache_read_input_tokens, plus an additive
// thinking_tokens. Raw CLI field names (cache_read_tokens) are NOT valid on
// the wire. Present fields map verbatim (a reported 0 stays 0); absent
// fields stay absent — nothing is invented (AC4), and a turn that reports no
// usable usage emits nothing at all (AC3 — a stored zero would read as a
// genuinely free turn, a lie).

test('Story 1.9 AC1: emits ONE canonical [USAGE] from the result payload — mapped fields, thinking carried, before stream end', async () => {
  const { stdout } = await runService({
    fixture: 'usage-full-turn.jsonl',
    exitCode: 0,
  });

  const lines = protocolLines(stdout);
  const usageLines = lines.filter((l) => l.startsWith('[USAGE]'));
  assert.equal(
    usageLines.length,
    1,
    `exactly one [USAGE] per turn (result payload is authoritative), got ${usageLines.length}: ${JSON.stringify(usageLines)}`,
  );
  const usage = JSON.parse(usageLines[0].slice('[USAGE]'.length));
  assert.equal(usage.input_tokens, 18814);
  assert.equal(usage.output_tokens, 208);
  assert.equal(usage.cache_read_input_tokens, 0, 'reported cache_read_tokens:0 maps to cache_read_input_tokens:0');
  assert.equal(usage.thinking_tokens, 207, 'thinking_tokens carries through additively');
  assert.ok(
    !('cache_read_tokens' in usage),
    `raw CLI key cache_read_tokens leaked onto the wire: ${JSON.stringify(usage)}`,
  );
  assert.ok(
    !('cache_creation_input_tokens' in usage),
    `absent cache_creation must stay absent (nothing invented): ${JSON.stringify(usage)}`,
  );
  assert.ok(
    !('total_tokens' in usage),
    `total_tokens (read by no consumer) must not be carried: ${JSON.stringify(usage)}`,
  );
  const usageIdx = lines.findIndex((l) => l.startsWith('[USAGE]'));
  const streamEndIdx = lines.findIndex((l) => l.startsWith('[STREAM_END]'));
  assert.ok(usageIdx !== -1 && streamEndIdx !== -1 && usageIdx < streamEndIdx, '[USAGE] must precede stream end');
  assert.equal(finalPayload(stdout).success, true);
});

test('Story 1.9 AC1/AC2: step-level usage defers to the result figures when they disagree', async () => {
  const { stdout } = await runService({
    fixture: 'usage-step-result-discrepancy.jsonl',
    exitCode: 0,
  });

  const usages = markers(stdout, 'USAGE').map((l) => JSON.parse(l.slice('[USAGE]'.length)));
  assert.equal(usages.length, 1, `result wins — one authoritative marker, got ${usages.length}: ${JSON.stringify(usages)}`);
  assert.equal(usages[0].input_tokens, 18814, 'result input_tokens, not the step interim 1042');
  assert.equal(usages[0].output_tokens, 208, 'result output_tokens, not the step interim 15');
  assert.equal(usages[0].thinking_tokens, 207, 'result thinking_tokens, not the step interim 8');
});

test('Story 1.9 AC3: an all-zero usage object emits nothing — a fabricated free turn is a lie', async () => {
  const { stdout } = await runService({
    fixture: 'usage-all-zero-result.jsonl',
    exitCode: 0,
  });

  const usages = markers(stdout, 'USAGE');
  assert.equal(usages.length, 0, `all-zero usage must not be emitted or stamped: ${JSON.stringify(usages)}`);
  assert.equal(finalPayload(stdout).success, true, 'the turn itself still completes normally');
});

test('Story 1.9 AC3 guard: a turn reporting no usage at all emits nothing and still closes cleanly', async () => {
  const { stdout } = await runService({
    fixture: 'usage-absent-turn.jsonl',
    exitCode: 0,
  });

  assert.equal(markers(stdout, 'USAGE').length, 0, 'no usage field → no [USAGE] marker');
  assert.equal(finalPayload(stdout).success, true);
});

test('Story 1.9 AC4 guard: partial fields pass through exactly — nothing invented for absent fields', async () => {
  const { stdout } = await runService({
    fixture: 'usage-partial-fields.jsonl',
    exitCode: 0,
  });

  const usages = markers(stdout, 'USAGE').map((l) => JSON.parse(l.slice('[USAGE]'.length)));
  assert.equal(usages.length, 1);
  assert.deepEqual(
    usages[0],
    { input_tokens: 100, output_tokens: 20 },
    'only the reported fields, verbatim — no cache/thinking/total defaults invented',
  );
});

// Review-fix round (M1): the result→step fallback chain was unpinned — every
// existing usage fixture with step usage also had positive result usage, so
// deleting `|| mapGeminiUsageToCanonical(lastStepUsage)` kept all tests green.

test('Story 1.9 M1: a usage-bearing final step is emitted when the result reports NO usage at all', async () => {
  const { stdout } = await runService({
    fixture: 'usage-step-only-result-absent.jsonl',
    exitCode: 0,
  });

  const usages = markers(stdout, 'USAGE').map((l) => JSON.parse(l.slice('[USAGE]'.length)));
  assert.equal(usages.length, 1, `exactly ONE marker — the step figure, got ${usages.length}: ${JSON.stringify(usages)}`);
  assert.deepEqual(
    usages[0],
    { input_tokens: 1042, output_tokens: 15, cache_read_input_tokens: 0, thinking_tokens: 8 },
    'the STEP figures carry through the canonical mapping',
  );
  assert.equal(finalPayload(stdout).success, true);
});

test('Story 1.9 M1: an all-zero result usage falls back to the step figures — one marker', async () => {
  const { stdout } = await runService({
    fixture: 'usage-all-zero-result-step-fallback.jsonl',
    exitCode: 0,
  });

  const usages = markers(stdout, 'USAGE').map((l) => JSON.parse(l.slice('[USAGE]'.length)));
  assert.equal(usages.length, 1, `exactly ONE marker, got ${usages.length}: ${JSON.stringify(usages)}`);
  assert.deepEqual(
    usages[0],
    { input_tokens: 1042, output_tokens: 15, cache_read_input_tokens: 0, thinking_tokens: 8 },
    'the step figures surface when the result maps to nothing usable',
  );
  assert.equal(finalPayload(stdout).success, true);
});

// Review-fix round (L3): a REPORTED cache_creation_input_tokens passes through
// verbatim (additive, honest AC4) instead of being silently dropped.

test('Story 1.9 L3: a reported cache_creation_input_tokens is carried verbatim', async () => {
  const { stdout } = await runService({
    fixture: 'usage-cache-creation-reported.jsonl',
    exitCode: 0,
  });

  const usages = markers(stdout, 'USAGE').map((l) => JSON.parse(l.slice('[USAGE]'.length)));
  assert.equal(usages.length, 1);
  assert.deepEqual(
    usages[0],
    { input_tokens: 500, output_tokens: 40, cache_creation_input_tokens: 30, cache_read_input_tokens: 0 },
    'reported cache_creation carried verbatim; raw cache_read_tokens still mapped; nothing invented',
  );
});

// Review-fix round (M2, bridge half): a turn with NO text_delta steps still
// emits its [USAGE]; the Java handler attaches it to THIS turn's message
// (pinned by usageMarkerOnTurnWithoutDeltasStampsThisTurnNotThePreviousOne).
// The result.response fallback delta keeps the bubble non-empty — the handler
// fills that same message, so the marker never lands on the previous turn.

test('Story 1.9 M2: a no-delta turn with usage still emits exactly ONE [USAGE] beside the fallback delta', async () => {
  const { stdout } = await runService({
    fixture: 'usage-no-delta-turn.jsonl',
    exitCode: 0,
  });

  const usages = markers(stdout, 'USAGE').map((l) => JSON.parse(l.slice('[USAGE]'.length)));
  assert.equal(usages.length, 1, `one marker for the no-delta turn, got ${usages.length}: ${JSON.stringify(usages)}`);
  assert.deepEqual(
    usages[0],
    { input_tokens: 700, output_tokens: 25, cache_read_input_tokens: 0, thinking_tokens: 0 },
    'reported zero thinking stays verbatim (present field), displayable figures carry the turn',
  );

  const lines = protocolLines(stdout);
  const fallbackIdx = lines.findIndex((l) => l.startsWith('[CONTENT_DELTA]'));
  assert.ok(fallbackIdx !== -1, 'the result.response fallback delta keeps the bubble non-empty');
  assert.equal(finalPayload(stdout).success, true);
});

// ─── Story 1.10: Turn Resilience — reap the dead, never the living ─────────
//
// The idle-silence watchdog does not exist yet: every RED test below fails
// today because NOTHING ever reaps a hung turn (the harness timeout has to
// kill the runner), and every GUARD passes today and must KEEP passing once
// the watchdog lands. The window travels through the production carriage
// GEMINI_IDLE_REAP_MINUTES (minutes; the settings UI sends integers, tests
// use fractional values like 0.05 → 3s so no test sleeps real minutes — the
// story forbids real-minute sleeps and an injectable-clock seam would test
// less of the real spawn/timer path). Fake-CLI modes keep a hard self-exit
// cap so a red-phase harness kill can never leak a detached fake process.

// The reap error's content contract (story Task 1/Task 4): what happened,
// the bound, likely causes, concrete remedies — never a bare "timeout", and
// it must beat the close handler's generic NO_RESULT wording.
function assertActionableReapMessage(stdout) {
  const errors = markers(stdout, 'SEND_ERROR')
    .map((l) => JSON.parse(l.slice('[SEND_ERROR]'.length)).error);
  assert.equal(errors.length, 1, `exactly one terminal error, got ${errors.length}: ${JSON.stringify(errors)}`);
  const text = String(errors[0]);
  assert.match(text, /no output|silent|silence/i, `must say WHAT happened (silence), got: ${text}`);
  assert.match(text, /minute|second/i, `must name the silence bound's time unit, got: ${text}`);
  assert.match(text, /auth|prompt|login|network|stall/i, `must name the likely cause (stuck prompt/auth or network stall), got: ${text}`);
  assert.match(text, /login|agy|setting|cancel|terminal|retry/i, `must name a concrete remedy, got: ${text}`);
  assert.ok(!/ended without a result payload/i.test(text), 'the reap message must win over the generic close-handler error');
  // Review fix L2: emitFailure runs the reap message through formatGeminiError.
  // If the wording ever trips isGeminiAuthError (it names authentication as a
  // likely cause), the classifier rewraps it into the "Gemini CLI
  // authentication required:" template and destroys the cause+remedy set.
  assert.ok(!/Gemini CLI authentication required/i.test(text),
    `the reap message must not be rewrapped by the auth classifier, got: ${text}`);
  return text;
}

test('Story 1.10 AC1/AC3: a turn silent past the idle window is reaped with an actionable message', async () => {
  const { stdout, timedOut } = await runService({
    mode: 'silent-hang',
    hangInit: true,
    extraEnv: { GEMINI_IDLE_REAP_MINUTES: '0.05' }, // 3s
    timeoutMs: 9000,
  });

  assert.equal(timedOut, false, 'the reap must end the turn on its own — instead the harness timeout had to kill it');
  assertActionableReapMessage(stdout);
  assert.equal(markers(stdout, 'STREAM_END').length, 1, 'the stream ends exactly once after the reap');
  const lines = protocolLines(stdout);
  const errorIdx = lines.findIndex((l) => l.startsWith('[SEND_ERROR]'));
  const endIdx = lines.findIndex((l) => l.startsWith('[STREAM_END]'));
  assert.ok(errorIdx !== -1 && endIdx !== -1 && errorIdx < endIdx, 'the reap error precedes the stream end');
});

test('Story 1.10 AC3/AC4: the reap kills the whole child tree — no orphaned grandchild survives', async () => {
  const gcPidFile = join(makeTempDir('gemini-reap-gc-'), 'gc.pid');
  const { stdout, timedOut } = await runService({
    mode: 'hang-with-grandchild',
    hangInit: true,
    extraEnv: { GEMINI_IDLE_REAP_MINUTES: '0.05' }, // 3s
    gcPidFile,
    timeoutMs: 9000,
  });

  assert.equal(timedOut, false, 'the reap must end the turn on its own — instead the harness timeout had to kill it');
  assert.equal(markers(stdout, 'SEND_ERROR').length, 1, 'the reap emits its terminal error');
  const gcPid = Number(readFileSync(gcPidFile, 'utf8').trim());
  assert.ok(gcPid > 0, 'the fake grandchild recorded its pid');
  const deadline = Date.now() + 5000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(gcPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, `the grandchild (pid ${gcPid}) must be dead after the tree-kill reap`);
});

test('Story 1.10 AC4: content streamed before the reap is retained and the turn ends exactly once', async () => {
  const { stdout, timedOut } = await runService({
    mode: 'delta-then-hang',
    hangInit: true,
    extraEnv: { GEMINI_IDLE_REAP_MINUTES: '0.05' }, // 3s
    timeoutMs: 9000,
  });

  assert.equal(timedOut, false, 'the reap must end the turn on its own — instead the harness timeout had to kill it');
  const deltas = markers(stdout, 'CONTENT_DELTA');
  assert.ok(deltas.length >= 2, `the turn streamed content before hanging, got ${deltas.length} deltas`);
  const lines = protocolLines(stdout);
  const lastDeltaIdx = lines.map((l) => l.startsWith('[CONTENT_DELTA]')).lastIndexOf(true);
  const errorIdx = lines.findIndex((l) => l.startsWith('[SEND_ERROR]'));
  assert.ok(lastDeltaIdx !== -1 && errorIdx !== -1 && lastDeltaIdx < errorIdx, 'the streamed deltas precede the reap error — the partial transcript is kept');
  assertActionableReapMessage(stdout);
  assert.equal(markers(stdout, 'STREAM_END').length, 1, 'the stream ends exactly once (partial content + reap error + one end)');
});

test('Story 1.10 AC2 guard: output within the window keeps the turn alive past a full window of total elapsed time', async () => {
  const { stdout, timedOut } = await runService({
    mode: 'slow-emit',
    emitKind: 'delta',
    emitIntervalMs: '500',
    emitLines: '8', // 8 × 500ms = 4s total elapsed > the 3s window; every gap 0.5s ≪ 3s
    extraEnv: { GEMINI_IDLE_REAP_MINUTES: '0.05' },
    timeoutMs: 15000,
  });

  assert.equal(timedOut, false, 'the turn must complete on its own');
  assert.equal(markers(stdout, 'SEND_ERROR').length, 0, 'silence alone never kills — and neither may total elapsed time');
  assert.equal(finalPayload(stdout).success, true, 'the turn completes normally');
});

test('Story 1.10 AC3 guard: unknown-but-parseable event lines also reset the silence window', async () => {
  const { stdout, timedOut } = await runService({
    mode: 'slow-emit',
    emitKind: 'unknown',
    emitIntervalMs: '500',
    emitLines: '8',
    extraEnv: { GEMINI_IDLE_REAP_MINUTES: '0.05' },
    timeoutMs: 15000,
  });

  assert.equal(timedOut, false, 'the turn must complete on its own');
  assert.equal(markers(stdout, 'SEND_ERROR').length, 0, 'every parsed line resets the watchdog, even unknown event types');
  assert.equal(finalPayload(stdout).success, true, 'the turn completes normally');
});

test('Story 1.10 AC5 guard: idleReapMinutes=0 disables automatic reaping — a hung turn is left alone', async () => {
  const { stdout, timedOut } = await runService({
    mode: 'silent-hang',
    hangInit: true,
    extraEnv: { GEMINI_IDLE_REAP_MINUTES: '0' },
    timeoutMs: 6000, // well past the 3s a non-zero window would have fired at
  });

  assert.equal(timedOut, true, 'the harness probe ends the run — the disabled watchdog must not have');
  const reapErrors = markers(stdout, 'SEND_ERROR').filter((l) => /no output|silent|silence/i.test(l));
  assert.equal(reapErrors.length, 0, `no reap error may appear while disabled, got: ${JSON.stringify(reapErrors)}`);
});

test('Story 1.10 Task 1 guard: no watchdog timer survives a normally completed turn', async () => {
  const started = Date.now();
  const { stdout, timedOut } = await runService({
    fixture: 'success-text-turn.jsonl',
    extraEnv: { GEMINI_IDLE_REAP_MINUTES: '0.1' }, // 6s: an armed-but-uncleared timer would hold the runner open past this
    timeoutMs: 15000,
  });
  const elapsedMs = Date.now() - started;

  assert.equal(timedOut, false, 'the completed turn releases the runner on its own');
  assert.ok(elapsedMs < 4000, `a completed turn must not be held open by an armed reap timer (resolved in ${elapsedMs}ms)`);
  assert.equal(finalPayload(stdout).success, true, 'and the turn itself completed normally');
});
