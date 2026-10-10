import assert from 'node:assert/strict';
import test from 'node:test';
import { settleCodexSessionTitle } from './codex-session-title.js';

function harness({ enabled = true, name = null, customTitle = null, generateText = async () => '{"title":"修复命令卡片"}' } = {}) {
  let active = true;
  const names = [];
  let generationCalls = 0;
  const service = {
    async readOnly(method, params) {
      assert.equal(method, 'thread/read');
      assert.deepEqual(params, { threadId: 'root', includeTurns: false });
      return { thread: { id: 'root', name } };
    },
    async setThreadName(threadId, title) { names.push({ threadId, title }); return true; },
  };
  return {
    names, cancel: () => { active = false; }, getGenerationCalls: () => generationCalls,
    run: () => settleCodexSessionTitle({ service, threadId: 'root', userMessage: '修复卡片', canApply: () => active,
      generateText: async (input) => { generationCalls += 1; return generateText(input); } }, {
      enabled: async () => enabled, readCustomTitle: async () => customTitle,
    }),
  };
}

test('generates a short native title from the first message and saves it on the same thread', async () => {
  const state = harness();
  await state.run();
  assert.equal(state.getGenerationCalls(), 1);
  assert.deepEqual(state.names, [{ threadId: 'root', title: '修复命令卡片' }]);
});

test('honors the existing toggle, native names and manual titles', async () => {
  for (const options of [{ enabled: false }, { name: 'Existing title' }, { customTitle: 'Manual title' }]) {
    const state = harness(options);
    await state.run();
    assert.equal(state.getGenerationCalls(), 0);
    assert.deepEqual(state.names, []);
  }
});

test('does not rename a released session after delayed generation', async () => {
  let resolve;
  const state = harness({ generateText: () => new Promise(done => { resolve = done; }) });
  const task = state.run();
  while (!resolve) await new Promise(done => setImmediate(done));
  state.cancel();
  resolve('{"title":"Late title"}');
  await task;
  assert.deepEqual(state.names, []);
});

test('a generation failure cannot become a failure of the user turn', async () => {
  const state = harness({ generateText: async () => { throw new Error('unavailable'); } });
  await assert.doesNotReject(state.run());
  assert.deepEqual(state.names, []);
});

test('invalid, empty, multiline and overlong generated titles do not rename native threads', async () => {
  for (const response of ['not JSON', '{}', '{"title":null}', '{"title":" "}',
    JSON.stringify({ title: 'a'.repeat(51) }), JSON.stringify({ title: 'line\nbreak' })]) {
    const state = harness({ generateText: async () => response });
    await state.run();
    assert.deepEqual(state.names, []);
  }
  const fenced = harness({ generateText: async () => '```json\n{"title":"Valid title"}\n```' });
  await fenced.run();
  assert.equal(fenced.names[0].title, 'Valid title');
});

test('a released thread does not even begin title generation', async () => {
  const state = harness();
  state.cancel();
  await state.run();
  assert.equal(state.getGenerationCalls(), 0);
});

test('rechecks a manually changed native name before saving', async () => {
  const state = harness();
  let reads = 0;
  const names = [];
  await settleCodexSessionTitle({
    service: { readOnly: async () => ({ thread: { id: 'root', name: reads++ ? 'Manual title' : null } }),
      setThreadName: async (...args) => names.push(args) },
    threadId: 'root', userMessage: 'question', canApply: () => true, generateText: async () => '{"title":"Generated title"}',
  }, { enabled: async () => true, readCustomTitle: async () => null });
  assert.deepEqual(names, []);
  assert.equal(state.getGenerationCalls(), 0);
});
