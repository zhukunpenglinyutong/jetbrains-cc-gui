import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createInitialEventState, emitSyntheticPatchOperations, findUniqueRollbackIndex, handleFunctionCallPayload, handleFunctionCallOutputPayload, processCodexEventStream } from './codex-event-handler.js';

test('function call payload prefers raw call_id over matching signature for repeated lifecycle tools', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));
  const args = JSON.stringify({ target: 'agent-1' });

  assert.equal(handleFunctionCallPayload({ type: 'function_call', name: 'wait_agent', call_id: 'call-1', arguments: args }, state), true);
  assert.equal(handleFunctionCallPayload({ type: 'function_call', name: 'wait_agent', call_id: 'call-2', arguments: args }, state), true);

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].message.content[0].id, 'call-1');
  assert.equal(emitted[1].message.content[0].id, 'call-2');
});

test('function call payload creates unique ids for repeated lifecycle tools without raw call_id', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));
  const args = JSON.stringify({ target: 'agent-1' });

  assert.equal(handleFunctionCallPayload({ type: 'function_call', name: 'wait_agent', arguments: args }, state), true);
  assert.equal(handleFunctionCallPayload({ type: 'function_call', name: 'wait_agent', arguments: args }, state), true);

  assert.equal(emitted.length, 2);
  assert.notEqual(emitted[0].message.content[0].id, emitted[1].message.content[0].id);
  assert.match(emitted[0].message.content[0].id, /^codex_lifecycle_wait_agent_/);
  assert.match(emitted[1].message.content[0].id, /^codex_lifecycle_wait_agent_/);
});


test('function call output without call_id matches only a single pending function call', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));

  handleFunctionCallPayload({ type: 'function_call', name: 'wait_agent', arguments: JSON.stringify({ target: 'agent-1' }) }, state);
  assert.equal(handleFunctionCallOutputPayload({ type: 'function_call_output', output: 'done' }, state), true);

  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].message.content[0].tool_use_id, emitted[0].message.content[0].id);
});

test('function call output without call_id resolves pending calls in FIFO order', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));

  handleFunctionCallPayload({ type: 'function_call', name: 'wait_agent', arguments: JSON.stringify({ target: 'agent-1' }) }, state);
  handleFunctionCallPayload({ type: 'function_call', name: 'send_input', arguments: JSON.stringify({ target: 'agent-1', message: 'continue' }) }, state);

  assert.equal(handleFunctionCallOutputPayload({ type: 'function_call_output', output: 'done-1' }, state), true);
  assert.equal(handleFunctionCallOutputPayload({ type: 'function_call_output', output: 'done-2' }, state), true);
  const results = emitted.filter((message) => message.message?.content?.[0]?.type === 'tool_result');
  assert.equal(results.length, 2);
  assert.equal(results[0].message.content[0].tool_use_id, emitted[0].message.content[0].id);
  assert.equal(results[1].message.content[0].tool_use_id, emitted[1].message.content[0].id);
});

test('lifecycle ids without call_id do not collide across event states', () => {
  const emittedA = [];
  const emittedB = [];
  const stateA = createInitialEventState((message) => emittedA.push(message));
  const stateB = createInitialEventState((message) => emittedB.push(message));

  handleFunctionCallPayload({ type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({}) }, stateA);
  handleFunctionCallPayload({ type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({}) }, stateB);

  assert.notEqual(emittedA[0].message.content[0].id, emittedB[0].message.content[0].id);
});


test('denied patch rollback index is line-aware and rejects ambiguous global matches', () => {
  const content = 'same\nneedle\nsame\nneedle\n';
  assert.equal(findUniqueRollbackIndex(content, 'needle', { startLine: 2, endLine: 2 }), 5);
  assert.equal(findUniqueRollbackIndex(content, 'needle', {}), -1);
});



test('response_item function_call without call_id is handled without undefined callId', async () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));
  const events = [
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', id: 'item-1', arguments: '{}' } },
  ];

  await processCodexEventStream(events, state, { threadId: 'thread-1', threadOptions: {}, normalizedPermissionMode: 'default' });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].message.content[0].id, 'item-1');
});


test('non-lifecycle function calls without ids do not reuse signature ids', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));
  const payload = { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'x', status: 'pending' }] }) };

  assert.equal(handleFunctionCallPayload(payload, state), true);
  assert.equal(handleFunctionCallPayload(payload, state), true);

  const uses = emitted.filter((message) => message.message?.content?.[0]?.type === 'tool_use');
  assert.equal(uses.length, 2);
  assert.notEqual(uses[0].message.content[0].id, uses[1].message.content[0].id);
});

test('function_call_output with payload id does not consume the next pending call twice', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));

  handleFunctionCallPayload({ type: 'function_call', id: 'item-1', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'a', status: 'pending' }] }) }, state);
  handleFunctionCallPayload({ type: 'function_call', id: 'item-2', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'b', status: 'pending' }] }) }, state);

  assert.equal(handleFunctionCallOutputPayload({ type: 'function_call_output', id: 'item-1', output: 'done-1' }, state), true);
  assert.equal(handleFunctionCallOutputPayload({ type: 'function_call_output', id: 'item-1', output: 'duplicate' }, state), false);

  const results = emitted.filter((message) => message.message?.content?.[0]?.type === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].message.content[0].tool_use_id, 'item-1');
});



test('function_call_output with nonmatching payload id falls back to FIFO pending call', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));

  handleFunctionCallPayload({ type: 'function_call', id: 'call-1', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'a', status: 'pending' }] }) }, state);

  assert.equal(handleFunctionCallOutputPayload({ type: 'function_call_output', id: 'output-item-1', output: 'done' }, state), true);

  const results = emitted.filter((message) => message.message?.content?.[0]?.type === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].message.content[0].tool_use_id, 'call-1');
});

test('identical mcp calls without ids remain separate invocations', async () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));
  const item = { type: 'mcp_tool_call', server: 'filesystem', tool: 'read_text_file', arguments: { path: '/tmp/a.txt' }, output: 'ok' };

  await processCodexEventStream([
    { type: 'item.started', item },
    { type: 'item.started', item },
    { type: 'item.completed', item },
    { type: 'item.completed', item },
  ], state, { threadId: 'thread-1', threadOptions: {}, normalizedPermissionMode: 'default' });

  assert.equal(emitted[0].message.content[0].type, 'tool_use');
  assert.equal(emitted[1].message.content[0].type, 'tool_use');
  const uses = emitted.filter((message) => message.message?.content?.[0]?.type === 'tool_use');
  const results = emitted.filter((message) => message.message?.content?.[0]?.type === 'tool_result');
  assert.equal(uses.length, 2);
  assert.equal(results.length, 2);
  assert.notEqual(uses[0].message.content[0].id, uses[1].message.content[0].id);
});

test('denied patch rollback failure remains visible as a file change', () => {
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));
  const patchBatches = [{ callId: 'patch-1', operations: [{ filePath: '/repo/a.ts', oldString: 'before', newString: 'after', toolName: 'edit', kind: 'update' }] }];
  const rollbackByCallId = new Map([['patch-1', { success: false, failures: [{ filePath: '/repo/a.ts', reason: 'ambiguous_match' }] }]]);

  emitSyntheticPatchOperations(state, patchBatches, false, new Set(['patch-1']), rollbackByCallId);

  const use = emitted.find((message) => message.message?.content?.[0]?.type === 'tool_use');
  const result = emitted.find((message) => message.message?.content?.[0]?.type === 'tool_result');
  assert.equal(use.message.content[0].input.safe_to_rollback, false);
  assert.equal(result.message.content[0].is_error, false);
});


test('command-created files are emitted as rollback-safe synthetic file changes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-fs-snapshot-'));
  const emitted = [];
  const state = createInitialEventState((message) => emitted.push(message));

  async function* events() {
    yield { type: 'turn.started' };
    yield { type: 'item.started', item: { type: 'command_execution', id: 'cmd-1', command: 'cat > src/text.js' } };
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src/text.js'), 'export const hello = "world";\n', 'utf8');
    yield { type: 'item.completed', item: { type: 'command_execution', id: 'cmd-1', command: 'cat > src/text.js', exit_code: 0, output: '' } };
    yield { type: 'turn.completed' };
  }

  try {
    await processCodexEventStream(events(), state, { cwd, threadId: 'thread-1', threadOptions: {}, normalizedPermissionMode: 'default' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  const fileUse = emitted.find((message) => message.message?.content?.[0]?.type === 'tool_use' && message.message.content[0].name === 'write');
  const fileResult = emitted.find((message) => message.message?.content?.[0]?.type === 'tool_result' && message.message.content[0].tool_use_id === fileUse?.message.content[0].id);

  assert.ok(fileUse, 'expected synthetic write tool use');
  assert.equal(fileUse.message.content[0].input.file_path, join(cwd, 'src/text.js'));
  assert.equal(fileUse.message.content[0].input.old_string, '');
  assert.equal(fileUse.message.content[0].input.new_string, 'export const hello = "world";\n');
  assert.equal(fileUse.message.content[0].input.safe_to_rollback, true);
  assert.equal(fileUse.message.content[0].input.existed_before, false);
  assert.equal(fileUse.message.content[0].input.source, 'codex_session_patch');
  assert.equal(fileResult?.message.content?.[0]?.is_error, false);
});
