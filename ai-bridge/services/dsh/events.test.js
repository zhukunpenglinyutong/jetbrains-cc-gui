import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DshGoalSettlement,
  peekMuxSessionId,
  projectMuxFrame,
  unwrapMuxEnvelope,
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
