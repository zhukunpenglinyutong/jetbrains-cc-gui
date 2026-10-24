import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CodexAppServerClient } from './codex-appserver-client.js';
import { CodexAppServerService } from './codex-appserver-service.js';
import { readNativeHistoryPage } from './codex-native-history.js';
import { readCodexSessionEdits } from './codex-session-edits.js';

const command = process.env.CODEX_CLI_TEST_COMMAND ? JSON.parse(process.env.CODEX_CLI_TEST_COMMAND) : null;
const required = process.env.CODEX_CLI_REQUIRE_REAL === '1';
// The legacy matrix binary has blocking questions but no async tool family or hydration notice.
const legacyCli = process.env.CODEX_CLI_TEST_VERSION === '0.146.0';
const nativeQuestions = [{ title: 'Choose a test answer.', options: ['A', 'B', 'C'] }];

async function fixture(t, { questions = nativeQuestions, wait = false, blocking = false, chat = false } = {}) {
  assert.ok(Array.isArray(command) && command.length > 0, 'CODEX_CLI_TEST_COMMAND must identify the installed CLI');
  const root = mkdtempSync(join(tmpdir(), 'ccgui-native-questions-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  mkdirSync(home); mkdirSync(cwd);
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      const sequence = requests.length;
      const item = sequence === 1 && !chat
        ? { type: 'function_call', id: 'fc_' + randomUUID(), call_id: 'native-question',
          name: blocking ? 'request_user_input' : 'request_user_input_async',
          arguments: JSON.stringify({ questions: blocking ? questions.map((question, index) => ({
            id: `question-${index + 1}`, header: 'Test', question: question.title,
            options: question.options.map(label => ({ label, description: '' })),
          })) : questions }), status: 'completed' }
        : wait && sequence === 2
          ? { type: 'function_call', id: 'fc_' + randomUUID(), call_id: 'native-wait',
            name: 'sleep', namespace: 'clock', arguments: '{"duration_ms":60000}', status: 'completed' }
          : { type: 'message', id: 'msg_' + randomUUID(), role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Native question fixture finished.', annotations: [] }] };
      const id = 'resp_' + randomUUID();
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const event of [
        { type: 'response.created', response: { id, status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, status: 'completed', output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // Enable the native tool family used by async questions; never change the user's home.
  writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\n` +
    `features.stable_environment_tools = true\nfeatures.sleep_tool = true\nccgui_fixture_unknown = true\n` +
    `[model_providers.fixture]\nname = "Local question fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\n` +
    `wire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: home };
  for (const name of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|AUTHORIZATION|NODE_OPTIONS/i.test(name)) delete env[name];
  const makeClient = () => new CodexAppServerClient({ command, env, cwd });
  const client = makeClient();
  const events = []; const markers = []; const notifications = [];
  const service = new CodexAppServerService({ clientFactory: () => client,
    launchOptions: { cwd }, emitMarker: (_operation, marker) => markers.push(marker) });
  service.on('codex_event', event => events.push(event));
  client.on('notification', event => notifications.push(event));
  t.after(async () => {
    await service.resetRuntime();
    server.closeAllConnections(); server.close();
    const cleanupRoot = realpathSync(root);
    assert.equal(dirname(cleanupRoot), realpathSync(tmpdir()));
    assert.ok(basename(cleanupRoot).startsWith('ccgui-native-questions-'));
    await rm(cleanupRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const settings = blocking ? { collaborationMode: { mode: 'plan',
    settings: { model: 'gpt-6.1-sol', reasoning_effort: null, developer_instructions: null } } } : undefined;
  const operation = service.enqueueOperation({ kind: 'send', settings,
    markerPayload: { input: [{ type: 'text', text: chat ? '你好' : 'Ask a test question.' }] } });
  return { service, client, events, markers, notifications, requests, operation, makeClient };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Native fixture timed out: ' + description);
}

const options = { skip: !command && !required ? 'Set CODEX_CLI_TEST_COMMAND to run the isolated native question tests' : false,
  timeout: 90000 };
const asyncOptions = { ...options, skip: options.skip || (legacyCli
  ? 'Official CLI 0.146.0 does not expose native async question tools' : false) };

test('native ordinary chat and cold resume read edit pages without deprecated full-history hydration', options, async t => {
  const f = await fixture(t, { chat: true });
  assert.equal((await f.operation.promise).outcome, 'completed');
  assert.equal(f.events.filter(event => event.kind === 'interactionRequested').length, 0);
  const threadId = f.operation.threadId;
  assert.equal(f.notifications.some(event => event.method === 'deprecationNotice'), false);
  if (legacyCli) {
    const tools = f.requests[0]?.tools;
    assert.ok(Array.isArray(tools), 'The legacy capability assertion needs the actual native tool catalog');
    assert.ok(tools.some(tool => tool.name === 'request_user_input'), 'Blocking questions remain covered on the legacy CLI');
    assert.equal(tools.some(tool => tool.name === 'request_user_input_async'), false,
      'Do not skip async acceptance if the selected CLI actually advertises the tool');
  } else {
    // Control: newer binaries emit this warning; legacy binaries do not have the notice.
    await f.client.request('thread/read', { threadId, includeTurns: true });
    await waitFor(() => f.notifications.some(event => event.method === 'deprecationNotice'
      && JSON.stringify(event.params).includes('Full-history hydration')), 'full-hydration control notice');
  }
  const before = f.notifications.filter(event => event.method === 'deprecationNotice').length;
  const edits = await readCodexSessionEdits((method, params) => f.service.readOnly(method, params), { threadId });
  assert.deepEqual(edits.fileChangeMessages, []);
  assert.equal(f.notifications.filter(event => event.method === 'deprecationNotice').length, before);
  await f.service.resetRuntime();
  const client = f.makeClient();
  const notifications = [];
  client.on('notification', event => notifications.push(event));
  const service = new CodexAppServerService({ clientFactory: () => client, launchOptions: { cwd: f.service.launchOptions.cwd } });
  try {
    await service.preconnect({ threadId });
    assert.equal((await service.enqueueOperation({ kind: 'send', threadId,
      markerPayload: { input: [{ type: 'text', text: '继续普通聊天' }] } }).promise).outcome, 'completed');
    assert.deepEqual((await readCodexSessionEdits((method, params) => service.readOnly(method, params), { threadId })).fileChangeMessages, []);
    const history = await readNativeHistoryPage((method, params) => service.readOnly(method, params), { threadId });
    assert.equal(history.messages.filter(message => message.type === 'user').length, 2);
    assert.equal(history.messages.filter(message => message.type === 'assistant').length, 2);
    assert.equal(notifications.some(event => event.method === 'deprecationNotice'), false);
    assert.equal(f.requests.length, 2, 'Resume and edit reads must not submit extra model requests');
  } finally { await service.resetRuntime(); }
});

test('native async choices steer their running turn, wake the clock and retain structured history after restart', asyncOptions, async t => {
  const f = await fixture(t, { wait: true });
  const request = await waitFor(() => f.events.find(event => event.kind === 'interactionRequested'), 'async question');
  await waitFor(() => f.requests.length >= 2, 'native clock dispatch');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await f.service.respondInteraction(request.payload.rpcId,
    { answers: { 'question-1': { answers: ['B'] } } }), { replied: true });
  assert.equal((await f.operation.promise).outcome, 'completed');
  assert.equal(f.events.filter(event => event.kind === 'operationDone').length, 1);
  assert.ok(f.notifications.some(event => event.params?.item?.type === 'sleep'));
  assert.ok(f.events.some(event => event.kind === 'nativeWarning' && event.payload.method === 'configWarning'));
  const live = f.markers.filter(line => typeof line === 'string' && line.startsWith('[MESSAGE] '))
    .map(line => JSON.parse(line.slice(10)));
  assert.ok(live.some(message => message.message?.content?.some(block => block.name === 'codex_user_input')));
  assert.ok(!live.some(message => message.message?.content?.some(block => block.name === 'sleep')));
  const threadId = f.operation.threadId;
  await f.service.resetRuntime();
  const reader = f.makeClient();
  try {
    await reader.start();
    const history = await readNativeHistoryPage((method, params) => reader.request(method, params), { threadId });
    const serialized = JSON.stringify(history.messages);
    assert.ok(serialized.includes('codex_user_input'), 'Reloaded native history must retain the structured question');
    assert.ok(serialized.includes('Answers to your questions (request: native-question):'));
    assert.ok(serialized.includes('Choose a test answer.\\nB'));
    assert.ok(!history.messages.some(message => message.raw.message.content.some(block => block.name === 'sleep')));
    assert.equal((await reader.request('thread/loaded/list', {})).data.length, 0, 'History reads must not resume a writer');
  } finally { reader.close(); await reader.waitForExit(); }
});

test('native completed async questions continue through a tracked follow-up without losing their answer', asyncOptions, async t => {
  const f = await fixture(t);
  assert.equal((await f.operation.promise).outcome, 'completed');
  const request = f.events.find(event => event.kind === 'interactionRequested');
  assert.ok(request);
  const response = await f.service.respondInteraction(request.payload.rpcId, { answers: { 'question-1': { answers: ['C'] } } });
  assert.equal(response.replied, true);
  assert.equal(response.followUp.threadId, f.operation.threadId);
  const followUp = f.service.enqueueOperation({ kind: 'send', threadId: response.followUp.threadId,
    markerPayload: { input: [{ type: 'text', text: response.followUp.text }] } });
  assert.equal((await followUp.promise).outcome, 'completed');
  assert.notEqual(followUp.nativeTurnId, f.operation.nativeTurnId);
  assert.equal(f.events.filter(event => event.kind === 'operationDone').length, 2);
  assert.ok(JSON.stringify(f.requests.at(-1).input).includes('Choose a test answer.\\nC'));
});

test('native async multi-question input keeps choices and multiline free text in one response', asyncOptions, async t => {
  const f = await fixture(t, { wait: true, questions: [...nativeQuestions, { title: 'Any comment?', options: null }] });
  const request = await waitFor(() => f.events.find(event => event.kind === 'interactionRequested'), 'multi-question request');
  assert.equal(request.payload.params.questions.length, 2);
  assert.deepEqual(request.payload.params.questions[1].options, []);
  await waitFor(() => f.requests.length >= 2, 'native clock dispatch');
  await new Promise(resolve => setTimeout(resolve, 100));
  await f.service.respondInteraction(request.payload.rpcId, { answers: {
    'question-1': { answers: ['A'] }, 'question-2': { answers: ['Custom answer\n第二行'] },
  } });
  assert.equal((await f.operation.promise).outcome, 'completed');
  const input = JSON.stringify(f.requests.at(-1).input);
  assert.ok(input.includes('Any comment?\\nCustom answer\\n第二行'));
  assert.ok(input.includes('request: native-question'));
});

test('native async timeout interrupts its waiting turn and permits the next send', asyncOptions, async t => {
  const f = await fixture(t, { wait: true });
  const request = await waitFor(() => f.events.find(event => event.kind === 'interactionRequested'), 'async question');
  await waitFor(() => f.requests.length >= 2 && f.service.busy, 'native waiting turn');
  const count = f.requests.length;
  assert.deepEqual(await f.service.respondInteraction(request.payload.rpcId, { answers: {} }), { replied: true });
  assert.equal((await f.operation.promise).outcome, 'interrupted');
  assert.equal(f.service.busy, false);
  assert.equal(f.service.pendingInteractions.size, 0);
  assert.equal(f.requests.length, count, 'timeout must not submit a synthetic answer');
  const next = f.service.enqueueOperation({ kind: 'send', threadId: f.operation.threadId,
    markerPayload: { input: [{ type: 'text', text: 'Continue after timeout.' }] } });
  assert.equal((await next.promise).outcome, 'completed');
  assert.equal(f.events.filter(event => event.kind === 'operationDone').length, 2);
});

test('native async cancellation closes the local question without submitting text or starting a turn', asyncOptions, async t => {
  const f = await fixture(t);
  assert.equal((await f.operation.promise).outcome, 'completed');
  const request = f.events.find(event => event.kind === 'interactionRequested');
  const count = f.requests.length;
  assert.deepEqual(await f.service.respondInteraction(request.payload.rpcId, { answers: {} }), { replied: true });
  assert.equal(f.service.pendingInteractions.size, 0);
  assert.equal(f.requests.length, count);
  assert.equal(f.service.respondInteraction(request.payload.rpcId, { answers: {} }), false);
});

test('native plan-mode blocking questions still accept the typed reverse-RPC answer', options, async t => {
  const f = await fixture(t, { blocking: true });
  const request = await waitFor(() => f.events.find(event => event.kind === 'interactionRequested'), 'blocking question');
  assert.equal(request.payload.method, 'item/tool/requestUserInput');
  assert.equal(await f.service.respondInteraction(request.payload.rpcId, { answers: { 'question-1': { answers: ['A'] } } }), true);
  assert.equal((await f.operation.promise).outcome, 'completed');
  assert.ok(JSON.stringify(f.requests.at(-1).input).includes('question-1'));
  assert.equal(f.service.pendingInteractions.size, 0);
});
