import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAppServerClient } from './codex-appserver-client.js';
import { generateCodexText } from './codex-text-service.js';
import { startPeerWithStreams, THREAD_ID, TURN_ID } from './testing/codex-stdio-peer.js';

function harness(scenario = 'early-notification', hooks = {}) {
  const calls = [];
  let client;
  const dependencies = {
    runtimeState: () => ({ access: 'cli_login' }),
    resolveCli: () => ({ status: 'resolved', command: ['peer'] }),
    cwd: process.cwd(), baseEnv: {}, timeoutMs: 2000,
    nativeEnvironmentDependencies: { readConfig: async () => '' },
    clientFactory: (options) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const events = new EventEmitter();
      const peer = startPeerWithStreams({ scenario, input, output, onExit: (code) => events.emit('exit', code, null) });
      peer.scenario = { ...peer.scenario, ...hooks };
      const dispatch = peer.dispatch.bind(peer);
      peer.dispatch = (method, params, id) => {
        calls.push({ method, params });
        return dispatch(method, params, id);
      };
      client = new CodexAppServerClient({ ...options, spawnFn: () => ({
        stdin: input, stdout: output, stderr: new PassThrough(), pid: -1,
        on: events.on.bind(events), kill: () => true,
      }) });
      return client;
    },
  };
  return { dependencies, calls, getClient: () => client };
}

test('auxiliary CLI Login text children resolve authorized missing provider credentials', async () => {
  const fixture = harness();
  fixture.dependencies.baseEnv = { CODEX_HOME: 'isolated-native-home' };
  fixture.dependencies.nativeEnvironmentDependencies = {
    readConfig: async path => {
      assert.match(path, /isolated-native-home[\\/]config\.toml$/);
      return '[model_providers.fixture]\nenv_key="CODEMOSS_TEST_NATIVE_KEY"\n';
    },
    lookup: async keys => {
      assert.deepEqual(keys, ['CODEMOSS_TEST_NATIVE_KEY']);
      return { CODEMOSS_TEST_NATIVE_KEY: 'fixture-native-value' };
    },
  };
  assert.equal(await generateCodexText({ prompt: 'text' }, fixture.dependencies), 'Hello from peer');
  assert.equal(fixture.getClient().env.CODEMOSS_TEST_NATIVE_KEY, 'fixture-native-value');
  assert.equal(fixture.getClient().env.CODEX_HOME, 'isolated-native-home');
  assert.equal(fixture.getClient().sanitizeDiagnostic('fixture-native-value'), '[redacted credential]');
  assert.deepEqual(fixture.dependencies.baseEnv, { CODEX_HOME: 'isolated-native-home' });
});

test('cancelled auxiliary text requests close their runtime and never retry a turn', async () => {
  const abort = new AbortController();
  const fixture = harness('never-respond');
  const task = generateCodexText({ prompt: 'title' }, { ...fixture.dependencies, signal: abort.signal });
  while (!fixture.calls.some(call => call.method === 'turn/start')) await new Promise(done => setImmediate(done));
  abort.abort();
  await assert.rejects(task, /cancelled/);
  assert.equal(fixture.getClient().exitSettled, true);
  assert.equal(fixture.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('auxiliary text requests use an ephemeral read-only native thread and await exit', async () => {
  const fixture = harness();
  const deltas = [];
  const text = await generateCodexText({ prompt: 'write text', model: 'chosen-model', onDelta: (delta) => deltas.push(delta) }, fixture.dependencies);
  assert.equal(text, 'Hello from peer');
  assert.equal(deltas.join(''), text);
  const start = fixture.calls.find((call) => call.method === 'thread/start').params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.model, 'chosen-model');
  assert.equal(start.baseInstructions, undefined);
  assert.equal(fixture.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(fixture.calls.some((call) => call.method === 'thread/resume'), false);
  assert.equal(fixture.getClient().exitSettled, true);
});

test('native final snapshots correct previews and exclude commentary from the returned text', async () => {
  const fixture = harness('early-notification', {
    async onTurnStart(_params, peer) {
      peer.reply(peer.currentId, { turn: { id: TURN_ID } });
      peer.notify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } } });
      for (const item of [
        { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'Working' },
        { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Preview' },
        { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Corrected answer' },
      ]) peer.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID, item } });
      peer.notify({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed' } } });
    },
  });
  assert.equal(await generateCodexText({ prompt: 'text' }, fixture.dependencies), 'Corrected answer');
});

for (const [method, params, expected] of [
  ['item/commandExecution/requestApproval', { itemId: 'command', command: ['echo', 'hi'] }, { decision: 'decline' }],
  ['item/fileChange/requestApproval', { itemId: 'patch' }, { decision: 'decline' }],
  ['item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, { permissions: {}, scope: 'turn' }],
  ['item/tool/requestUserInput', { questions: [{ id: 'q', question: 'choose' }] }, { answers: {} }],
  ['mcpServer/elicitation/request', { message: 'choose', requestedSchema: {} }, { action: 'cancel', content: null }],
]) {
  test(`background text requests decline ${method} without waiting for UI`, async () => {
    let received;
    const fixture = harness('early-notification', {
      async onTurnStart(_params, peer) {
        peer.reply(peer.currentId, { turn: { id: TURN_ID } });
        peer.notify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } } });
        peer.serverRequest('interaction', method, { threadId: THREAD_ID, turnId: TURN_ID, ...params });
        received = await peer.waitServerResponse('interaction');
        peer.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID, item: { id: 'answer', type: 'agentMessage', text: 'done' } } });
        peer.notify({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed' } } });
      },
    });
    assert.equal(await generateCodexText({ prompt: 'text' }, fixture.dependencies), 'done');
    assert.deepEqual(received, expected);
    assert.equal(fixture.getClient().exitSettled, true);
  });
}

test('inactive authorization blocks discovery and native startup', async () => {
  await assert.rejects(generateCodexText({ prompt: 'text' }, {
    runtimeState: () => ({ access: 'inactive' }),
    resolveCli: () => assert.fail('inactive access must not discover CLI'),
    clientFactory: () => assert.fail('inactive access must not start a child'),
  }), { code: 'CODEX_ACCESS_INACTIVE' });
});

test('missing CLI reports CLI management instead of requiring an SDK', async () => {
  await assert.rejects(generateCodexText({ prompt: 'text' }, {
    runtimeState: () => ({ access: 'managed' }), resolveCli: () => ({ status: 'unresolved' }),
    clientFactory: () => assert.fail('unresolved CLI must not start a child'),
  }), (error) => error.code === 'CODEX_CLI_UNRESOLVED' && /CLI/.test(error.message) && !/SDK/.test(error.message));
});

test('unconfirmed native work times out without being resent and the child exits', async () => {
  const fixture = harness('silent-start');
  fixture.dependencies.timeoutMs = 80;
  await assert.rejects(generateCodexText({ prompt: 'text' }, fixture.dependencies), { code: 'CODEX_TEXT_TIMEOUT' });
  assert.equal(fixture.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(fixture.getClient().exitSettled, true);
});

test('a failed native terminal does not return a partial preview as success', async () => {
  const fixture = harness('early-notification', {
    async onTurnStart(_params, peer) {
      peer.reply(peer.currentId, { turn: { id: TURN_ID } });
      peer.notify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } } });
      peer.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID, item: { id: 'answer', type: 'agentMessage', text: 'partial' } } });
      peer.notify({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'failed', error: { message: 'synthetic failure' } } } });
    },
  });
  await assert.rejects(generateCodexText({ prompt: 'text' }, fixture.dependencies), { code: 'CODEX_TEXT_FAILED' });
  assert.equal(fixture.getClient().exitSettled, true);
});
