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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { getRealHomeDir } from '../../utils/path-utils.js';

const SERVICE_DIR = fileURLToPath(new URL('.', import.meta.url));
const SERVICE_PATH = join(SERVICE_DIR, 'message-service.js');
const FIXTURES_DIR = join(SERVICE_DIR, 'fixtures');
const BRIDGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

const FAKE_CLI_BODY = `
import fs from 'node:fs';
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
  process.env.SVC_REQUESTED_CWD || ''
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
  attachmentsFile = '',
  geminiBin = '',
  echoArgv = false,
  echoCwd = false,
  extraEnv = {},
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
  env.SERVICE_PATH = SERVICE_PATH;
  env.SVC_CWD = cwd;
  env.SVC_SESSION_ID = sessionId;
  env.SVC_MODEL = model;
  env.SVC_REASONING_EFFORT = reasoningEffort;
  env.SVC_REQUESTED_CWD = requestedCwd;
  env.SVC_ATTACHMENTS_FILE = attachmentsFile;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', RUNNER], {
      env,
      cwd: BRIDGE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrOut = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderrOut += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr: stderrOut }));
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

  // usage from the step and from the result is not dropped (Story 1.9 maps it)
  const usages = markers(stdout, 'USAGE').map((l) => JSON.parse(l.slice('[USAGE]'.length)));
  assert.equal(usages.length, 2, 'step_update usage + result usage');
  for (const usage of usages) {
    assert.equal(usage.output_tokens, 147);
    assert.equal(usage.total_tokens, 18941);
  }

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

test('non-image attachments are logged to stderr and the turn continues (R-9)', async () => {
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
  assert.match(stderr, /\[gemini\] ignoring 1 non-image attachment\(s\): text\/plain:notes\.txt/);
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
