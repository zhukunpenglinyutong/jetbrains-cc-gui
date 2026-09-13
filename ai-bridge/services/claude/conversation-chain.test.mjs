import test from 'node:test';
import assert from 'node:assert/strict';

import { selectConversationChain } from './conversation-chain.js';

let uuidCounter = 0;
function uuid(prefix) {
  uuidCounter += 1;
  return `${prefix}-${String(uuidCounter).padStart(4, '0')}`;
}

function userEntry(parentUuid, text, timestamp) {
  return {
    type: 'user',
    uuid: uuid('u'),
    parentUuid,
    timestamp,
    message: { role: 'user', content: text },
  };
}

function assistantEntry(parentUuid, text, timestamp, messageId) {
  return {
    type: 'assistant',
    uuid: uuid('a'),
    parentUuid,
    timestamp,
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function chainTexts(chain) {
  return chain.map((entry) => {
    const content = entry.message.content;
    if (typeof content === 'string') {
      return content;
    }
    return content[0].type === 'tool_result' ? 'tool_result' : content[0].text;
  });
}

test('drops the rewound branch and keeps the forked continuation', () => {
  // Rewind forks in place: after rewinding to u1's answer, the next user
  // message parents onto a1, leaving the old u2/a2 branch dead on disk.
  const first = userEntry(null, 'first', '2026-01-01T10:00:00Z');
  const answerOne = assistantEntry(first.uuid, 'answer one', '2026-01-01T10:00:05Z', 'm1');
  const rewoundQuestion = userEntry(answerOne.uuid, 'second (rewound)', '2026-01-01T10:01:00Z');
  const rewoundAnswer = assistantEntry(rewoundQuestion.uuid, 'answer two (rewound)', '2026-01-01T10:01:05Z', 'm2');
  const retry = userEntry(answerOne.uuid, 'second retry', '2026-01-01T10:02:00Z');
  const retryAnswer = assistantEntry(retry.uuid, 'answer retry', '2026-01-01T10:02:05Z', 'm3');

  const chain = selectConversationChain([
    first, answerOne, rewoundQuestion, rewoundAnswer, retry, retryAnswer,
  ]);
  assert.deepEqual(chainTexts(chain), ['first', 'answer one', 'second retry', 'answer retry']);
});

test('keeps attachments that hang off the live chain and drops rewound ones', () => {
  const first = userEntry(null, 'first', '2026-01-01T10:00:00Z');
  const liveAttachment = {
    type: 'attachment',
    uuid: uuid('att'),
    parentUuid: first.uuid,
    timestamp: '2026-01-01T10:00:01Z',
    attachment: { type: 'file' },
  };
  const answerOne = assistantEntry(liveAttachment.uuid, 'answer one', '2026-01-01T10:00:05Z', 'm1');
  const rewound = userEntry(answerOne.uuid, 'rewound', '2026-01-01T10:01:00Z');
  const rewoundAttachment = {
    type: 'attachment',
    uuid: uuid('att'),
    parentUuid: rewound.uuid,
    timestamp: '2026-01-01T10:01:01Z',
    attachment: { type: 'file' },
  };
  const retry = userEntry(answerOne.uuid, 'retry', '2026-01-01T10:02:00Z');

  const chain = selectConversationChain([
    first, liveAttachment, answerOne, rewound, rewoundAttachment, retry,
  ]);
  assert.deepEqual(chain.map((entry) => entry.type), [
    'user',
    'attachment',
    'assistant',
    'user',
  ]);
});

test('recovers parallel tool_use siblings and their tool results', () => {
  // N parallel tool_uses stream as N assistant rows sharing one message.id;
  // the parentUuid chain keeps only one, the recovery pass must splice the
  // siblings and their tool results back in after the on-chain anchor.
  const question = userEntry(null, 'run both', '2026-01-01T10:00:00Z');
  const toolA = assistantEntry(question.uuid, 'tool A', '2026-01-01T10:00:01Z', 'msg-shared');
  const toolB = {
    type: 'assistant',
    uuid: uuid('a'),
    parentUuid: toolA.uuid,
    timestamp: '2026-01-01T10:00:01Z',
    message: { id: 'msg-shared', role: 'assistant', content: [{ type: 'text', text: 'tool B' }] },
  };
  const resultA = {
    type: 'user',
    uuid: uuid('u'),
    parentUuid: toolB.uuid,
    timestamp: '2026-01-01T10:00:02Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
  };
  const resultB = {
    type: 'user',
    uuid: uuid('u'),
    parentUuid: toolA.uuid,
    timestamp: '2026-01-01T10:00:02Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2' }] },
  };
  const done = assistantEntry(resultA.uuid, 'done', '2026-01-01T10:00:05Z', 'm-final');

  const chain = selectConversationChain([
    question, toolA, toolB, resultA, resultB, done,
  ]);
  assert.deepEqual(chainTexts(chain), [
    'run both',
    'tool A',
    'tool B',
    'tool_result',
    'tool_result',
    'done',
  ]);
});

test('falls back to line order when no row carries parentUuid', () => {
  // The plugin's direct-API fallback writer omits parentUuid entirely;
  // chain-walking such a file would collapse every message into isolated
  // leaves, so line order must win.
  const entries = [
    { type: 'user', uuid: uuid('u'), timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'one' } },
    { type: 'assistant', uuid: uuid('a'), timestamp: '2026-01-01T10:00:05Z', message: { role: 'assistant', content: 'two' } },
    { type: 'user', uuid: uuid('u'), timestamp: '2026-01-01T10:01:00Z', message: { role: 'user', content: 'three' } },
  ];

  const chain = selectConversationChain(entries);
  assert.equal(chain.length, 3);
  assert.deepEqual(chainTexts(chain), ['one', 'two', 'three']);
});

test('chains through rows appended without the parentUuid key', () => {
  // A hybrid transcript: CLI rows carry parentUuid, then the plugin's
  // direct-API fallback appends rows with uuid but no parentUuid key. The
  // walk must inherit the previous row as the implicit parent instead of
  // stopping at the first such row and dropping all prior history. An
  // explicit null (compact boundary / true root written by the CLI) stays
  // a root.
  const root = userEntry(null, 'root', '2026-01-01T10:00:00Z');
  const answer = assistantEntry(root.uuid, 'answer', '2026-01-01T10:00:05Z', 'm1');
  const fallbackUser = {
    type: 'user',
    uuid: uuid('u'),
    timestamp: '2026-01-01T10:01:00Z',
    message: { role: 'user', content: 'appended without the key' },
  };
  const fallbackAssistant = {
    type: 'assistant',
    uuid: uuid('a'),
    timestamp: '2026-01-01T10:01:05Z',
    message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'fallback answer' }] },
  };

  const chain = selectConversationChain([root, answer, fallbackUser, fallbackAssistant]);
  assert.deepEqual(chainTexts(chain), ['root', 'answer', 'appended without the key', 'fallback answer']);
});

test('keeps pre-compact history before the compact boundary', () => {
  // The GUI keeps the effective pre-compact prefix visible even though the
  // boundary starts a new parent chain for Claude Code's model loader.
  const staleUser = userEntry(null, 'stale pre-compact', '2026-01-01T09:00:00Z');
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T10:00:00Z',
  };
  const freshUser = userEntry(boundary.uuid, 'post-compact', '2026-01-01T10:01:00Z');

  const chain = selectConversationChain([staleUser, boundary, freshUser]);
  assert.deepEqual(chain.map((entry) => entry.uuid), [staleUser.uuid, boundary.uuid, freshUser.uuid]);
});

test('keeps a compact summary ahead of trailing local command output', () => {
  const previousUser = userEntry(null, 'before compact', '2026-01-01T09:00:00Z');
  const previousAnswer = assistantEntry(
    previousUser.uuid,
    'previous answer',
    '2026-01-01T09:00:05Z',
    'm-previous'
  );
  const compactCommand = userEntry(
    previousAnswer.uuid,
    '<command-name>/compact</command-name>\n<command-args></command-args>',
    '2026-01-01T09:01:00Z'
  );
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T10:00:00Z',
  };
  const summary = userEntry(boundary.uuid, 'compacted summary', '2026-01-01T10:00:01Z');
  summary.isCompactSummary = true;
  const stdout = userEntry(
    compactCommand.uuid,
    '<local-command-stdout>Compacted Tip</local-command-stdout>',
    '2026-01-01T10:00:02Z'
  );

  const chain = selectConversationChain([
    previousUser,
    previousAnswer,
    compactCommand,
    boundary,
    summary,
    stdout,
  ]);

  assert.deepEqual(chain.map((entry) => entry.uuid), [
    previousUser.uuid,
    previousAnswer.uuid,
    boundary.uuid,
    summary.uuid,
  ]);
});

test('restores compact-preserved messages before the summary', () => {
  // The GUI keeps the pre-compact tail before the compact summary, rather
  // than inheriting Claude Code's internal post-summary splice order.
  const previousUser = userEntry(null, 'before compact', '2026-01-01T09:00:00Z');
  const preservedAssistant = assistantEntry(
    previousUser.uuid,
    'long assistant summary',
    '2026-01-01T09:01:00Z',
    'm-preserved'
  );
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T10:00:00Z',
    compactMetadata: {
      preservedSegment: {
        headUuid: preservedAssistant.uuid,
        anchorUuid: 'anchor-summary',
        tailUuid: preservedAssistant.uuid,
      },
      preservedMessages: {
        anchorUuid: 'anchor-summary',
        allUuids: [preservedAssistant.uuid],
      },
    },
  };
  const summary = userEntry(boundary.uuid, 'compacted summary', '2026-01-01T10:00:01Z');
  summary.uuid = 'anchor-summary';
  summary.isCompactSummary = true;

  const chain = selectConversationChain([
    previousUser,
    preservedAssistant,
    boundary,
    summary,
  ]);

  assert.deepEqual(chain.map((entry) => entry.uuid), [
    previousUser.uuid,
    preservedAssistant.uuid,
    boundary.uuid,
    summary.uuid,
  ]);
});

test('restores compact-preserved messages from segment metadata alone', () => {
  // Claude Code's standard compact boundary carries preservedSegment without
  // the optional UUID carrier; recover the segment by walking tail to head.
  const previousUser = userEntry(null, 'before compact', '2026-01-01T09:00:00Z');
  const preservedAssistant = assistantEntry(
    previousUser.uuid,
    'kept answer',
    '2026-01-01T09:01:00Z',
    'm-preserved'
  );
  const preservedQuestion = userEntry(
    preservedAssistant.uuid,
    'kept question',
    '2026-01-01T09:01:30Z'
  );
  const preservedAnswer = assistantEntry(
    preservedQuestion.uuid,
    'kept follow-up',
    '2026-01-01T09:02:00Z',
    'm-preserved-follow-up'
  );
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T10:00:00Z',
    compactMetadata: {
      preservedSegment: {
        headUuid: preservedAssistant.uuid,
        anchorUuid: 'anchor-summary',
        tailUuid: preservedAnswer.uuid,
      },
    },
  };
  const summary = userEntry(boundary.uuid, 'compacted summary', '2026-01-01T10:00:01Z');
  summary.uuid = 'anchor-summary';
  summary.isCompactSummary = true;

  const chain = selectConversationChain([
    previousUser,
    preservedAssistant,
    preservedQuestion,
    preservedAnswer,
    boundary,
    summary,
  ]);

  assert.deepEqual(chain.map((entry) => entry.uuid), [
    previousUser.uuid,
    preservedAssistant.uuid,
    preservedQuestion.uuid,
    preservedAnswer.uuid,
    boundary.uuid,
    summary.uuid,
  ]);
});

test('keeps compact-preserved messages before the summary when the anchor is off-chain', () => {
  // The UUID carrier still identifies the pre-compact tail even when its
  // anchor is absent; the GUI places that tail before the compact summary.
  const previousUser = userEntry(null, 'before compact', '2026-01-01T09:00:00Z');
  const preservedAssistant = assistantEntry(
    previousUser.uuid,
    'kept tail',
    '2026-01-01T09:01:00Z',
    'm-preserved'
  );
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T10:00:00Z',
    compactMetadata: {
      preservedMessages: {
        anchorUuid: 'missing-anchor',
        allUuids: [preservedAssistant.uuid],
      },
    },
  };
  const summary = userEntry(boundary.uuid, 'compacted summary', '2026-01-01T10:00:01Z');
  summary.isCompactSummary = true;

  const chain = selectConversationChain([
    previousUser,
    preservedAssistant,
    boundary,
    summary,
  ]);

  assert.deepEqual(chain.map((entry) => entry.uuid), [
    previousUser.uuid,
    preservedAssistant.uuid,
    boundary.uuid,
    summary.uuid,
  ]);
});

test('reconnects continuation attached to the preserved tail after compact', () => {
  const previousUser = userEntry(null, 'before compact', '2026-01-01T09:00:00Z');
  const preservedAssistant = assistantEntry(
    previousUser.uuid,
    'last answer before compact',
    '2026-01-01T09:01:00Z',
    'm-preserved'
  );
  const preservedTail = {
    type: 'system',
    subtype: 'stop_hook_summary',
    uuid: uuid('sys'),
    parentUuid: preservedAssistant.uuid,
    timestamp: '2026-01-01T09:01:01Z',
  };
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T10:00:00Z',
    compactMetadata: {
      preservedSegment: {
        headUuid: preservedAssistant.uuid,
        anchorUuid: 'compact-summary',
        tailUuid: preservedTail.uuid,
      },
      preservedMessages: {
        allUuids: [preservedAssistant.uuid, preservedTail.uuid],
      },
    },
  };
  const summary = userEntry(boundary.uuid, 'compacted summary', '2026-01-01T10:00:01Z');
  summary.uuid = 'compact-summary';
  summary.isCompactSummary = true;
  const command = userEntry(
    preservedTail.uuid,
    '<command-name>/compact</command-name>\n<command-args></command-args>',
    '2026-01-01T10:00:02Z'
  );
  const continuation = userEntry(command.uuid, 'Continue from where you left off.', '2026-01-01T10:00:03Z');
  const answer = assistantEntry(continuation.uuid, 'continued answer', '2026-01-01T10:00:04Z', 'm-next');

  const chain = selectConversationChain([
    previousUser,
    preservedAssistant,
    preservedTail,
    boundary,
    summary,
    command,
    continuation,
    answer,
  ]);

  assert.deepEqual(chain.map((entry) => entry.uuid), [
    previousUser.uuid,
    preservedAssistant.uuid,
    preservedTail.uuid,
    boundary.uuid,
    summary.uuid,
    command.uuid,
    continuation.uuid,
    answer.uuid,
  ]);

  const modelChain = selectConversationChain([
    previousUser,
    preservedAssistant,
    preservedTail,
    boundary,
    summary,
    command,
    continuation,
    answer,
  ], { includePreCompactHistory: false });
  assert.deepEqual(modelChain.map((entry) => entry.uuid), [
    boundary.uuid,
    summary.uuid,
    preservedAssistant.uuid,
    preservedTail.uuid,
    command.uuid,
    continuation.uuid,
    answer.uuid,
  ]);
});

test('unwinds nested compacts without recursing forever', () => {
  // Two /compact runs in one session: the second boundary's pre-compact
  // walk crosses the first boundary, and re-running boundary selection
  // inside that recursion would keep picking the newest boundary forever.
  const rootUser = userEntry(null, 'root question', '2026-01-01T09:00:00Z');
  const rootAnswer = assistantEntry(rootUser.uuid, 'root answer', '2026-01-01T09:00:05Z', 'm1');
  const firstBoundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T09:01:00Z',
    compactMetadata: {
      preservedSegment: {
        headUuid: rootAnswer.uuid,
        anchorUuid: 'summary-1',
        tailUuid: rootAnswer.uuid,
      },
    },
  };
  const firstSummary = userEntry(firstBoundary.uuid, 'first summary', '2026-01-01T09:01:01Z');
  firstSummary.uuid = 'summary-1';
  firstSummary.isCompactSummary = true;
  const midQuestion = userEntry(firstSummary.uuid, 'mid question', '2026-01-01T09:02:00Z');
  const midAnswer = assistantEntry(midQuestion.uuid, 'mid answer', '2026-01-01T09:02:05Z', 'm2');
  const secondBoundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid('sys'),
    parentUuid: null,
    timestamp: '2026-01-01T09:03:00Z',
    compactMetadata: {
      preservedSegment: {
        headUuid: midAnswer.uuid,
        anchorUuid: 'summary-2',
        tailUuid: midAnswer.uuid,
      },
    },
  };
  const secondSummary = userEntry(secondBoundary.uuid, 'second summary', '2026-01-01T09:03:01Z');
  secondSummary.uuid = 'summary-2';
  secondSummary.isCompactSummary = true;
  const postUser = userEntry(secondSummary.uuid, 'after both compacts', '2026-01-01T09:04:00Z');

  const entries = [
    rootUser,
    rootAnswer,
    firstBoundary,
    firstSummary,
    midQuestion,
    midAnswer,
    secondBoundary,
    secondSummary,
    postUser,
  ];

  const chain = selectConversationChain(entries);
  assert.deepEqual(chain.map((entry) => entry.uuid), [
    rootUser.uuid,
    rootAnswer.uuid,
    firstBoundary.uuid,
    firstSummary.uuid,
    midQuestion.uuid,
    midAnswer.uuid,
    secondBoundary.uuid,
    secondSummary.uuid,
    postUser.uuid,
  ]);

  const modelChain = selectConversationChain(entries, { includePreCompactHistory: false });
  assert.deepEqual(modelChain.map((entry) => entry.uuid), [
    secondBoundary.uuid,
    secondSummary.uuid,
    midAnswer.uuid,
    postUser.uuid,
  ]);
});

test('ignores sidechain leaves when picking the chain tip', () => {
  const question = userEntry(null, 'main', '2026-01-01T10:00:00Z');
  const answer = assistantEntry(question.uuid, 'main answer', '2026-01-01T10:00:05Z', 'm1');
  const sidechainTail = {
    type: 'assistant',
    uuid: uuid('a'),
    parentUuid: answer.uuid,
    isSidechain: true,
    timestamp: '2026-01-01T11:00:00Z',
    message: { id: 'm-side', role: 'assistant', content: [{ type: 'text', text: 'sidechain tail' }] },
  };

  const chain = selectConversationChain([question, answer, sidechainTail]);
  assert.deepEqual(chainTexts(chain), ['main', 'main answer']);
});

test('prefers the live main branch when it ends with a sidechain entry', () => {
  const firstQuestion = userEntry(null, 'first question', '2026-01-01T10:00:00Z');
  const firstAnswer = assistantEntry(firstQuestion.uuid, 'first answer', '2026-01-01T10:00:01Z', 'm1');
  const deadQuestion = userEntry(firstAnswer.uuid, 'dead question', '2026-01-01T10:00:02Z');
  const deadAnswer = assistantEntry(deadQuestion.uuid, 'dead answer', '2026-01-01T10:00:03Z', 'm-dead');
  const liveQuestion = userEntry(firstAnswer.uuid, 'live question', '2026-01-01T10:00:04Z');
  const liveAnswer = assistantEntry(liveQuestion.uuid, 'live answer', '2026-01-01T10:00:05Z', 'm-live');
  const sidechainAnswer = {
    type: 'assistant',
    uuid: uuid('a'),
    parentUuid: liveAnswer.uuid,
    isSidechain: true,
    timestamp: '2026-01-01T10:00:06Z',
    message: { id: 'm-side', role: 'assistant', content: [{ type: 'text', text: 'sidechain answer' }] },
  };

  const chain = selectConversationChain([
    firstQuestion,
    firstAnswer,
    deadQuestion,
    deadAnswer,
    liveQuestion,
    liveAnswer,
    sidechainAnswer,
  ]);
  assert.deepEqual(chainTexts(chain), ['first question', 'first answer', 'live question', 'live answer']);
});

test('stops walking at a parentUuid cycle instead of looping forever', () => {
  const question = userEntry(null, 'first', '2026-01-01T10:00:00Z');
  const answer = assistantEntry(question.uuid, 'answer', '2026-01-01T10:00:05Z', 'm1');
  // Self-referencing parentUuid: the walk must terminate, not hang.
  answer.parentUuid = answer.uuid;

  const chain = selectConversationChain([question, answer]);
  assert.ok(chain.length > 0);
  assert.ok(chain.length <= 2);
});

test('returns line order for empty or uuid-less input', () => {
  assert.deepEqual(selectConversationChain([]), []);
  const entries = [
    { type: 'user', message: { role: 'user', content: 'no uuid here' } },
    { type: 'file-history-snapshot', snapshot: {} },
  ];
  assert.equal(selectConversationChain(entries).length, 2);
});

test('always returns an array for non-array input', () => {
  // Callers chain .filter/.map onto the result; a truthy non-array must not
  // pass through or the downstream call throws.
  assert.deepEqual(selectConversationChain(null), []);
  assert.deepEqual(selectConversationChain(undefined), []);
  assert.deepEqual(selectConversationChain('not-an-array'), []);
  assert.deepEqual(selectConversationChain({ length: 2 }), []);
  assert.deepEqual(selectConversationChain(42), []);
});

test('keyless mainline rows after a sidechain row inherit the mainline parent, not the sidechain tip', () => {
  // Hybrid transcript: CLI rows carry parentUuid, a subagent (sidechain) row
  // sits between them, then the plugin's direct-API fallback appends mainline
  // rows without the parentUuid key. The keyless row must continue the MAIN
  // branch — inheriting the sidechain row would hang the rest of the
  // transcript off the subagent branch and drop it from the walk.
  const root = userEntry(null, 'root', '2026-01-01T10:00:00Z');
  const answer = assistantEntry(root.uuid, 'answer', '2026-01-01T10:00:05Z', 'm1');
  const sidechainRow = {
    type: 'assistant',
    uuid: uuid('a'),
    parentUuid: answer.uuid,
    isSidechain: true,
    timestamp: '2026-01-01T10:00:06Z',
    message: { id: 'm-side', role: 'assistant', content: [{ type: 'text', text: 'subagent work' }] },
  };
  const fallbackUser = {
    type: 'user',
    uuid: uuid('u'),
    timestamp: '2026-01-01T10:01:00Z',
    message: { role: 'user', content: 'mainline after subagent' },
  };
  const fallbackAssistant = {
    type: 'assistant',
    uuid: uuid('a'),
    timestamp: '2026-01-01T10:01:05Z',
    message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'mainline reply' }] },
  };

  const chain = selectConversationChain([root, answer, sidechainRow, fallbackUser, fallbackAssistant]);
  assert.deepEqual(chainTexts(chain), ['root', 'answer', 'mainline after subagent', 'mainline reply']);
});
