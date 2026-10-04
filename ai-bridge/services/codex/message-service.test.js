import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCodexRunInput,
  createAsyncUserInputBridge,
  buildDynamicUserInputResult,
  normalizeAppServerEvents,
  normalizeAppServerInput,
  normalizeQuestionsForDialog,
} from './message-service.js';

describe('buildCodexRunInput', () => {
  it('keeps image-only turns visually empty while satisfying Codex stdin', () => {
    const input = buildCodexRunInput('', [
      { type: 'local_image', path: 'C:\\temp\\second.png' },
    ]);

    assert.deepEqual(input, [
      { type: 'text', text: '\u2063' },
      { type: 'local_image', path: 'C:\\temp\\second.png' },
    ]);
    assert.equal(input[0].text.includes('analyze'), false);
  });

  it('preserves user text when an image is attached', () => {
    const input = buildCodexRunInput('compare this', [
      { type: 'local_image', path: '/tmp/image.png' },
    ]);

    assert.equal(input[0].text, 'compare this');
  });

  it('uses string input when no valid image is attached', () => {
    assert.equal(buildCodexRunInput('hello', [{ type: 'local_image', path: '' }]), 'hello');
  });
});

describe('normalizeAppServerEvents', () => {
  it('maps v2 agent-message deltas into the bridge event stream', async () => {
    async function* notifications() {
      yield {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: 'Hello',
        },
      };
    }

    const events = [];
    for await (const event of normalizeAppServerEvents(notifications(), 'thread-1')) {
      events.push(event);
    }

    assert.deepEqual(events, [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.agent_message_delta',
        item_id: 'item-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        delta: 'Hello',
      },
    ]);
  });
});

describe('normalizeAppServerInput', () => {
  it('maps local images to the app-server variant without changing SDK input', () => {
    const sdkInput = buildCodexRunInput('', [
      { type: 'local_image', path: '/tmp/image.png' },
    ]);

    assert.equal(sdkInput[1].type, 'local_image');
    assert.deepEqual(normalizeAppServerInput(sdkInput), [
      { type: 'text', text: '\u2063' },
      { type: 'localImage', path: '/tmp/image.png' },
    ]);
  });
});

describe('Codex dynamic user input', () => {
  it('waits for an async dialog answer and steers the existing thread with the selected option', async () => {
    let resolveAnswer;
    const selectedAnswer = new Promise((resolve) => { resolveAnswer = resolve; });
    const delivered = [];
    const pending = [];
    const client = {
      activeTurnId: 'turn-existing',
      steerTurn: async (...args) => delivered.push(args),
    };
    const bridge = createAsyncUserInputBridge(client, 'thread-existing', pending, async (input) => {
      assert.equal(input.provider, 'codex');
      assert.equal(input.questions[0].options[1].label, 'B');
      return selectedAnswer;
    });
    const completion = bridge({ questions: [{ title: 'Choose a plan', options: ['A', 'B', 'C'] }] }, 'async-call');
    assert.equal(delivered.length, 0);
    resolveAnswer({ 'Choose a plan': 'B' });
    await completion;
    assert.deepEqual(delivered[0].slice(0, 2), ['thread-existing', 'turn-existing']);
    assert.deepEqual(JSON.parse(delivered[0][2][0].text), {
      type: 'user_input_response', call_id: 'async-call', answers: { 'Choose a plan': 'B' },
    });
    assert.deepEqual(pending, []);
  });

  it('queues the answer if the turn finishes while the dialog is open', async () => {
    const pending = [];
    const client = { activeTurnId: 'turn-1', steerTurn: async () => assert.fail('turn already completed') };
    const bridge = createAsyncUserInputBridge(client, 'thread-1', pending, async () => {
      client.activeTurnId = null;
      return { 'Choose a plan': 'C' };
    });
    await bridge({ questions: [{ title: 'Choose a plan', options: ['A', 'B', 'C'] }] }, 'async-call');
    assert.equal(JSON.parse(pending[0].text).answers['Choose a plan'], 'C');
  });

  it('does not hide unrelated steering errors', async () => {
    const pending = [];
    const client = { activeTurnId: 'turn-1', steerTurn: async () => { throw new Error('transport closed'); } };
    const bridge = createAsyncUserInputBridge(client, 'thread-1', pending, async () => ({ Choice: 'A' }));
    await assert.rejects(bridge({ questions: [{ title: 'Choice', options: ['A'] }] }, 'call'), /transport closed/);
    assert.deepEqual(pending, []);
  });

  it('queues answers when the installed app-server reports no active turn', async () => {
    const pending = [];
    const client = {
      activeTurnId: 'turn-1',
      steerTurn: async () => { throw Object.assign(new Error('no active turn to steer'), { code: -32600 }); },
    };
    const bridge = createAsyncUserInputBridge(client, 'thread-1', pending, async () => ({ Choice: 'A' }));
    await bridge({ questions: [{ title: 'Choice', options: ['A'] }] }, 'call');
    assert.equal(JSON.parse(pending[0].text).answers.Choice, 'A');
  });

  it('reports a cancelled dialog without fabricating a selected option', async () => {
    const pending = [];
    const bridge = createAsyncUserInputBridge({ activeTurnId: null }, 'thread-1', pending, async () => null);
    await bridge({ questions: [{ title: 'Choice', options: ['A', 'B'] }] }, 'call');
    assert.deepEqual(JSON.parse(pending[0].text), {
      type: 'user_input_response', call_id: 'call', answers: { Choice: '' }, cancelled: true,
    });
  });

  it('normalizes title and string options for the existing dialog', () => {
    assert.deepEqual(normalizeQuestionsForDialog([
      { title: 'Choose a plan', options: ['A', 'B', 'C'] },
    ]), [{
      id: 'question-1',
      question: 'Choose a plan',
      header: '',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
        { label: 'C', description: '' },
      ],
      multiSelect: false,
    }]);
  });

  it('returns selected answers in the app-server dynamic-tool response format', () => {
    const questions = normalizeQuestionsForDialog([
      { title: 'Choose a plan', options: ['A', 'B', 'C'] },
    ]);

    assert.deepEqual(buildDynamicUserInputResult(questions, { 'Choose a plan': 'B' }), {
      success: true,
      contentItems: [{
        type: 'inputText',
        text: '{"answers":{"Choose a plan":"B"}}',
      }],
    });
  });
});
