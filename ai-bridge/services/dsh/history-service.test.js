import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachImageData,
  fillMessageCounts,
  foldHistoryEvents,
  isDshRuntimeContextText,
  loadHistoryPages,
  pathsEqualForWorkspace,
  sanitizeDshSidebarTitle,
  summarizeSessions,
  toClaudeMessages,
} from './history-service.js';

test('pathsEqualForWorkspace matches a symlinked project path against the host-canonicalized cwd', () => {
  // The host records the canonical Workspace path as the session cwd (macOS
  // /tmp -> /private/tmp); the IDE passes the directory as opened. Both
  // spellings of the same directory must compare equal, distinct ones not.
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-real-'));
  const linkDir = `${realDir}-link`;
  try {
    let linkCreated = true;
    try {
      fs.symlinkSync(realDir, linkDir, 'dir');
    } catch {
      linkCreated = false; // platform refused to create a symlink
    }
    if (linkCreated) {
      assert.equal(pathsEqualForWorkspace(linkDir, fs.realpathSync(linkDir)), true);
      assert.equal(pathsEqualForWorkspace(linkDir, realDir), true);
    }
    assert.equal(pathsEqualForWorkspace(realDir, `${realDir}-other`), false);
    assert.equal(pathsEqualForWorkspace(realDir, realDir), true);
  } finally {
    try {
      fs.unlinkSync(linkDir);
    } catch {
      // link may not exist when creation failed
    }
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

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

test('foldHistoryEvents reads text blocks from data.message.content', () => {
  const folded = foldHistoryEvents([
    {
      event: {
        type: 'user/message',
        data: { message: { role: 'user', content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } } },
      },
    },
    {
      event: {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
      },
    },
  ]);
  assert.deepEqual(
    folded.map((row) => [row.role, row.kind, row.text]),
    [['user', 'message', 'question'], ['assistant', 'message', 'answer']]
  );
});

test('foldHistoryEvents restores a DSH 0.2.2 turn with reasoning, text and a tool call', () => {
  const folded = foldHistoryEvents([
    {
      event: {
        type: 'user/message',
        data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'read a.js' }], source: { kind: 'user' } },
      },
    },
    {
      event: {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'need the file' },
              { type: 'text', text: 'Reading it.' },
              { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
            ],
          },
        },
      },
    },
    { event: { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{}' } } },
    { event: { type: 'tool/result', data: { callId: 'c1', result: 'body' } } },
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ]);
  assert.deepEqual(
    folded.map((row) => [row.role, row.kind, row.text]),
    [
      ['user', 'message', 'read a.js'],
      ['assistant', 'reasoning', 'need the file'],
      ['assistant', 'message', 'Reading it.'],
      ['assistant', 'tool', ''],
    ]
  );
});

test('foldHistoryEvents hides injected context wrapped in data.message', () => {
  const folded = foldHistoryEvents([
    {
      event: {
        type: 'user/message',
        data: {
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'project rules' }],
            source: { kind: 'agent-instructions' },
          },
        },
      },
    },
  ]);
  assert.deepEqual(folded, []);
});

test('foldHistoryEvents does not duplicate streamed chunks with the settled message', () => {
  const folded = foldHistoryEvents([
    { event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'once' } } } },
    {
      event: {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'once' }] } },
      },
    },
  ]);
  assert.deepEqual(folded.map((row) => row.text), ['once']);
});

const listItem = (sessionId, values) => ({ sessionId, cwd: '/work/app', updatedAt: 1, projections: { values } });

test('summarizeSessions leaves counting to the history, even when the list carries statistics', () => {
  const summary = summarizeSessions([listItem('s1', { sessionStats: { turns: 2, steps: 3 } })], '/work/app');
  assert.equal(summary.sessionCount, 1);
  assert.equal('messageCount' in summary.sessions[0], false);
  assert.equal('total' in summary, false);
});

const uncounted = (...ids) => summarizeSessions(ids.map((id) => listItem(id, {})), '/work/app');
const textBlock = (text) => ({ type: 'text', text });
const userEvent = (text, kind = 'user') => ({
  type: 'user/message',
  data: { role: 'user', content: [textBlock(text)], source: { kind } },
});
const assistantEvent = (...content) => ({ type: 'assistant/message', data: { message: { role: 'assistant', content } } });
const toolOnlyTurn = [
  userEvent('run it'),
  userEvent('time now', 'time-context'),
  assistantEvent({ type: 'reasoning', text: 'use a tool' }, { type: 'tool-call', id: 'c1', name: 'skill', arguments: '{}' }),
  { type: 'tool/call', data: { callId: 'c1', name: 'skill', arguments: '{}' } },
  { type: 'tool/result', data: { callId: 'c1', result: 'done' } },
  assistantEvent(textBlock('finished')),
  { type: 'turn/end', data: {} },
];
const complete = (events) => ({ events, complete: true });

test('fillMessageCounts counts prompts and replies, not tools, reasoning or injected context', async () => {
  const histories = {
    s1: toolOnlyTurn,
    s2: [...toolOnlyTurn, userEvent('again'), assistantEvent(textBlock('reading')), assistantEvent(textBlock('done'))],
  };
  const summary = await fillMessageCounts(uncounted('s1', 's2'), async (id) => complete(histories[id]));
  assert.deepEqual(summary.sessions.map((session) => [session.sessionId, session.messageCount]), [['s1', 2], ['s2', 5]]);
  assert.equal(summary.total, 7);
  assert.equal(summary.sessionCount, 2);
});

test('fillMessageCounts leaves a session unknown unless its whole history was read', async () => {
  const summary = await fillMessageCounts(uncounted('ok', 'fails', 'partial'), async (id) => {
    if (id === 'fails') {
      throw new Error('host went away');
    }
    return { events: toolOnlyTurn, complete: id === 'ok' };
  });
  assert.deepEqual(summary.sessions.map((session) => session.messageCount), [2, undefined, undefined]);
  assert.equal('total' in summary, false);
});

test('fillMessageCounts stops reading once its time budget is spent', async () => {
  const asked = [];
  const ids = Array.from({ length: 40 }, (_, index) => 's' + index);
  const summary = await fillMessageCounts(uncounted(...ids), async (id) => {
    asked.push(id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    return complete(toolOnlyTurn);
  }, 30);
  assert.ok(asked.length < ids.length);
  assert.equal(summary.sessions.length, ids.length);
  assert.equal('total' in summary, false);
});

const pagedClient = (pages) => ({
  dialect: 'legacy',
  call: async (method, payload) => pages[payload.beforeSeq ?? 'newest'],
});

test('loadHistoryPages joins earlier pages and reports a complete read', async () => {
  const client = pagedClient({
    newest: { events: [{ seq: 3 }, { seq: 4 }], hasMore: true },
    3: { events: [{ seq: 1 }, { seq: 2 }], hasMore: false },
  });
  const read = await loadHistoryPages(client, 's1');
  assert.deepEqual(read.events.map((event) => event.seq), [1, 2, 3, 4]);
  assert.equal(read.complete, true);
});

test('loadHistoryPages reports an incomplete read when earlier events cannot be reached', async () => {
  const noCursor = await loadHistoryPages(pagedClient({ newest: { events: [{}], hasMore: true } }), 's1');
  assert.equal(noCursor.complete, false);
  const outOfTime = await loadHistoryPages(pagedClient({ newest: { events: [{ seq: 1 }], hasMore: false } }), 's1', 0);
  assert.equal(outOfTime.complete, false);
});

const imageRef = { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 64, height: 64, bytes: 178, name: 'red.png' };
const imageBlock = { type: 'image', attachment: imageRef };
const fileBlock = { type: 'file', attachment: { attachmentId: 'sha256:def', name: 'notes.txt', bytes: 5 } };
const promptWith = (content, kind = 'user') => ({ type: 'user/message', data: { role: 'user', content, source: { kind } } });
const restoredBlocks = async (events, readImage) =>
  toClaudeMessages(await attachImageData(foldHistoryEvents(events), readImage)).map((message) => message.message.content);

test('an image-only prompt is restored with the image read from the host', async () => {
  const asked = [];
  const blocks = await restoredBlocks([promptWith([textBlock(''), imageBlock])], async (ref) => {
    asked.push(ref);
    return 'QUJD';
  });
  assert.deepEqual(asked, [imageRef]);
  assert.deepEqual(blocks, [[{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }]]);
});

test('a prompt keeps its text next to its image and its file', async () => {
  const blocks = await restoredBlocks([promptWith([textBlock('look'), imageBlock, fileBlock])], async () => 'QUJD');
  assert.deepEqual(blocks[0].map((block) => block.type), ['image', 'attachment', 'text']);
  assert.deepEqual(blocks[0][1], { type: 'attachment', fileName: 'notes.txt' });
  assert.equal(blocks[0][2].text, 'look');
});

test('an image that cannot be read stays visible as a named attachment', async () => {
  const blocks = await restoredBlocks([promptWith([imageBlock])], async () => {
    throw new Error('gone');
  });
  assert.deepEqual(blocks, [[{ type: 'attachment', fileName: 'red.png', mediaType: 'image/png' }]]);
});

test('attachImageData stops asking once its time budget is spent', async () => {
  const asked = [];
  const folded = await attachImageData(foldHistoryEvents([promptWith([imageBlock])]), async (ref) => asked.push(ref), 0);
  assert.deepEqual(asked, []);
  assert.equal(toClaudeMessages(folded)[0].message.content[0].type, 'attachment');
});

test('injected context with an image stays hidden', () => {
  assert.deepEqual(foldHistoryEvents([promptWith([imageBlock], 'agent-instructions')]), []);
});

test('fillMessageCounts counts an image-only prompt', async () => {
  const summary = await fillMessageCounts(uncounted('s1'), async () =>
    complete([promptWith([textBlock(''), imageBlock]), assistantEvent(textBlock('seen'))]));
  assert.equal(summary.sessions[0].messageCount, 2);
});
