import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The persistent service writes process-level NDJSON via
// process.stdout._originalStdoutWrite when present; install a capture writer
// before importing the module so daemon-mode behavior is observable.
const processLevelLines = [];
process.stdout._originalStdoutWrite = function _testWrite(chunk, encoding, callback) {
  processLevelLines.push(String(chunk));
  if (typeof callback === 'function') {
    callback();
  }
  return true;
};

const here = dirname(fileURLToPath(import.meta.url));
const peerScript = resolve(here, 'testing', 'codex-stdio-peer.js');
const testCwd = mkdtempSync(join(tmpdir(), 'codex-daemon-test-'));

const {
  codexSendPersistent,
  codexExecutePlanPersistent,
  codexPreconnectPersistent,
  codexRespondInteractionPersistent,
  codexAbortTurnPersistent,
  codexResetRuntimePersistent,
  codexShutdownPersistentRuntimes,
  getCodexRuntimeSnapshot,
  filterCodexProjectThreads,
  projectThreadFileChanges,
  codexReadThreadPersistent,
  setCodexPristineBaseEnv,
} = await import('./persistent-codex-service.js');

setCodexPristineBaseEnv({ ...process.env, CODEX_HOME: join(testCwd, 'native-home') });

test('a warm managed to CLI Login switch resolves missing credentials for the new native child', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-native-env-'));
  writeFileSync(join(codexHome, 'config.toml'), '[model_providers.fixture]\nenv_key = "CODEMOSS_TEST_NATIVE_KEY"\n');
  const data = { channelId: 'warm-native-env', cwd: testCwd, codexHome,
    codexCommandPrefix: peerCommandPrefix('credential-env') };
  let lookups = 0;
  const dependencies = { titleDependencies: { enabled: async () => false }, nativeEnvironmentDependencies: {
    lookup: async keys => {
      lookups += 1;
      assert.deepEqual(keys, ['CODEMOSS_TEST_NATIVE_KEY']);
      return { CODEMOSS_TEST_NATIVE_KEY: 'fixture-native-value' };
    },
  } };
  assert.equal((await codexSendPersistent({ ...data, authMode: 'managed', message: 'managed request' }, dependencies)).outcome, 'completed');
  assert.equal(lookups, 0);
  const result = await codexSendPersistent({ ...data, authMode: 'cli_login', message: 'native credential request' }, dependencies);
  assert.equal(result.outcome, 'completed');
  assert.equal(lookups, 1);
  const observed = codexEvents().filter(event => event.channelId === data.channelId && event.kind === 'itemCompleted')
    .map(event => JSON.parse(event.payload.item.text).configured);
  assert.deepEqual(observed, [false, true]);
  assert.equal(getCodexRuntimeSnapshot().sessions[0].runtimeGeneration, 2);
  const rejected = await codexSendPersistent({ ...data, authMode: 'cli_login', message: 'native credential failure' }, dependencies);
  assert.equal(rejected.outcome, 'failed');
  assert.equal(rejected.error.includes('fixture-native-value'), false);
  assert.match(rejected.error, /\[redacted credential\]/);
});

test('projects all session file changes without the visible history page limit', () => {
  const thread = { id: 'whole', turns: Array.from({ length: 40 }, (_, index) => ({ id: `turn-${index}`, items: [
    { id: `edit-${index}`, type: 'fileChange', status: 'completed', changes: [{ path: `/file-${index}.ts`, kind: 'add', diff: '+created' }] },
    { id: `text-${index}`, type: 'agentMessage', text: 'unrelated' },
  ] })) };
  const messages = projectThreadFileChanges(thread);
  assert.equal(messages.length, 40);
  assert.equal(messages[0].message.content[0].id, 'edit-0');
  assert.equal(messages.at(-1).message.content[0].id, 'edit-39');
  assert.equal(messages[0].codexThreadId, 'whole');
});

test('the persistent channel clears Fast with explicit standard input and keeps the cleared tier on later sends', async () => {
  for (const cleared of ['', null]) {
    const channelId = cleared === '' ? 'tier-empty' : 'tier-null';
    const data = { channelId, cwd: testCwd, codexCommandPrefix: peerCommandPrefix('service-tier'),
      message: 'inspect the tier' };
    for (const settings of [{ serviceTier: 'fast' }, { serviceTier: cleared }, {}]) {
      const result = await codexSendPersistent({ ...data, ...settings },
        { titleDependencies: { enabled: async () => false } });
      assert.equal(result.outcome, 'completed');
    }
    const observed = codexEvents().filter(event => event.channelId === channelId && event.kind === 'itemCompleted')
      .map(event => JSON.parse(event.payload.item.text).serviceTier);
    assert.deepEqual(observed, ['priority', 'default', 'default']);
  }
});

test('first successful conversation names its native thread asynchronously and survives a cold metadata read', async () => {
  const data = { channelId: 'title-session', cwd: testCwd, codexCommandPrefix: peerCommandPrefix('session-title'),
    message: '修复命令卡片', clientMessageId: 'title-message' };
  const result = await codexSendPersistent(data, { titleDependencies: { enabled: async () => true, readCustomTitle: async () => null } });
  assert.equal(result.outcome, 'completed');
  const deadline = Date.now() + 4000;
  while (!codexEvents().some(event => event.kind === 'threadNameUpdated') && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 10));
  }
  const event = codexEvents().find(event => event.kind === 'threadNameUpdated');
  assert.equal(event?.payload?.threadName, '修复命令卡片');
  const saved = await codexReadThreadPersistent({ ...data, threadId: event.threadId, params: { includeTurns: false } });
  assert.equal(saved.thread.name, '修复命令卡片');
});

test('an authoritative completed plan remains executable and rejects substituted text', async () => {
  const data = { channelId: 'completed-plan', cwd: testCwd, codexCommandPrefix: peerCommandPrefix('native-items'),
    message: 'plan a change', clientMessageId: 'plan-first' };
  await codexSendPersistent(data);
  const event = codexEvents().find(entry => entry.kind === 'planUpdated' && entry.payload.authoritative);
  const execution = { ...data, threadId: event.threadId, planItemId: event.payload.item.id,
    planText: event.payload.item.text };
  await assert.rejects(codexExecutePlanPersistent({ ...execution, planText: 'substituted body' }), /stale|changed/i);
  assert.equal(codexEvents().filter(entry => entry.kind === 'turnStarted').length, 1);
  assert.equal((await codexExecutePlanPersistent(execution)).outcome, 'completed');
  assert.equal(codexEvents().filter(entry => entry.kind === 'turnStarted').length, 2);
});

test('the edit-only native response contains all turns without copying command transcripts', async () => {
  const result = await codexReadThreadPersistent({ channelId: 'whole-session', cwd: testCwd,
    threadId: 'whole-session', codexCommandPrefix: peerCommandPrefix('whole-session-edits'),
    params: { includeTurns: true, fileChangesOnly: true } });
  assert.deepEqual(result.thread, { id: 'whole-session' });
  assert.equal(result.fileChangeMessages.length, 40);
  assert.equal(result.fileChangeMessages[0].codexTurnId, 'turn-0');
});

test('executing a plan rechecks its native body and the latest turn before dispatch', async () => {
  for (const scenario of ['native-plan-replaced', 'native-plan-superseded']) {
    const data = { channelId: scenario, cwd: testCwd, codexCommandPrefix: peerCommandPrefix(scenario),
      message: 'review plan', clientMessageId: `${scenario}-first` };
    await codexSendPersistent(data);
    const events = () => codexEvents().filter(entry => entry.channelId === scenario);
    const plan = events().find(entry => entry.kind === 'planUpdated' && entry.payload.authoritative);
    await assert.rejects(codexExecutePlanPersistent({ ...data, threadId: plan.threadId,
      planItemId: plan.payload.item.id, planText: plan.payload.item.text }), /changed|stale/i);
    assert.equal(events().filter(entry => entry.kind === 'turnStarted').length, 1);
  }
});

test('project history includes descendants and drive aliases without crossing a directory boundary', () => {
  const threads = [{ cwd: 'C:\\Project\\Repo' }, { cwd: 'c:/project/repo/packages' },
    { cwd: 'C:/Project/Repository' }, { cwd: '/linux/Repo' }, { cwd: '/linux/repo' }];
  assert.deepEqual(filterCodexProjectThreads(threads, ['C:/PROJECT/REPO/', '/linux/Repo']), [threads[0], threads[1], threads[3]]);
  assert.deepEqual(filterCodexProjectThreads(threads, '/linux/repo'), [threads[4]]);
});

test('project history hides guardian review sources without hiding user reviews or names', () => {
  const threads = [
    { id: 'user', cwd: testCwd, name: 'Guardian review', source: 'appServer' },
    { id: 'review', cwd: testCwd, source: { subagent: 'review' } },
    { id: 'old-guardian', cwd: testCwd, source: { subagent: { other: 'guardian' } } },
    { id: 'internal-guardian', cwd: testCwd, source: { internal: 'guardian' } },
    { id: 'thread-source', cwd: testCwd, threadSource: 'guardian_review' },
    { id: 'legacy-thread-source', cwd: testCwd, thread_source: 'guardian_review' },
  ];
  assert.deepEqual(filterCodexProjectThreads(threads, testCwd).map(thread => thread.id), ['user', 'review']);
  assert.deepEqual(filterCodexProjectThreads(threads, null).map(thread => thread.id), ['user', 'review']);
});

function peerCommandPrefix(scenario) {
  return [process.execPath, peerScript, '--scenario', scenario];
}

function codexEvents() {
  return processLevelLines
    .flatMap((line) => line.split('\n'))
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((obj) => obj?.event === 'codex_event');
}

test.afterEach(async () => {
  await codexShutdownPersistentRuntimes();
  processLevelLines.length = 0;
});

test('codex.send reaches the native terminal and markers carry operation identity', async () => {
  const markerLines = [];
  const originalLog = console.log;
  console.log = (...args) => markerLines.push(args.join(' '));
  try {
    const result = await codexSendPersistent({
      channelId: 'ch-marker',
      cwd: testCwd,
      codexCommandPrefix: peerCommandPrefix('early-notification'),
      message: 'hello peer',
      clientMessageId: 'cm-marker-1',
    });
    assert.equal(result.outcome, 'completed');
    assert.ok(markerLines.some((line) => line.startsWith('[MESSAGE_START]')),
      'MESSAGE_START marker emitted for the request envelope');
    assert.ok(markerLines.some((line) => line.startsWith('[MESSAGE_END]')
      && line.includes('"clientOperationId"')),
      'MESSAGE_END marker carries the operation identity');
  } finally {
    console.log = originalLog;
  }
});

test('codex_event envelopes carry session identity, not activeRequestId wrapping', async () => {
  await codexSendPersistent({
    channelId: 'ch-events',
    cwd: testCwd,
    codexCommandPrefix: peerCommandPrefix('early-notification'),
    message: 'hello',
    clientMessageId: 'cm-events-1',
    sessionEpoch: '9',
  });
  const events = codexEvents();
  const turnStarted = events.find((event) => event.kind === 'turnStarted');
  assert.ok(turnStarted, 'turnStarted surfaced as a process-level codex_event');
  assert.equal(turnStarted.type, 'daemon');
  assert.equal(turnStarted.provider, 'codex');
  assert.equal(turnStarted.sessionEpoch, '9');
  assert.ok(turnStarted.threadId, 'real thread identity present');
  // The envelope must not carry a request-wrapping `id` or `line` field.
  assert.equal(turnStarted.id, undefined);
  assert.equal(turnStarted.line, undefined);
});

test('interaction reply bypasses the pending send and reaches the peer', async () => {
  const sendPromise = codexSendPersistent({
    channelId: 'ch-bypass',
    cwd: testCwd,
    codexCommandPrefix: peerCommandPrefix('reverse-approval'),
    message: 'needs approval',
    clientMessageId: 'cm-bypass-1',
  });

  // Wait for the interaction request to surface.
  let interaction = null;
  for (let i = 0; i < 200 && !interaction; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    interaction = codexEvents().find((event) => event.kind === 'interactionRequested');
  }
  assert.ok(interaction, 'approval surfaced while the send is still pending');
  assert.equal(typeof interaction.payload.rpcId, 'number');

  // The reply must flow immediately (this is the R1 deadlock guard).
  await codexRespondInteractionPersistent({
    channelId: 'ch-bypass',
    rpcId: interaction.payload.rpcId,
    result: { decision: 'accept' },
  });

  const result = await sendPromise;
  assert.equal(result.outcome, 'completed');
});

test('abortTurn stops the active operation without queueing', async () => {
  const sendPromise = codexSendPersistent({
    channelId: 'ch-abort',
    cwd: testCwd,
    codexCommandPrefix: peerCommandPrefix('reverse-approval'),
    message: 'stop me',
    clientMessageId: 'cm-abort-1',
  });
  let interaction = null;
  for (let i = 0; i < 200 && !interaction; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    interaction = codexEvents().find((event) => event.kind === 'interactionRequested');
  }
  assert.ok(interaction, 'turn active (approval open)');

  const abortResult = await codexAbortTurnPersistent({
    channelId: 'ch-abort',
    cwd: testCwd,
  });
  assert.equal(abortResult.stopped, true);

  const result = await sendPromise;
  assert.equal(result.outcome, 'interrupted');
});

test('runtime snapshot and shutdown drain all sessions', async () => {
  await codexPreconnectPersistent({
    channelId: 'ch-snap',
    cwd: testCwd,
    codexCommandPrefix: peerCommandPrefix('early-notification'),
  });
  const snapshot = getCodexRuntimeSnapshot();
  assert.equal(snapshot.sessionCount, 1);
  assert.equal(snapshot.sessions[0].state, 'ready');
  assert(snapshot.sessions[0].runtimePid > 0);
  const ready = codexEvents().findLast(event => event.kind === 'runtimeStateChanged' && event.payload.state === 'ready');
  assert.equal(ready.payload.runtimePid, snapshot.sessions[0].runtimePid);
  assert.equal(ready.channelId, 'ch-snap');

  const shutdown = await codexShutdownPersistentRuntimes();
  assert.equal(shutdown.shutDown, 1);
  assert.equal(getCodexRuntimeSnapshot().sessionCount, 0);
});

test('resetRuntime drains and disposes the session entry', async () => {
  await codexPreconnectPersistent({
    channelId: 'ch-reset',
    cwd: testCwd,
    codexCommandPrefix: peerCommandPrefix('early-notification'),
  });
  const result = await codexResetRuntimePersistent({
    channelId: 'ch-reset',
    cwd: testCwd,
    dispose: true,
  });
  assert.equal(result.reset, true);
  assert.equal(getCodexRuntimeSnapshot().sessionCount, 0);
});
