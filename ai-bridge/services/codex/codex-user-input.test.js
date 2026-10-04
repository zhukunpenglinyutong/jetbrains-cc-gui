import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialEventState, processCodexEventStream } from './codex-event-handler.js';
import { createAsyncUserInputBridge } from './message-service.js';

function question(callId, title = 'Continue?', options = ['Analyze only', 'Fix and test']) {
  return {
    type: 'response_item',
    payload: {
      type: 'function_call', name: 'request_user_input_async', namespace: 'functions', call_id: callId,
      arguments: JSON.stringify({ questions: [{ title, options }] }),
    },
  };
}

function output(callId, value = '{"accepted":true}', extra = {}) {
  return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: value, ...extra } };
}

async function runEvents(entries, onAsyncUserInput) {
  const state = createInitialEventState(() => {});
  async function* stream() {
    yield* entries;
  }
  await processCodexEventStream(stream(), state, { onAsyncUserInput, normalizedPermissionMode: 'bypassPermissions' });
  return state;
}

test('failed calls, missing results, unrelated tools and unaccepted results never open dialogs', async () => {
  const unrelated = question('unrelated');
  unrelated.payload.name = 'some_other_tool';
  const otherNamespace = question('other-namespace');
  otherNamespace.payload.namespace = 'mcp';
  await runEvents([
    question('invalid'), output('invalid', 'failed to parse function arguments: unknown field suggested_answer'),
    question('missing'),
    question('declined'), output('declined', '{"accepted":false}'),
    question('string-boolean'), output('string-boolean', '{"accepted":"true"}'),
    question('error'), output('error', '{"accepted":true}', { status: 'error' }),
    question('is-error'), output('is-error', '{"accepted":true}', { is_error: true }),
    unrelated, output('unrelated'), otherNamespace, output('other-namespace'),
  ], async () => assert.fail('Invalid call must not open a dialog'));
});

test('output-first and duplicate events associate an accepted call by its exact call ID', async () => {
  const opened = [];
  await runEvents([
    output('first'), question('second'), question('first'),
    output('first'), question('first'), output('second', [{ type: 'input_text', text: '{"accepted":true}' }]),
  ], async (args, callId) => opened.push(callId));
  assert.deepEqual(opened, ['first', 'second']);
});

test('failure then four identical accepted retries opens once and answers every valid call', async () => {
  let dialogs = 0;
  const delivered = [];
  const client = { activeTurnId: 'turn-1', steerTurn: async (threadId, turnId, input) => delivered.push(JSON.parse(input[0].text)) };
  const bridge = createAsyncUserInputBridge(client, 'thread-1', [], async () => {
    dialogs += 1;
    return { 'Continue?': 'Analyze only' };
  });
  await runEvents([
    question('invalid'), output('invalid', 'failed to parse function arguments'),
    ...['retry-1', 'retry-2', 'retry-3', 'retry-4'].flatMap(callId => [question(callId), output(callId)]),
  ], bridge);
  assert.equal(dialogs, 1);
  assert.deepEqual(delivered.map(answer => answer.call_id), ['retry-1', 'retry-2', 'retry-3', 'retry-4']);
  assert.ok(delivered.every(answer => answer.answers['Continue?'] === 'Analyze only'));
});

test('different question text, options, selection mode and question groups are never merged', async () => {
  let dialogs = 0;
  const bridge = createAsyncUserInputBridge({ activeTurnId: null }, 'thread-1', [], async () => {
    dialogs += 1;
    return {};
  });
  const original = { title: 'Continue?', options: ['A', 'B'] };
  for (const questions of [
    [original],
    [{ ...original, title: 'Delete?' }],
    [{ ...original, options: ['A', 'C'] }],
    [{ ...original, multiSelect: true }],
    [original, { title: 'Second question', options: ['A', 'B'] }],
  ]) {
    await bridge({ questions }, `call-${dialogs}`);
  }
  assert.equal(dialogs, 5);
});

test('concurrent identical calls share the pending dialog and retain their answer IDs', async () => {
  let resolveAnswer;
  const pendingAnswer = new Promise(resolve => { resolveAnswer = resolve; });
  let dialogs = 0;
  const queued = [];
  const bridge = createAsyncUserInputBridge({ activeTurnId: null }, 'thread-1', queued, async () => {
    dialogs += 1;
    return pendingAnswer;
  });
  const args = { questions: [{ title: 'Choice', options: ['A', 'B'] }] };
  const first = bridge(args, 'first');
  const second = bridge(args, 'second');
  await Promise.resolve();
  assert.equal(dialogs, 1);
  assert.equal(queued.length, 0);
  resolveAnswer({ Choice: 'B' });
  await Promise.all([first, second]);
  assert.deepEqual(queued.map(input => JSON.parse(input.text).call_id), ['first', 'second']);
});

test('cancelled or empty answers are not selected answers and identical retries do not reopen', async () => {
  for (const answer of [null, {}, { Choice: '' }]) {
    let dialogs = 0;
    const queued = [];
    const bridge = createAsyncUserInputBridge({ activeTurnId: null }, 'thread-1', queued, async () => {
      dialogs += 1;
      return answer;
    });
    const args = { questions: [{ title: 'Choice', options: ['A', 'B'] }] };
    await bridge(args, 'first');
    await bridge(args, 'retry');
    assert.equal(dialogs, 1);
    assert.ok(queued.every(input => JSON.parse(input.text).cancelled === true));
  }
});

test('new turn and separate session use their own answer cache', async () => {
  let dialogs = 0;
  const ask = async () => { dialogs += 1; return { Choice: 'A' }; };
  const args = { questions: [{ title: 'Choice', options: ['A', 'B'] }] };
  for (const threadId of ['thread-1', 'thread-1', 'thread-2']) {
    const bridge = createAsyncUserInputBridge({ activeTurnId: null }, threadId, [], ask);
    await bridge(args, 'first');
    await bridge(args, 'retry');
  }
  assert.equal(dialogs, 3);
});
