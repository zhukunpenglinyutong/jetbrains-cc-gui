import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCodexItemMessages } from './codex-item-projection.js';

test('native collab control calls settle their own card without completing a running child', () => {
  for (const tool of ['wait', 'sendMessage', 'resumeAgent', 'closeAgent']) {
    const item = { id: `control-${tool}`, type: 'collabAgentToolCall', tool, status: 'completed',
      receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } };
    const messages = projectCodexItemMessages(item, { authoritative: true });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].message.content[0].input.agentsStates.child.status, 'running');
    assert.equal(messages[1].message.content[0].tool_use_id, `control-${tool}`);
    assert.equal(messages[1].message.content[0].is_error, false);
  }
});

test('an authoritative empty agent content array clears an earlier body without inventing a pending message', () => {
  const item = { id: 'empty-body', type: 'agentMessage', content: [] };
  assert.equal(projectCodexItemMessages(item).length, 0);
  const messages = projectCodexItemMessages(item, { threadId: 'thread', turnId: 'turn', authoritative: true });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].message.content, [{ type: 'text', text: '' }]);
  assert.equal(messages[0].codexAuthoritative, true);
});

test('image views pair completed snapshots with results even without a status field', () => {
  const item = { id: 'image', type: 'imageView', path: '/workspace/preview.png' };
  assert.equal(projectCodexItemMessages(item, { authoritative: false }).length, 1);
  const messages = projectCodexItemMessages(item, { authoritative: true, threadId: 'thread', turnId: 'turn' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.content[0].input.path, item.path);
  assert.equal(messages[1].message.content[0].tool_use_id, 'image');
  assert.equal(messages[1].message.content[0].is_error, false);
  assert.equal(projectCodexItemMessages({ ...item, status: 'interrupted' }, { authoritative: true })[1].message.content[0].is_error, true);
});

test('web tools complete search, page and find actions without relying on a status field', () => {
  for (const action of [{ type: 'search', query: 'fixture' }, { type: 'openPage', url: 'https://example.com' },
    { type: 'findInPage', url: 'https://example.com', pattern: 'word' }]) {
    const item = { id: 'web', type: 'webSearch', query: 'fixture', action };
    assert.equal(projectCodexItemMessages(item, { authoritative: false }).length, 1);
    const messages = projectCodexItemMessages(item, { threadId: 'thread', turnId: 'turn', authoritative: true });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].message.content[0].name, 'webSearch');
    assert.deepEqual(messages[0].message.content[0].input.action, action);
    assert.equal(messages[1].message.content[0].tool_use_id, 'web');
    assert.equal(messages[1].message.content[0].is_error, false);
  }
});

test('legacy web extensions and failed web tools retain results and terminal state', () => {
  const item = { id: 'legacy-web', type: 'Extension', kind: 'web.search', query: 'fixture',
    results: [{ title: 'fixture', url: 'https://example.com' }] };
  assert.equal(projectCodexItemMessages(item, { authoritative: true }).length, 2);
  for (const status of ['failed', 'interrupted', 'declined']) {
    const messages = projectCodexItemMessages({ id: 'web', type: 'webSearch', status, error: { message: 'actual failure' } });
    assert.equal(messages.length, 2);
    assert.equal(messages[1].message.content[0].is_error, true);
    assert.match(messages[1].message.content[0].content, /actual failure/);
  }
  assert.equal(projectCodexItemMessages({ id: 'web', type: 'webSearch', status: 'inProgress', results: [] },
    { authoritative: true }).length, 1);
});

test('reasoning projects object text without exposing encrypted fields', () => {
  const messages = projectCodexItemMessages({ id: 'reasoning', type: 'reasoning',
    summary: [{ text: 'summary' }], content: [{ text: 'raw reasoning' }], encryptedContent: 'cipher' }, { threadId: 't', turnId: 'u' });
  assert.deepEqual(messages[0].message.content.map((block) => block.thinking), ['summary', 'raw reasoning']);
  assert.equal(JSON.stringify(messages).includes('cipher'), false);
});

test('reasoning without readable content keeps its native lifecycle and identity', () => {
  const item = { id: 'reasoning-empty', type: 'reasoning', summary: [], content: [], encryptedContent: 'cipher-only' };
  const starting = projectCodexItemMessages(item, { threadId: 'thread', turnId: 'turn' });
  const completed = projectCodexItemMessages(item, { threadId: 'thread', turnId: 'turn', authoritative: true });
  assert.equal(starting.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(starting[0].uuid, completed[0].uuid);
  assert.deepEqual(starting[0].message.content[0], { type: 'thinking', thinking: '', text: '', native: true, status: 'inProgress' });
  assert.equal(completed[0].message.content[0].status, 'completed');
  assert.equal(JSON.stringify([...starting, ...completed]).includes('cipher-only'), false);
});

test('reasoning retains its explicit interruption instead of claiming completion', () => {
  const [message] = projectCodexItemMessages({ id: 'stopped-reasoning', type: 'reasoning', summary: [], status: 'interrupted' },
    { threadId: 'thread', turnId: 'turn', authoritative: true });
  assert.equal(message.message.content[0].status, 'interrupted');
});

test('empty completed command output still has a tool result and stable item identity', () => {
  const messages = projectCodexItemMessages({ id: 'command', type: 'commandExecution', command: 'true', status: 'completed' },
    { threadId: 't', turnId: 'u', authoritative: true });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].message.content[0].content, '');
  assert.notEqual(messages[0].uuid, messages[1].uuid);
});

test('command output snapshots do not complete a command that is still running', () => {
  for (const output of ['', 'partial stdout']) {
    for (const authoritative of [false, true]) {
      const messages = projectCodexItemMessages({ id: 'running', type: 'commandExecution',
        command: 'npm test', status: 'inProgress', aggregatedOutput: output }, { authoritative });
      assert.equal(messages.length, 1);
    }
  }
});

test('terminal commands and MCP calls retain empty results and failure states', () => {
  for (const type of ['commandExecution', 'mcpToolCall']) {
    for (const status of ['completed', 'failed', 'declined', 'interrupted']) {
      const messages = projectCodexItemMessages({ id: 'tool', type, command: 'true', tool: 'fixture', status });
      assert.equal(messages.length, 2, `${type} ${status}`);
      assert.equal(messages[1].message.content[0].is_error, status !== 'completed');
    }
  }
  const [running] = projectCodexItemMessages({ id: 'mcp', type: 'mcpToolCall', status: 'inProgress', result: null });
  assert.equal(running.message.content[0].type, 'tool_use');
});

test('unknown visible native items keep their original type in a generic card', () => {
  const messages = projectCodexItemMessages({ id: 'visible', type: 'futureTool', value: 3 }, { threadId: 't', turnId: 'u' });
  assert.equal(messages[0].message.content[0].name, 'futureTool');
  assert.equal(messages[0].message.content[0].input.value, 3);
});

test('native agent launch exposes the real child identity without treating the launch as child completion', () => {
  const messages = projectCodexItemMessages({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent',
    receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } }, status: 'completed' },
  { threadId: 'root', turnId: 'turn', authoritative: true });
  const input = messages[0].message.content[0].input;
  assert.equal(messages[0].message.content[0].name, 'spawn_agent');
  assert.equal(input.agent_id, 'child');
  assert.equal(input.run_in_background, true);
  assert.equal(input.agentsStates.child.status, 'running');
  assert.equal(JSON.parse(messages[1].message.content[0].content).agent_id, 'child');
});

test('native agent cards retain the task prompt supplied by the collab protocol', () => {
  for (const tool of ['spawnAgent', 'sendInput']) {
    const prompt = 'Review the changes.\nKeep the existing session lifecycle.';
    const messages = projectCodexItemMessages({ id: tool, type: 'collabAgentToolCall', tool,
      receiverThreadIds: ['child'], prompt, status: 'completed' },
    { threadId: 'root', turnId: 'turn', authoritative: true });
    assert.equal(messages[0].message.content[0].input.prompt, prompt);
    const withoutPrompt = projectCodexItemMessages({ id: tool, type: 'collabAgentToolCall', tool,
      receiverThreadIds: ['child'], prompt: null, status: 'completed' });
    assert.equal(Object.hasOwn(withoutPrompt[0].message.content[0].input, 'prompt'), false);
  }
});

test('agent launch results follow native status even when a receiver identity is already known', () => {
  for (const authoritative of [false, true]) {
    for (const status of ['inProgress', 'completed', 'failed', 'interrupted']) {
      const messages = projectCodexItemMessages({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent',
        receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } }, status }, { authoritative });
      assert.equal(messages.length, status === 'inProgress' ? 1 : 2);
      if (status !== 'inProgress') assert.equal(messages[1].message.content[0].is_error, status !== 'completed');
      assert.equal(messages[0].message.content[0].input.agentsStates.child.status, 'running');
    }
  }
});

test('dynamic native tools retain names, arguments, terminal results and output images', () => {
  const args = { patch: '*** Begin Patch\n*** Add File: a.ts\n+content\n*** End Patch' };
  for (const authoritative of [false, true]) {
    for (const status of ['inProgress', 'completed', 'failed']) {
      const messages = projectCodexItemMessages({ id: 'dynamic', type: 'dynamicToolCall', namespace: 'functions',
        tool: 'apply_patch', arguments: args, status, success: status !== 'failed', contentItems: [
          { type: 'inputText', text: 'Native output' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,fixture' },
        ] }, { threadId: 'thread', turnId: 'turn', authoritative });
      const call = messages[0].message.content[0];
      assert.equal(call.name, 'functions.apply_patch');
      assert.deepEqual(call.input, args);
      assert.equal(messages.length, status === 'inProgress' ? 1 : 2);
      if (status !== 'inProgress') {
        const result = messages[1].message.content[0];
        assert.equal(result.tool_use_id, call.id);
        assert.equal(result.is_error, status === 'failed');
        assert.deepEqual(result.content, [{ type: 'text', text: 'Native output' },
          { type: 'image', source: { type: 'url', url: 'data:image/png;base64,fixture' } }]);
      }
    }
  }
  const emptyFailure = projectCodexItemMessages({ id: 'empty', type: 'dynamicToolCall', tool: 'fixture',
    arguments: {}, status: 'completed', success: false, contentItems: [] });
  assert.equal(emptyFailure[1].message.content[0].is_error, true);
});

test('command projection preserves supplied explanations and native actions without inventing a reason', () => {
  const item = { id: 'cmd', type: 'commandExecution', command: 'cat file', description: 'Inspect fixture',
    summary: 'Provided summary', title: 'Provided title', justification: 'Read protected fixture',
    approvalReason: 'Native approval reason', commandActions: [{ type: 'read', path: '/file' }] };
  const input = projectCodexItemMessages(item)[0].message.content[0].input;
  for (const key of ['description', 'summary', 'title', 'justification', 'approvalReason', 'commandActions']) assert.deepEqual(input[key], item[key]);
  assert.equal(projectCodexItemMessages({ id: 'bare', type: 'commandExecution', command: 'pwd' })[0].message.content[0].input.description, undefined);
  assert.equal(projectCodexItemMessages({ id: 'no', type: 'commandExecution', command: 'false', status: 'declined' }, { authoritative: true })[1].message.content[0].is_error, true);
});

test('compaction without a summary keeps its boundary and leaves historical trigger unknown', () => {
  const [history] = projectCodexItemMessages({ id: 'compact', type: 'contextCompaction' }, { threadId: 't', turnId: 'u', authoritative: true });
  assert.equal(history.isCompactSummary, true);
  assert.equal(history.summarizeMetadata.status, 'completed');
  assert.equal(history.summarizeMetadata.trigger, undefined);
  assert.equal(history.message.content[0].text, '');
  const [live] = projectCodexItemMessages({ id: 'compact', type: 'contextCompaction' }, { kind: 'compact' });
  assert.equal(live.summarizeMetadata.trigger, 'manual');
  assert.equal(live.summarizeMetadata.status, 'inProgress');
});

test('MCP results preserve native text, images and structured content as display blocks', () => {
  const item = { id: 'mcp-image', type: 'mcpToolCall', tool: 'capture', server: 'fixture', status: 'completed',
    result: { content: [{ type: 'text', text: 'Captured fixture' },
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }], structuredContent: { width: 80 } } };
  for (const authoritative of [false, true]) {
    const messages = projectCodexItemMessages(item, { threadId: 'thread', turnId: 'turn', authoritative });
    assert.deepEqual(messages[1].message.content[0].content, [
      { type: 'text', text: 'Captured fixture' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
      { type: 'text', text: JSON.stringify({ width: 80 }) },
    ]);
  }
  const structured = projectCodexItemMessages({ ...item, result: { content: [], structuredContent: { queued: true } } });
  assert.deepEqual(structured[1].message.content[0].content, [{ type: 'text', text: '{"queued":true}' }]);
});

test('native image generations display their PNG results without copying image data into the input', () => {
  const item = { id: 'generated-image', type: 'imageGeneration', status: 'completed',
    revisedPrompt: 'A blue square', transparentBackground: false, result: 'cG5n', savedPath: '/tmp/image.png', failure: null };
  for (const authoritative of [false, true]) {
    const messages = projectCodexItemMessages(item, { threadId: 'thread', turnId: 'turn', authoritative });
    assert.equal(messages.length, 2);
    const call = messages[0].message.content[0];
    assert.equal(call.name, 'imageGeneration');
    assert.deepEqual(call.input, { revisedPrompt: 'A blue square', transparentBackground: false, path: '/tmp/image.png' });
    assert.equal(call.input.result, undefined);
    assert.equal(messages[1].message.content[0].tool_use_id, call.id);
    assert.equal(messages[1].message.content[0].is_error, false);
    assert.deepEqual(messages[1].message.content[0].content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
      { type: 'text', text: '/tmp/image.png' },
    ]);
  }
  const legacy = projectCodexItemMessages({ id: 'old-image', type: 'ImageGeneration', status: 'completed',
    revised_prompt: 'An older square', saved_path: '/tmp/older.png', result: 'cG5n' });
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy[0].message.content[0].input, { revisedPrompt: 'An older square', path: '/tmp/older.png' });
});

test('image generation extensions retain native failures and stop states without completing a running image', () => {
  const extension = { id: 'image-extension', type: 'Extension', kind: 'image_gen.generation',
    revisedPrompt: 'A blue square', result: '', status: 'in_progress' };
  assert.equal(projectCodexItemMessages(extension, { authoritative: true }).length, 1);
  for (const status of ['failed', 'interrupted', 'declined']) {
    const failure = { type: 'usageLimitExceeded', limitId: 'image-generation', resetsAt: 1000 };
    const messages = projectCodexItemMessages({ ...extension, status, failure });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].message.content[0].name, 'imageGeneration');
    assert.equal(messages[1].message.content[0].is_error, true);
    assert.deepEqual(messages[1].message.content[0].content, [{ type: 'text', text: JSON.stringify(failure) }]);
  }
  const interrupted = projectCodexItemMessages({ ...extension, status: 'interrupted' });
  assert.deepEqual(interrupted[1].message.content[0].content, []);
});
