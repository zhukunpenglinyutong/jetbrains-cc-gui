import test from 'node:test';
import assert from 'node:assert/strict';

import {
  foldHistoryEvents,
  isDshRuntimeContextText,
  sanitizeDshSidebarTitle,
  toClaudeMessages,
} from './history-service.js';

test('isDshRuntimeContextText catches runtime snapshot and skill XML', () => {
  assert.equal(isDshRuntimeContextText('Current runtime context. This snapshot supersedes…'), true);
  assert.equal(isDshRuntimeContextText('<system-reminder>\nfoo\n</system-reminder>'), true);
  assert.equal(
    isDshRuntimeContextText('<available_skills>x</available_skills><agent_skills>y</agent_skills>'),
    true
  );
  assert.equal(isDshRuntimeContextText('帮我看一下这个文件'), false);
  assert.equal(isDshRuntimeContextText(''), false);
});

test('sanitizeDshSidebarTitle blanks injected titles', () => {
  assert.equal(sanitizeDshSidebarTitle('<goal_round>3</goal_round>'), '');
  assert.equal(sanitizeDshSidebarTitle('规划 DSH 迁移'), '规划 DSH 迁移');
});

test('foldHistoryEvents folds text, reasoning, tools and filters injections', () => {
  const entries = [
    { event: { type: 'user/message', data: { text: 'Current runtime context. x' } } },
    { event: { type: 'user/message', data: { text: 'hi dsh', source: { kind: 'user' } } } },
    { event: { type: 'user/message', data: { text: '<goal_round>2</goal_round>', source: { kind: 'goal' } } } },
    { event: { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'think ' } } } },
    { event: { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'more' } } } },
    { event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hello ' } } } },
    { event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'world' } } } },
    { event: { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"file_path":"/a.js"}' } } },
    { event: { type: 'tool/result', data: { callId: 'c1', result: 'file body' } } },
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ];
  const folded = foldHistoryEvents(entries);
  const kinds = folded.map((row) => `${row.role}:${row.kind}`);
  // tool/call pushes immediately without flushing pending text (matches
  // desktop-cc-gui fold_history_events); buffered text flushes at turn/end.
  assert.deepEqual(kinds, [
    'user:message', // real user
    'user:message', // goal injection stays visible in history
    'assistant:tool',
    'assistant:reasoning',
    'assistant:message',
  ]);
  assert.equal(folded[2].id, 'c1');
  assert.deepEqual(folded[2].toolInput, { file_path: '/a.js' });
  assert.equal(folded[2].toolOutput, 'file body');
  assert.equal(folded[3].text, 'think more');
  assert.equal(folded[4].text, 'hello world');
});

test('foldHistoryEvents falls back to assistant/message when chunks are absent', () => {
  const folded = foldHistoryEvents([
    { event: { type: 'assistant/message', data: { text: 'full snapshot' } } },
  ]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].text, 'full snapshot');
});

test('toClaudeMessages emits Claude-shaped blocks', () => {
  const folded = foldHistoryEvents([
    { event: { type: 'user/message', data: { text: '问', source: { kind: 'user' } } } },
    { event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '答' } } } },
    { event: { type: 'tool/call', data: { callId: 'c9', name: 'bash', arguments: '{"command":"ls"}' } } },
    { event: { type: 'tool/result', data: { callId: 'c9', output: { files: ['a'] } } } },
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ]);
  const messages = toClaudeMessages(folded);
  assert.equal(messages[0].type, 'user');
  assert.equal(messages[0].message.content[0].type, 'text');
  // tool/call precedes the flushed assistant text (see fold test above).
  const toolUse = messages[1].message.content[0];
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.id, 'c9');
  assert.deepEqual(toolUse.input, { command: 'ls' });
  const toolResult = messages[2].message.content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'c9');
  assert.equal(toolResult.is_error, false);
  assert.match(toolResult.content, /"files"/);
  assert.equal(messages[3].message.content[0].text, '答');
});

test('foldHistoryEvents keeps tool error state through toClaudeMessages', () => {
  const folded = foldHistoryEvents([
    { event: { type: 'tool/call', data: { callId: 'c7', name: 'bash', arguments: '{"command":"rm"}' } } },
    {
      event: {
        type: 'tool/result',
        data: {
          callId: 'c7',
          message: { content: [{ type: 'text', text: 'permission denied', isError: true }] },
        },
      },
    },
    { event: { type: 'tool/call', data: { callId: 'c8', name: 'bash', arguments: '{}' } } },
    { event: { type: 'tool/result', data: { callId: 'c8', error: { message: 'boom' } } } },
  ]);
  assert.equal(folded[0].isError, true);
  assert.equal(folded[0].toolOutput, 'permission denied');
  assert.equal(folded[1].isError, true);
  const messages = toClaudeMessages(folded);
  const results = messages
    .map((message) => message.message.content[0])
    .filter((block) => block.type === 'tool_result');
  assert.equal(results.length, 2);
  assert.equal(results[0].is_error, true);
  assert.equal(results[1].is_error, true);
});
