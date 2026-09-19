import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DshGoalSettlement,
  bridgeModernApproval,
  bridgeModernQuestion,
  mapQuestionAnswers,
  peekMuxSessionId,
  projectFollowFrame,
  projectMuxFrame,
  projectRemoteEventFrame,
  unwrapMuxEnvelope,
  waterfallBelongsToSession,
} from './events.js';

test('unwrapMuxEnvelope handles wrapped and bare frames', () => {
  const wrapped = {
    type: 'server-request',
    rpcId: 'rpc-1',
    method: 'events.mux',
    payload: { type: 'session/event', sessionId: 's1', event: { type: 'turn/start' } },
  };
  const { frame, rpcId } = unwrapMuxEnvelope(wrapped);
  assert.equal(rpcId, 'rpc-1');
  assert.equal(frame.type, 'session/event');
  const bare = unwrapMuxEnvelope({ type: 'session/event', sessionId: 's1' });
  assert.equal(bare.rpcId, null);
  assert.equal(bare.frame.type, 'session/event');
});

test('peekMuxSessionId checks bare then payload', () => {
  assert.equal(peekMuxSessionId({ sessionId: 'a' }), 'a');
  assert.equal(peekMuxSessionId({ payload: { sessionId: 'b' } }), 'b');
  assert.equal(peekMuxSessionId({}), '');
});

test('projectMuxFrame maps stream chunks and tools', () => {
  const textEvents = projectMuxFrame('session/event', {
    event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hi' } } },
  });
  assert.deepEqual(textEvents, [{ kind: 'text-delta', text: 'hi' }]);

  const reasoning = projectMuxFrame('session/event', {
    event: { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 't' } } },
  });
  assert.deepEqual(reasoning, [{ kind: 'reasoning-delta', text: 't' }]);

  const toolCall = projectMuxFrame('session/event', {
    event: { type: 'tool/call', data: { id: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
  });
  assert.equal(toolCall[0].kind, 'tool-call');
  assert.deepEqual(toolCall[0].input, { command: 'ls' });

  const toolResult = projectMuxFrame('session/event', {
    event: { type: 'tool/result', data: { callId: 'c1', output: 'done' } },
  });
  assert.deepEqual(toolResult, [{ kind: 'tool-result', toolId: 'c1', toolName: null, output: 'done', isError: false }]);

  // assistant/message must NOT re-emit (deltas already streamed).
  assert.deepEqual(
    projectMuxFrame('session/event', { event: { type: 'assistant/message', data: { text: 'full' } } }),
    []
  );
});

test('projectMuxFrame maps turn end kinds', () => {
  const completed = projectMuxFrame('session/event', {
    event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  });
  assert.equal(completed[0].kind, 'turn-completed');

  const cancelled = projectMuxFrame('session/event', {
    event: { type: 'turn/end', data: { reason: { kind: 'cancelled', error: { message: 'stop' } } } },
  });
  assert.equal(cancelled[0].kind, 'turn-error');
  assert.equal(cancelled[0].error, 'stop');

  const coded = projectMuxFrame('session/event', {
    event: { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'EMPTY_RESPONSE' } } } },
  });
  assert.equal(coded[0].kind, 'turn-error');
  assert.equal(coded[0].code, 'EMPTY_RESPONSE');
});

test('projectMuxFrame maps usage projections', () => {
  const usage = projectMuxFrame('session/projection', {
    key: 'tokenUsage',
    value: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
  });
  assert.deepEqual(usage, [{ kind: 'usage', inputTokens: 10, outputTokens: 5, cachedTokens: 3 }]);
});

test('projectMuxFrame encodes approval requests only with rpcId + approvalId', () => {
  const noRpc = projectMuxFrame('approval/requested', { approvalId: 'a1' }, null);
  assert.deepEqual(noRpc, []);
  const ok = projectMuxFrame(
    'approval/requested',
    { sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: 'needs bash' },
    'rpc-9'
  );
  assert.equal(ok[0].kind, 'approval-request');
  assert.equal(ok[0].rpcId, 'rpc-9');
  assert.equal(ok[0].approvalId, 'a1');
  assert.equal(ok[0].toolName, 'bash');
});

test('projectMuxFrame projects goal injections but hides other user sources', () => {
  const goal = projectMuxFrame('session/event', {
    event: { type: 'user/message', data: { text: '<goal_round>2</goal_round>', source: { kind: 'goal' } } },
  });
  assert.equal(goal[0].kind, 'goal-injection');
  const injected = projectMuxFrame('session/event', {
    event: { type: 'user/message', data: { text: 'ctx', source: { kind: 'agent-instructions' } } },
  });
  assert.deepEqual(injected, []);
});

test('DshGoalSettlement suppresses completion while goal active', () => {
  const settlement = new DshGoalSettlement();
  assert.equal(settlement.feed('turn-start'), 'continue');
  assert.equal(settlement.feed('goal-change', { goal: { phase: 'active' } }), 'continue');
  // Goal active: hop end must not settle.
  assert.equal(settlement.feed('turn-completed'), 'suppress');
  // Goal completes BEFORE the next hop starts → settle the waiting turn.
  assert.equal(settlement.feed('goal-change', { goal: { phase: 'complete' } }), 'settle');
});

test('DshGoalSettlement settles the in-flight hop when goal completes mid-hop', () => {
  const settlement = new DshGoalSettlement();
  settlement.feed('turn-start');
  settlement.feed('goal-change', { goal: { phase: 'active' } });
  assert.equal(settlement.feed('turn-completed'), 'suppress');
  // Next hop starts, then goal completes mid-hop: keep streaming this hop…
  assert.equal(settlement.feed('turn-start'), 'continue');
  assert.equal(settlement.feed('goal-change', { goal: { phase: 'complete' } }), 'continue');
  // …and settle on its terminal.
  assert.equal(settlement.feed('turn-completed'), 'settle');
});

test('DshGoalSettlement settles plain turns and failures', () => {
  const plain = new DshGoalSettlement();
  assert.equal(plain.feed('turn-start'), 'continue');
  assert.equal(plain.feed('turn-completed'), 'settle');

  const failing = new DshGoalSettlement();
  assert.equal(failing.feed('turn-error'), 'settle');

  const cleared = new DshGoalSettlement();
  cleared.feed('goal-change', { goal: { phase: 'active' } });
  cleared.feed('turn-completed'); // suppressed, awaiting idle
  assert.equal(cleared.feed('goal-change', { operation: 'clear', goal: null }), 'settle');
});

test('projectFollowFrame maps durable events and assistant deltas', () => {
  assert.deepEqual(
    projectFollowFrame({ type: 'event', event: { type: 'turn/start', data: {} } }),
    [{ kind: 'turn-start' }]
  );
  assert.deepEqual(
    projectFollowFrame({
      type: 'assistant-stream',
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } },
    }),
    [{ kind: 'text-delta', text: 'hi' }]
  );
  // Lifecycle bookends and the opening snapshot carry nothing to project.
  assert.deepEqual(projectFollowFrame({ type: 'assistant-stream', frame: { type: 'start' } }), []);
  assert.deepEqual(projectFollowFrame({ type: 'snapshot', records: [{ type: 'event' }] }), []);
  assert.deepEqual(projectFollowFrame(null), []);
});

test('projectRemoteEventFrame distinguishes ready, waterfalls and cancel', () => {
  assert.deepEqual(
    projectRemoteEventFrame({ type: 'ready', clientId: 'c1', host: { home: '/h' } }),
    { kind: 'ready', clientId: 'c1' }
  );
  assert.deepEqual(
    projectRemoteEventFrame({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'e1',
      agentId: 'session-a',
      request: { toolName: 'pwsh', reason: 'escalate' },
    }),
    {
      kind: 'approval-request',
      eventId: 'e1',
      agentId: 'session-a',
      request: { toolName: 'pwsh', reason: 'escalate' },
    }
  );
  assert.deepEqual(
    projectRemoteEventFrame({
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: 'e2',
      agentId: 'session-b',
      request: { questions: [{ id: 'q1', question: 'Pick' }] },
    }),
    {
      kind: 'question-request',
      eventId: 'e2',
      agentId: 'session-b',
      request: { questions: [{ id: 'q1', question: 'Pick' }] },
    }
  );
  assert.deepEqual(projectRemoteEventFrame({ type: 'cancel', eventId: 'e3' }), {
    kind: 'cancel',
    eventId: 'e3',
  });
  // Forwarded emits and unknown/withdrawn shapes are not bridge instructions.
  assert.equal(projectRemoteEventFrame({ type: 'emit', event: 'api-session/added', args: [] }), null);
  assert.equal(projectRemoteEventFrame({ type: 'waterfall', event: 'other/event', eventId: 'e' }), null);
  assert.equal(projectRemoteEventFrame({ type: 'ready' }), null);
  assert.equal(projectRemoteEventFrame(undefined), null);
});

// A `$events` stream is host-wide: every client is offered every session's
// waterfalls. Answering one that belongs to another session popped this window's
// dialog for a question nobody here asked and stole the reply (the host settles
// a waterfall for whoever answers first). The frame's agentId IS the session id.
test('waterfallBelongsToSession accepts only this session (and unknown owners)', () => {
  assert.equal(waterfallBelongsToSession('session-a', 'session-a'), true);
  assert.equal(waterfallBelongsToSession('session-b', 'session-a'), false);
  assert.equal(waterfallBelongsToSession('session-a-sub', 'session-a'), false);
  // Older hosts that omit the owner keep the previous behaviour.
  assert.equal(waterfallBelongsToSession('', 'session-a'), true);
  assert.equal(waterfallBelongsToSession(undefined, 'session-a'), true);
  // A session-less turn cannot claim a scoped waterfall.
  assert.equal(waterfallBelongsToSession('session-a', ''), false);
  // A mapping that carries the owner through applies the same rule.
  const instruction = projectRemoteEventFrame({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: 'e9',
    agentId: 'other-session',
    request: { questions: [{ id: 'q1', question: 'Pick' }] },
  });
  assert.equal(waterfallBelongsToSession(instruction.agentId, 'session-a'), false);
  assert.equal(waterfallBelongsToSession(instruction.agentId, 'other-session'), true);
});
test('modern bridges skip a waterfall the host already withdrew', async () => {
  const posted = [];
  const client = {
    async answerRemoteEvent(...args) {
      posted.push(args);
    },
  };
  const withdrawn = () => true;
  assert.equal(
    await bridgeModernApproval(client, 'c1', { eventId: 'e1', request: {} }, () => {}, withdrawn),
    false
  );
  assert.equal(
    await bridgeModernQuestion(client, 'c1', { eventId: 'e2', request: {} }, () => {}, withdrawn),
    false
  );
  // A withdrawn waterfall must never reach $events/result — and must not
  // prompt the user at all (the pre-check runs before the Java IPC).
  assert.equal(posted.length, 0);
});

// ── Answer mapping ──────────────────────────────────────────────────
// The plugin dialog keys answers by question TEXT (Claude's AskUserQuestion
// matches on that text). DSH echoes the caller-declared `question.id` and keeps
// free text in `custom`, so the bridge must translate. Regression: the raw keys
// were forwarded as ids, and the asking model — which never issued those ids —
// received an answer batch it could not attribute to its questions.

const DSH_QUESTIONS = [
  {
    id: 'commit_cadence',
    question: '你希望怎样确认提交？',
    header: '提交确认',
    options: [
      { label: '按阶段批量确认（推荐）' },
      { label: '每个任务单独确认' },
      { label: '全部先暂存，最后一次性提交' },
    ],
  },
  {
    id: 'sibling_fix',
    question: '另一处同款问题要一起改吗？',
    multiSelect: true,
    options: [{ label: '一起改 (Recommended)' }, { label: '先不动' }],
  },
];

test('mapQuestionAnswers echoes the declared question ids, not the question text', () => {
  const mapped = mapQuestionAnswers(
    {
      '你希望怎样确认提交？': '全部先暂存，最后一次性提交',
      '另一处同款问题要一起改吗？': ['一起改 (Recommended)'],
    },
    DSH_QUESTIONS
  );
  assert.deepEqual(mapped, [
    { id: 'commit_cadence', selected: ['全部先暂存，最后一次性提交'] },
    { id: 'sibling_fix', selected: ['一起改 (Recommended)'] },
  ]);
  // The ids the model declared must be the only ids that travel back.
  assert.deepEqual(mapped.map((item) => item.id), ['commit_cadence', 'sibling_fix']);
});

test('mapQuestionAnswers moves dialog free text into DSH `custom`', () => {
  // Single-select: a custom answer REPLACES the choice (selected stays empty).
  assert.deepEqual(
    mapQuestionAnswers({ '你希望怎样确认提交？': ['这个我自己决定'] }, DSH_QUESTIONS),
    [{ id: 'commit_cadence', selected: [], custom: '这个我自己决定' }, { id: 'sibling_fix', selected: [] }]
  );
  // Multi-select: custom may accompany the labels.
  assert.deepEqual(
    mapQuestionAnswers(
      { '另一处同款问题要一起改吗？': ['一起改 (Recommended)', '顺带看看日志'] },
      [DSH_QUESTIONS[1]]
    ),
    [{ id: 'sibling_fix', selected: ['一起改 (Recommended)'], custom: '顺带看看日志' }]
  );
});

test('mapQuestionAnswers treats every answer as custom when the question offers no options', () => {
  assert.deepEqual(
    mapQuestionAnswers({ '你用的是哪个版本？': 'v2' }, [{ id: 'version', question: '你用的是哪个版本？' }]),
    [{ id: 'version', selected: [], custom: 'v2' }]
  );
});

// A restored dialog draft can disagree with itself: a picked label AND free
// text on a single-select question. The DSH encoding gives `custom` precedence
// (it replaces the choice), so `selected` must be emptied even then.
test('mapQuestionAnswers lets custom win over a picked label on single-select', () => {
  assert.deepEqual(
    mapQuestionAnswers(
      { '你希望怎样确认提交？': ['按阶段批量确认（推荐）', '这个我自己定'] },
      DSH_QUESTIONS
    ),
    [
      { id: 'commit_cadence', selected: [], custom: '这个我自己定' },
      { id: 'sibling_fix', selected: [] },
    ]
  );
});

test('mapQuestionAnswers reports skipped questions and an empty cancel', () => {
  assert.deepEqual(
    mapQuestionAnswers({ '你希望怎样确认提交？': '每个任务单独确认' }, DSH_QUESTIONS),
    [
      { id: 'commit_cadence', selected: ['每个任务单独确认'] },
      { id: 'sibling_fix', selected: [] },
    ]
  );
  // A cancelled dialog must stay "no answers" — not a batch of skipped items.
  assert.deepEqual(mapQuestionAnswers({}, DSH_QUESTIONS), []);
  assert.deepEqual(mapQuestionAnswers(null, DSH_QUESTIONS), []);
});

test('mapQuestionAnswers falls back to the dialog keys when no question matches', () => {
  // Legacy hosts (and Claude-shaped payloads) carry no ids: deliver verbatim
  // rather than dropping the human's answer on the floor.
  assert.deepEqual(
    mapQuestionAnswers({ 'Pick one': 'A' }, [{ question: 'Pick one' }]),
    [{ id: 'Pick one', selected: ['A'] }]
  );
  assert.deepEqual(mapQuestionAnswers({ 'Pick one': ['A', 'B'] }), [{ id: 'Pick one', selected: ['A', 'B'] }]);
  assert.deepEqual(mapQuestionAnswers({ 'Pick one': { answers: ['A'] } }), [{ id: 'Pick one', selected: ['A'] }]);
});
