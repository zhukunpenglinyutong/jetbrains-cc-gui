/**
 * Grok snapshot-delta dedup tests.
 *
 * The Grok CLI frequently re-sends the full accumulated text (snapshot) in
 * agent_message_chunk / thought updates instead of only the new part. The
 * normalizer must convert snapshots into true deltas and never duplicate or
 * resurrect already-streamed text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GrokEventNormalizer } from './grok-event-normalizer.js';

function recorder() {
  const lines = [];
  const n = new GrokEventNormalizer({
    log: (line) => lines.push(String(line)),
    error: () => {},
  });
  n.begin();
  return { n, lines };
}

const deltas = (lines, tag) =>
  lines
    .filter((l) => l.startsWith(tag))
    .map((l) => JSON.parse(l.slice(tag.length)));

describe('snapshot-delta dedup', () => {
  it('emits only the new part of snapshot-style message chunks', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello, wor' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello, world!' } },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['Hello', ', wor', 'ld!']);
  });

  it('ignores stale snapshot replays', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello, world!' } },
    });
    // Earlier snapshot re-sent after the final one — nothing new may be emitted.
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'Hello, wor' } },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['Hello, world!']);
  });

  it('concatenates genuine delta chunks that are not snapshots', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', delta: 'foo' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', delta: 'bar' } },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['foo', 'bar']);
  });

  it('dedups thought snapshots into THINKING_DELTA', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: 'Think' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: 'Thinking hard' } },
    });

    assert.deepEqual(deltas(lines, '[THINKING_DELTA] '), ['Think', 'ing hard']);
    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), []);
  });

  it('keeps content and thinking accumulators independent', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'answer' } },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: 'reasoning' } },
    });
    // Thought snapshot must not be treated as an extension of the answer text.
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: 'reasoning' } },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['answer', 'reasoning']);
    assert.deepEqual(deltas(lines, '[THINKING_DELTA] '), ['reasoning']);
  });

  it('extracts text from nested and array content shapes', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { content: { text: 'deep' } },
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: [{ text: 'er ' }, { content: 'combo' }],
        },
      },
    });

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['deep', 'er combo']);
  });

  it('emits pre-tool and post-tool chunks as separate deltas and separate text blocks without gluing them together (AC 1)', () => {
    const { n, lines } = recorder();
    const firstChunk = 'Проверяю, откуда после перезагрузки берётся nbns-advertiser: с диска и флеша правка останется, из оперативки — нет.';
    const secondChunk = 'Перезагрузка эту правку не сотрёт.';

    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: firstChunk,
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-grep-1',
          name: 'grep',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: secondChunk,
        },
      },
    });
    n.finishSuccess('sess-1');

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), [firstChunk, secondChunk]);

    const msgLines = lines
      .filter((l) => l.startsWith('[MESSAGE] '))
      .map((l) => JSON.parse(l.slice('[MESSAGE] '.length)));
    const finalMsg = msgLines[msgLines.length - 1];
    assert.equal(finalMsg.type, 'assistant');
    assert.deepEqual(finalMsg.message.content, [
      { type: 'text', text: firstChunk },
      { type: 'text', text: secondChunk },
    ]);

    const fullTrace = lines.join('\n');
    assert.equal(fullTrace.includes('нет.Перезагрузка'), false);
  });

  it('keeps session ID as a standalone text block rather than a suffix of previous block (AC 2)', () => {
    const { n, lines } = recorder();
    const firstChunk = 'ID сессии был в пути черновиков. Сверю его с текущим каталогом сессий, чтобы не процитировать старый.';
    const secondChunk = '`01a130cd-ce41-7000-920d-47c32fd4f4cb`';

    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: firstChunk,
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-term-1',
          name: 'run_terminal_command',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: secondChunk,
        },
      },
    });
    n.finishSuccess('sess-2');

    const msgLines = lines
      .filter((l) => l.startsWith('[MESSAGE] '))
      .map((l) => JSON.parse(l.slice('[MESSAGE] '.length)));
    const finalMsg = msgLines[msgLines.length - 1];
    assert.deepEqual(finalMsg.message.content, [
      { type: 'text', text: firstChunk },
      { type: 'text', text: secondChunk },
    ]);
    assert.equal(finalMsg.message.content[0].text.includes('01a130cd-ce41-7000-920d-47c32fd4f4cb'), false);
  });

  it('only closes segment on the first tool event when multiple updates arrive for one tool id (AC 4)', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: 'Segment 1',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-repeat-id',
          status: 'running',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-repeat-id',
          status: 'running',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-repeat-id',
          status: 'completed',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: 'Segment 2',
        },
      },
    });
    n.finishSuccess('sess-repeat');

    const resets = lines.filter((l) => l === '[BLOCK_RESET]');
    assert.equal(resets.length, 1, 'only opening event emits BLOCK_RESET');

    const msgLines = lines
      .filter((l) => l.startsWith('[MESSAGE] '))
      .map((l) => JSON.parse(l.slice('[MESSAGE] '.length)));
    const finalMsg = msgLines[msgLines.length - 1];
    assert.deepEqual(finalMsg.message.content, [
      { type: 'text', text: 'Segment 1' },
      { type: 'text', text: 'Segment 2' },
    ]);
  });

  it('does not emit a second BLOCK_RESET from #emitToolUse when tool was already closed by opening event (AC 5)', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: 'Before file edit',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'edit-ac5',
          name: 'Edit',
          input: { path: '/proj/file.txt', content: 'new code' },
          status: 'completed',
        },
      },
    });
    n.finishSuccess('sess-ac5');

    const resets = lines.filter((l) => l === '[BLOCK_RESET]');
    assert.equal(resets.length, 1, 'exactly one BLOCK_RESET emitted');
  });

  it('emits two thinking blocks when a tool boundary separates two distinct thoughts (AC 6)', () => {
    const { n, lines } = recorder();
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: 'Thinking about step 1',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-thought-boundary',
        },
      },
    });
    n.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: 'Reflecting on step 2',
        },
      },
    });
    n.finishSuccess('sess-thought');

    assert.deepEqual(deltas(lines, '[THINKING_DELTA] '), [
      'Thinking about step 1',
      'Reflecting on step 2',
    ]);

    const msgLines = lines
      .filter((l) => l.startsWith('[MESSAGE] '))
      .map((l) => JSON.parse(l.slice('[MESSAGE] '.length)));
    const finalMsg = msgLines[msgLines.length - 1];
    assert.deepEqual(finalMsg.message.content, [
      { type: 'thinking', thinking: 'Thinking about step 1' },
      { type: 'thinking', thinking: 'Reflecting on step 2' },
    ]);
  });
});

describe('segment boundaries across tool calls', () => {
  const sendUpdate = (n, update) =>
    n.handleAcpEvent('notification', { method: 'session/update', params: { update } });
  const say = (n, content) => sendUpdate(n, { sessionUpdate: 'agent_message_chunk', content });
  const finishedGrep = { sessionUpdate: 'tool_call', toolCallId: 'call-grep', name: 'grep', status: 'completed' };
  const finalContent = (lines) => {
    const messages = lines
      .filter((l) => l.startsWith('[MESSAGE] '))
      .map((l) => JSON.parse(l.slice('[MESSAGE] '.length)));
    return messages[messages.length - 1].message.content;
  };

  it('keeps genuine deltas intact when they start with a short sealed segment', () => {
    const { n, lines } = recorder();
    say(n, ' ');
    sendUpdate(n, finishedGrep);
    for (const token of ['The', ' file', ' is', ' clean', '.']) say(n, token);
    n.finishSuccess('sess-short-sealed');

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), [' ', 'The', ' file', ' is', ' clean', '.']);
    assert.deepEqual(finalContent(lines), [
      { type: 'text', text: ' ' },
      { type: 'text', text: 'The file is clean.' },
    ]);
  });

  it('keeps a post-tool sentence that repeats the pre-tool one', () => {
    const { n, lines } = recorder();
    say(n, 'Running the tests.');
    sendUpdate(n, { ...finishedGrep, toolCallId: 'call-run-1' });
    say(n, 'Running the tests.');
    sendUpdate(n, { ...finishedGrep, toolCallId: 'call-run-2' });
    say(n, 'All green.');
    n.finishSuccess('sess-repeat-sentence');

    assert.deepEqual(finalContent(lines), [
      { type: 'text', text: 'Running the tests.' },
      { type: 'text', text: 'Running the tests.' },
      { type: 'text', text: 'All green.' },
    ]);
  });

  it('still dedups per-segment snapshots after a tool call', () => {
    const { n, lines } = recorder();
    say(n, 'Checking the config.');
    sendUpdate(n, finishedGrep);
    say(n, 'Con');
    say(n, 'Config ok.');
    n.finishSuccess('sess-per-segment');

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['Checking the config.', 'Con', 'fig ok.']);
    assert.deepEqual(finalContent(lines), [
      { type: 'text', text: 'Checking the config.' },
      { type: 'text', text: 'Config ok.' },
    ]);
  });

  it('seals prose said while a tool runs before that tool card', () => {
    const { n, lines } = recorder();
    say(n, 'Before.');
    sendUpdate(n, { sessionUpdate: 'tool_call', toolCallId: 'call-slow', name: 'grep', status: 'in_progress' });
    say(n, 'While running.');
    sendUpdate(n, { sessionUpdate: 'tool_call_update', toolCallId: 'call-slow', status: 'completed' });
    say(n, 'After.');
    n.finishSuccess('sess-running');

    const stream = lines
      .filter((l) => /^\[(CONTENT_DELTA|BLOCK_RESET|MESSAGE|TOOL_RESULT)\]/.test(l))
      .map((l) => l.split(' ')[0]);
    assert.deepEqual(stream, [
      '[CONTENT_DELTA]',
      '[BLOCK_RESET]',
      '[CONTENT_DELTA]',
      '[BLOCK_RESET]',
      '[MESSAGE]',
      '[TOOL_RESULT]',
      '[CONTENT_DELTA]',
      '[MESSAGE]',
    ]);
    assert.deepEqual(finalContent(lines), [
      { type: 'text', text: 'Before.' },
      { type: 'text', text: 'While running.' },
      { type: 'text', text: 'After.' },
    ]);
  });

  it('dedups snapshots of the reply that follows a late tool card', () => {
    const { n, lines } = recorder();
    say(n, 'Before.');
    sendUpdate(n, { sessionUpdate: 'tool_call', toolCallId: 'call-slow', name: 'grep', status: 'in_progress' });
    say(n, 'While running.');
    sendUpdate(n, { sessionUpdate: 'tool_call_update', toolCallId: 'call-slow', status: 'completed' });
    // The reply after the tool result is snapshotted from its own start.
    say(n, 'Af');
    say(n, 'After.');
    n.finishSuccess('sess-late-card-snapshot');

    assert.deepEqual(deltas(lines, '[CONTENT_DELTA] '), ['Before.', 'While running.', 'Af', 'ter.']);
    assert.deepEqual(finalContent(lines), [
      { type: 'text', text: 'Before.' },
      { type: 'text', text: 'While running.' },
      { type: 'text', text: 'After.' },
    ]);
  });

  it('keeps the whole reply, segment by segment, as the success envelope result', () => {
    const { n, lines } = recorder();
    say(n, 'Before.');
    sendUpdate(n, finishedGrep);
    say(n, 'After.');
    n.finishSuccess('sess-envelope', n.assistantText);

    const envelope = JSON.parse(lines.find((l) => l.startsWith('{')));
    assert.equal(envelope.success, true);
    assert.equal(envelope.result, 'Before.\n\nAfter.');
  });

  it('leaves whitespace-only segments out of the success envelope result', () => {
    const { n, lines } = recorder();
    say(n, ' ');
    sendUpdate(n, finishedGrep);
    say(n, 'Only answer.');
    n.finishSuccess('sess-envelope-blank', n.assistantText);

    const envelope = JSON.parse(lines.find((l) => l.startsWith('{')));
    assert.equal(envelope.result, 'Only answer.');
  });
});
