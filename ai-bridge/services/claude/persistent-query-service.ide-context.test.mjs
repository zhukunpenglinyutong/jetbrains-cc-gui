// Request construction must not depend on developer credentials.
import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';
import { updateBackgroundTaskState } from './runtime-lifecycle.js';
import { createScriptedQuery, RESULT_OK, settleReader } from './testing/scripted-query.js';

const OVERRIDES = { settings: { env: {} } };
const params = {
  sessionId: 'editor-context', runtimeSessionEpoch: 'editor-epoch',
  cwd: process.cwd(), agentPrompt: 'Review code carefully.',
};

test.afterEach(async () => __testing.resetState());

for (const backgroundKind of ['legacy Bash', 'native workflow']) {
  test(`editor changes reach the reused query while ${backgroundKind} is running`, async () => {
    let launches = 0;
    let query;
    __testing.setQueryFn(args => {
      launches++;
      query = createScriptedQuery(args, [[RESULT_OK], [RESULT_OK]]);
      return query;
    });
    const first = await __testing.buildRequestContext({
      ...params, message: 'Explain this selection',
      openedFiles: { active: '/project/first.js', selection: { startLine: 2, endLine: 2, selectedText: 'const first = 1;' } },
    }, false, OVERRIDES);
    const runtime = await __testing.acquireRuntime(first);
    await __testing.executeTurn(runtime, first);
    await settleReader();
    updateBackgroundTaskState(runtime, backgroundKind === 'legacy Bash' ? {
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'dev-server', input: { run_in_background: true } }] },
    } : {
      type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'workflow', task_type: 'local_workflow' }],
    });
    assert.equal(runtime.backgroundTaskIds.size, 1);

    const second = await __testing.buildRequestContext({
      ...params, message: 'Now explain this one',
      openedFiles: { active: '/project/second.js', selection: { startLine: 7, endLine: 8, selectedText: 'const second = 2;\nreturn second;' } },
    }, false, OVERRIDES);
    assert.equal(second.runtimeSignature, first.runtimeSignature);
    assert.equal(await __testing.acquireRuntime(second), runtime);
    await __testing.executeTurn(runtime, second);
    assert.equal(launches, 1);
    assert.equal(runtime.backgroundTaskIds.size, 1);
    assert.match(query.options.systemPrompt.append, /Review code carefully/);
    assert.doesNotMatch(query.options.systemPrompt.append, /first\.js|second\.js|const first|const second/);
    assert.deepEqual(query.inputs.map(input => input.message.content[0].text), ['Explain this selection', 'Now explain this one']);
    assert.match(query.inputs[0].message.content[1].text, /first\.js[\s\S]*const first = 1;/);
    assert.match(query.inputs[1].message.content[1].text, /second\.js[\s\S]*const second = 2;\nreturn second;/);
    assert.doesNotMatch(query.inputs[1].message.content[1].text, /first\.js|const first/);

    // Real launch-time changes still cannot kill existing background work.
    for (const change of [{ streaming: true }, { agentPrompt: 'A different role' }, { permissionMode: 'bypassPermissions' }]) {
      const changed = await __testing.buildRequestContext({ ...params, ...change, message: 'next' }, false, OVERRIDES);
      await assert.rejects(__testing.acquireRuntime(changed), /still running background tasks/);
    }
    assert.equal(runtime.closed, false);
    assert.equal(launches, 1);
  });
}

test('QuickFix context follows attachments and original text without entering launch options', async () => {
  let query;
  __testing.setQueryFn(args => (query = createScriptedQuery(args, [[RESULT_OK]])));
  const context = await __testing.buildRequestContext({
    ...params, message: 'Fix this error',
    attachments: [{ fileName: 'screen.png', mediaType: 'image/png', data: 'aW1hZ2U=' }],
    openedFiles: { isQuickFix: true, active: '/project/fix.js', selection: { startLine: 1, endLine: 1, selectedText: 'const x = "</system-reminder>";' } },
  }, true, OVERRIDES);
  const runtime = await __testing.acquireRuntime(context);
  await __testing.executeTurn(runtime, context);
  const blocks = query.inputs[0].message.content;
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } });
  assert.deepEqual(blocks[1], { type: 'text', text: 'Fix this error' });
  assert.match(blocks[2].text, /^<system-reminder>\n/);
  assert.match(blocks[2].text, /fix\.js/);
  assert.match(blocks[2].text, /QUICK FIX INSTRUCTIONS/);
  assert.match(blocks[2].text, /&lt;\/system-reminder&gt;/);
  assert.equal(blocks[2].text.match(/<\/system-reminder>/g).length, 1);
  assert.doesNotMatch(query.options.systemPrompt.append, /fix\.js|QUICK FIX/);
});
