import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoningEffortToSession, GrokAcpClient } from './grok-acp-client.js';
import { sendMessage } from './message-service.js';
import {
  preconnectPersistent,
  sendMessagePersistent,
  shutdownPersistentRuntimes,
} from './persistent-acp-service.js';

const configResult = (effort) => ({
  configOptions: [{ id: 'reasoning_effort', currentValue: effort }],
});

test('reasoning effort uses the Grok typed ACP option, preserving xhigh', async () => {
  const calls = [];
  const client = { request: async (...args) => {
    calls.push(args);
    return configResult('xhigh');
  } };
  await applyReasoningEffortToSession(client, 'session-1', 'xhigh');
  assert.deepEqual(calls, [['session/set_config_option', {
    sessionId: 'session-1', configId: 'reasoning_effort', value: 'xhigh',
  }]]);
});

test('unset effort leaves CLI defaults intact', async () => {
  await applyReasoningEffortToSession({ request: () => assert.fail('unexpected request') }, 's', '');
});

test('a rejected or ignored effort cannot silently run with high', async () => {
  for (const result of [configResult('high'), { configOptions: [] }]) {
    await assert.rejects(applyReasoningEffortToSession({ request: async () => result }, 's', 'xhigh'),
      /did not apply reasoning effort/);
  }
  await assert.rejects(applyReasoningEffortToSession({ request: async () => {
    throw new Error('Unsupported config option');
  } }, 's', 'xhigh'), /Unsupported config option/);
});

// Exercise the real message services, substituting only the ACP transport.
// No network, CLI processes, or model inference are used by these tests.
function mockTransport(t) {
  const calls = [];
  const prompts = [];
  let starts = 0;
  let effort = 'high';
  let rejectConfig = false;
  t.mock.method(GrokAcpClient.prototype, 'start', function () { starts++; this.proc = {}; });
  t.mock.method(GrokAcpClient.prototype, 'close', async function () { this.closed = true; });
  t.mock.method(GrokAcpClient.prototype, 'request', async function (method, params) {
    calls.push({ method, params });
    if (method === 'initialize') return { authMethods: [{ id: 'xai.api_key' }] };
    if (method === 'session/new') return { sessionId: 'test-session' };
    if (method === 'session/set_config_option') {
      if (rejectConfig) throw new Error('Unsupported effort');
      assert.equal(typeof params.value, 'string', 'Grok 1.0.30 requires a scalar option value');
      effort = params.value;
      // A configuration notification must never leak into the answer stream.
      this.onNotification('session/update', { update: {
        sessionUpdate: 'agent_message_chunk', content: { text: 'CONFIG-NOTICE' },
      } });
      return configResult(effort);
    }
    const promptText = params.prompt?.[0]?.text || '';
    // buildPromptBlocks may append ~/.grok/grok-rules.md after the user text.
    if (method === 'session/prompt' && promptText.startsWith('test-user-message')) {
      prompts.push(effort);
      return { stopReason: 'end_turn' };
    }
    return {};
  });
  return { calls, prompts, get starts() { return starts; }, set rejectConfig(value) { rejectConfig = value; } };
}

const params = {
  message: 'test-user-message', cwd: '/private/tmp', model: 'grok-4.6',
  authMethod: 'api_key', apiKey: 'test-key', runtimeSessionEpoch: 'reasoning-test',
};

test('one-shot new and resumed sessions apply xhigh before the user prompt', async (t) => {
  const transport = mockTransport(t);
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  for (const sessionId of ['', 'resumed-session']) {
    await sendMessage({ ...params, sessionId, reasoningEffort: 'xhigh' });
  }
  assert.deepEqual(transport.prompts, ['xhigh', 'xhigh']);
  assert.equal(transport.calls.filter(c => c.method === 'session/load').length, 1);
  assert.deepEqual(transport.calls.filter(c => c.method === 'session/set_config_option')
    .map(c => c.params.sessionId), ['test-session', 'resumed-session']);
  assert.ok(output.every(line => !line.includes('CONFIG-NOTICE')));
});

test('preconnected runtime applies changes per turn and recovers after config failure', async (t) => {
  const transport = mockTransport(t);
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  try {
    await preconnectPersistent(params);
    await sendMessagePersistent({ ...params, reasoningEffort: 'high' });
    await sendMessagePersistent({ ...params, reasoningEffort: 'xhigh' });
    transport.rejectConfig = true;
    await assert.rejects(sendMessagePersistent({ ...params, reasoningEffort: 'low' }), /Unsupported effort/);
    transport.rejectConfig = false;
    await sendMessagePersistent({ ...params, reasoningEffort: 'low' });
    assert.equal(transport.starts, 1, 'reuse the preconnected CLI process');
    assert.deepEqual(transport.prompts, ['high', 'xhigh', 'low']);
    assert.ok(output.every(line => !line.includes('CONFIG-NOTICE')));
  } finally {
    await shutdownPersistentRuntimes();
  }
});
