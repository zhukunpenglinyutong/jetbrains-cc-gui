import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTurnState,
  processMessageContent,
  processStreamEvent,
} from './stream-event-processor.js';

function captureStdout(fn) {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }
    return true;
  };

  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return writes.join('');
}

function createStreamingTurnState() {
  return createTurnState(
    { streamingEnabled: true, requestedSessionId: '' },
    { sessionId: '' },
  );
}

test('stream deltas from cumulative providers only emit the novel suffix', () => {
  const state = createStreamingTurnState();

  const output = captureStdout(() => {
    processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
    }, state);

    processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello world' },
      },
    }, state);
  });

  assert.equal(output, '[CONTENT_DELTA] "hello"\n[CONTENT_DELTA] " world"\n');
  assert.equal(state.lastAssistantContent, 'hello world');
});

test('stream deltas with an overlapping replay window only emit the novel tail', () => {
  const state = createStreamingTurnState();

  const output = captureStdout(() => {
    processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: '实现方式非常巧妙，不给每条通知打已读标记',
        },
      },
    }, state);

    processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: '不给每条通知打已读标记，而是只记录一个时间戳',
        },
      },
    }, state);
  });

  assert.equal(
    output,
    '[CONTENT_DELTA] "实现方式非常巧妙，不给每条通知打已读标记"\n[CONTENT_DELTA] "，而是只记录一个时间戳"\n',
  );
  assert.equal(
    state.lastAssistantContent,
    '实现方式非常巧妙，不给每条通知打已读标记，而是只记录一个时间戳',
  );
});

test('assistant snapshots during stream do not re-emit unrelated mid-message tails', () => {
  const state = createStreamingTurnState();
  state.hasStreamEvents = true;

  captureStdout(() => {
    processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '用户最后一次查看通知的时间。' },
      },
    }, state);
  });

  const output = captureStdout(() => {
    processMessageContent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: '这个功能要解决的问题是：你有 X 条未读通知。实现方式非常巧妙。',
          },
        ],
      },
    }, state);
  });

  assert.equal(output, '');
  assert.equal(state.lastAssistantContent, '用户最后一次查看通知的时间。');
});

test('assistant snapshots during stream ignore weak suffix-prefix overlap', () => {
  const state = createStreamingTurnState();
  state.hasStreamEvents = true;

  captureStdout(() => {
    processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '通知。' },
      },
    }, state);
  });

  const output = captureStdout(() => {
    processMessageContent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: '。实现方式非常巧妙。',
          },
        ],
      },
    }, state);
  });

  assert.equal(output, '');
  assert.equal(state.lastAssistantContent, '通知。');
});

test('fallback assistant snapshots emit separate text blocks independently', () => {
  const state = createStreamingTurnState();

  const output = captureStdout(() => {
    processMessageContent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first block' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          { type: 'text', text: 'second block' },
        ],
      },
    }, state);
  });

  assert.equal(
    output,
    '[CONTENT_DELTA] "first block"\n[CONTENT_DELTA] "second block"\n',
  );
  assert.equal(state.lastAssistantContent, 'first blocksecond block');
});
