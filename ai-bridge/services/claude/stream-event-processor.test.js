import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTurnState,
  processMessageContent,
  processStreamEvent,
  shouldOutputMessage,
} from './stream-event-processor.js';

function makeTurnState(streamingEnabled = true) {
  return createTurnState(
    { streamingEnabled, requestedSessionId: 'sess-test' },
    null
  );
}

function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    captured.push(text);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

function tagLines(captured, tag) {
  return captured.filter((line) => line.startsWith(tag));
}

test('shouldOutputMessage: streaming assistant without tool_use returns false', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello' }] },
  };
  assert.equal(shouldOutputMessage(msg, state), false);
});

test('shouldOutputMessage: streaming assistant with tool_use returns true', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Calling tool' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      ],
    },
  };
  assert.equal(shouldOutputMessage(msg, state), true);
});

test('shouldOutputMessage: streaming assistant with thinking + text but no tool_use returns false', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'pondering' },
        { type: 'text', text: 'answer' },
      ],
    },
  };
  assert.equal(shouldOutputMessage(msg, state), false);
});

test('shouldOutputMessage: non-streaming assistant always returns true', () => {
  const state = makeTurnState(false);
  const msg = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'X' }] },
  };
  assert.equal(shouldOutputMessage(msg, state), true);
});

test('shouldOutputMessage: non-streaming assistant with tool_use returns true', () => {
  const state = makeTurnState(false);
  const msg = {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
    },
  };
  assert.equal(shouldOutputMessage(msg, state), true);
});

test('shouldOutputMessage: non-assistant messages always returned regardless of streaming', () => {
  const state = makeTurnState(true);
  assert.equal(shouldOutputMessage({ type: 'user', message: {} }, state), true);
  assert.equal(shouldOutputMessage({ type: 'system', session_id: 's' }, state), true);
  assert.equal(shouldOutputMessage({ type: 'result', is_error: false }, state), true);
});

test('shouldOutputMessage: streaming assistant with content as plain string returns false (no tool_use possible)', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: { content: 'plain string content' },
  };
  assert.equal(shouldOutputMessage(msg, state), false);
});

test('shouldOutputMessage: streaming assistant with empty/missing content returns false', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  assert.equal(shouldOutputMessage({ type: 'assistant', message: {} }, state), false);
  assert.equal(shouldOutputMessage({ type: 'assistant' }, state), false);
  assert.equal(
    shouldOutputMessage({ type: 'assistant', message: { content: [] } }, state),
    false
  );
});

test('shouldOutputMessage: streaming assistant with multiple tool_use blocks returns true', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Running tools' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Write', input: {} },
      ],
    },
  };
  assert.equal(shouldOutputMessage(msg, state), true);
});

test('end-to-end: streaming pure-text response emits no [MESSAGE], no duplicate [CONTENT_DELTA]', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Simulate SDK stream_event sequence
    processStreamEvent(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      },
      state
    );
    state.hasStreamEvents = true;
    processStreamEvent(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      },
      state
    );

    // SDK then delivers accumulated assistant snapshot
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    };

    // Replay persistent-query-service.executeTurn flow
    if (shouldOutputMessage(assistantMsg, state)) {
      process.stdout.write(`[MESSAGE] ${JSON.stringify(assistantMsg)}\n`);
    }
    processMessageContent(assistantMsg, state);
  });

  const messageLines = tagLines(captured, '[MESSAGE]');
  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(messageLines.length, 0, 'pure-text streaming must not emit [MESSAGE]');
  assert.equal(
    deltaLines.length,
    2,
    'expected 2 deltas (Hello, world), got: ' + JSON.stringify(deltaLines)
  );
  assert.match(deltaLines[0], /"Hello"/);
  assert.match(deltaLines[1], /" world"/);
});

test('end-to-end: streaming with tool_use emits one [MESSAGE] so Java can route the tool call', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Reading file' },
        },
      },
      state
    );

    const assistantMsg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading file' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.txt' } },
        ],
      },
    };

    if (shouldOutputMessage(assistantMsg, state)) {
      process.stdout.write(`[MESSAGE] ${JSON.stringify(assistantMsg)}\n`);
    }
    processMessageContent(assistantMsg, state);
  });

  const messageLines = tagLines(captured, '[MESSAGE]');
  assert.equal(messageLines.length, 1, 'tool_use streaming must emit exactly one [MESSAGE]');
  assert.match(messageLines[0], /"tool_use"/);
});

test('end-to-end: non-streaming pure-text response still emits [MESSAGE] (legacy path)', () => {
  const state = makeTurnState(false);

  const captured = captureStdout(() => {
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    };
    if (shouldOutputMessage(assistantMsg, state)) {
      process.stdout.write(`[MESSAGE] ${JSON.stringify(assistantMsg)}\n`);
    }
  });

  const messageLines = tagLines(captured, '[MESSAGE]');
  assert.equal(messageLines.length, 1, 'non-streaming must keep emitting [MESSAGE]');
});

test('end-to-end: streaming tail-fill snapshot still triggers [CONTENT_DELTA] even when [MESSAGE] suppressed', () => {
  // Verifies that suppressing [MESSAGE] does not break conservative sync:
  // when stream_event coverage lags behind the assistant snapshot,
  // processMessageContent must still emit the missing tail delta.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      },
      state
    );
    state.hasStreamEvents = true;

    // Snapshot has more content than stream_event delivered
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    };

    if (shouldOutputMessage(assistantMsg, state)) {
      process.stdout.write(`[MESSAGE] ${JSON.stringify(assistantMsg)}\n`);
    }
    processMessageContent(assistantMsg, state);
  });

  const messageLines = tagLines(captured, '[MESSAGE]');
  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(messageLines.length, 0, 'pure-text streaming must not emit [MESSAGE]');
  assert.equal(deltaLines.length, 2, 'stream_event delta + tail-fill delta');
  assert.match(deltaLines[0], /"Hello"/);
  assert.match(deltaLines[1], /" world"/);
  assert.equal(state.lastAssistantContent, 'Hello world');
});

test('processStreamEvent: cumulative text deltas only emit the novel suffix', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Now I need to add' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Now I need to add the handler' },
        },
      },
      state
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(deltaLines.length, 2);
  assert.match(deltaLines[0], /"Now I need to add"/);
  assert.match(deltaLines[1], /" the handler"/);
  assert.equal(state.lastAssistantContent, 'Now I need to add the handler');
});

test('processStreamEvent: cumulative thinking deltas are tracked per block index', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Plan step one.' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: '2',
          delta: { type: 'thinking_delta', thinking: 'Plan step two.' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: '2',
          delta: { type: 'thinking_delta', thinking: 'Plan step two. Continue.' },
        },
      },
      state
    );
  });

  const deltaLines = tagLines(captured, '[THINKING_DELTA]');

  assert.equal(deltaLines.length, 3);
  assert.match(deltaLines[0], /"Plan step one\."/);
  assert.match(deltaLines[1], /"Plan step two\."/);
  assert.match(deltaLines[2], /" Continue\."/);
  assert.equal(state.lastThinkingContent, 'Plan step one.Plan step two. Continue.');
});

test('processStreamEvent: snapshot-mode block absorbs corrective rewrites without duplication', () => {
  // Reproduces the duplication observed with mimo-v2.5-pro / GLM / MiniMax: once
  // the provider has confirmed cumulative-snapshot mode (via a startsWith match),
  // a later snapshot that diverges from the accumulated value mid-string (a partial
  // rewrite, typo correction, or token re-translation) must NOT be re-emitted as
  // a fresh delta — that would visibly double every character before the
  // divergence point in the UI.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Delta 1: bootstrap the block
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Now I can see' },
        },
      },
      state
    );
    // Delta 2: cumulative snapshot extending delta 1 — confirms snapshot mode
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Now I can see the actual code. Let me implement' },
        },
      },
      state
    );
    // Delta 3: corrective rewrite — model changed an earlier word (e.g. "actual" →
    // "actuall" with a typo, or paraphrased mid-block).  Neither startsWith nor
    // endsWith matches, so the legacy fall-through emits the entire string.
    // After our fix this branch must absorb the rewrite silently.
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: 'Now I can see the actuall code. Let me implement the changes.',
          },
        },
      },
      state
    );
  });

  const deltaLines = tagLines(captured, '[THINKING_DELTA]');
  const totalEmitted = deltaLines
    .map((line) => JSON.parse(line.replace(/^\[THINKING_DELTA\]\s+/, '').trim()))
    .join('');

  // Pre-fix output would be:
  //   "Now I can see"
  // + " the actual code. Let me implement"
  // + "Now I can see the actuall code. Let me implement the changes."  ← duplicates!
  // After fix the corrective snapshot is absorbed silently and the front-end keeps
  // the longest non-divergent prefix it already accumulated.
  assert.ok(
    !totalEmitted.includes('Now I can seeNow I can see'),
    'Snapshot rewrite must not double the block content. Emitted: ' + JSON.stringify(totalEmitted),
  );
  assert.ok(
    !totalEmitted.includes('Let me implementNow I can see'),
    'Snapshot rewrite must not splice duplicated content (boundary signature). Emitted: ' + JSON.stringify(totalEmitted),
  );
});

test('processStreamEvent: incremental-mode block keeps appending novel deltas', () => {
  // Anthropic-standard providers send genuine incremental fragments where
  // each delta is shorter than the cumulative content.  These must continue
  // to flow through the fall-through path unchanged after the snapshot-mode
  // detection is added.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' world' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '!' },
        },
      },
      state
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(deltaLines.length, 3, 'each incremental fragment should emit');
  assert.match(deltaLines[0], /"Hello"/);
  assert.match(deltaLines[1], /" world"/);
  assert.match(deltaLines[2], /"!"/);
  assert.equal(state.lastAssistantContent, 'Hello world!');
});

// =========================================================================
// REGRESSION TESTS for PR #1205 — character loss + duplication fixes.
//
// These two scenarios are the exact bugs the PR claims to fix.  Without
// dedicated unit coverage the same regression has re-shipped multiple times
// (cf. .claude/rules/codex-history-replay-pitfalls.md "修复 PR 长期未合入
// 主线 = 必然回归" lesson).  Keep these green.
// =========================================================================

test('REGRESSION (PR#1205 bug 1): incremental stream "1","5","0","0" must NOT lose trailing "0" via endsWith match', () => {
  // Pre-fix behaviour: once accumulated content is "150", a subsequent
  // incremental delta "0" was absorbed because previous.endsWith(incoming).
  // The stale-replay check is now gated on snapshot mode, so incremental
  // fragments are emitted intact.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    for (const fragment of ['1', '5', '0', '0']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: fragment },
          },
        },
        state,
      );
    }
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');
  const emitted = deltaLines
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  assert.equal(emitted, '1500', `expected concatenated deltas to equal "1500", got "${emitted}"`);
  assert.equal(deltaLines.length, 4, 'each fragment should emit its own delta');
  assert.equal(state.lastAssistantContent, '1500');
});

test('REGRESSION (PR#1205 bug 1): mid-word incremental fragment whose tail matches previous tail must not be absorbed', () => {
  // Generalisation of the 1500 bug: any incremental fragment that happens
  // to be a suffix of the accumulated content used to be silently dropped.
  // Example: accumulated "abc", next fragment "c" — pre-fix returned "".
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    for (const fragment of ['a', 'b', 'c', 'c']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: fragment },
          },
        },
        state,
      );
    }
  });

  const emitted = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  assert.equal(emitted, 'abcc', `expected "abcc", got "${emitted}"`);
});

test('REGRESSION (PR#1205 bug 2): assistant snapshot for a brand-new block must NOT emit while stream events are active', () => {
  // Pre-fix behaviour: when an interim assistant snapshot delivered content
  // for a block that the stream had not yet populated (typical multi-block
  // response where block 1 starts after block 0 finished), the snapshot
  // emitted the full block text as a [CONTENT_DELTA].  The stream then
  // delivered the same content again → user saw garbled / duplicated output.
  // After the fix, the snapshot path suppresses the emit when the per-block
  // accumulator is still empty and stream events are active.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Block 0 has been fully delivered via stream events.
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      state,
    );
    state.hasStreamEvents = true;

    // Interim assistant snapshot arrives carrying block 0 + a brand-new
    // block 1 whose stream events have not started yet.
    const interimSnapshot = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'Brand new block 1 content' },
        ],
      },
    };
    processMessageContent(interimSnapshot, state);

    // Stream events for block 1 then arrive piece-by-piece.
    for (const fragment of ['Brand ', 'new ', 'block ', '1 ', 'content']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: fragment },
          },
        },
        state,
      );
    }
  });

  const deltaPayloads = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()));

  // No delta should equal the full block-1 snapshot — that would be the
  // duplicate emit the PR fixes.
  assert.ok(
    !deltaPayloads.includes('Brand new block 1 content'),
    `snapshot must not emit the whole new block as a single delta; got payloads: ${JSON.stringify(deltaPayloads)}`,
  );
  // Concatenated stream of block 1 must equal the expected content exactly
  // once — no doubling, no garbled prefix.
  const concatenated = deltaPayloads.join('');
  assert.equal(
    concatenated,
    'HelloBrand new block 1 content',
    `expected exactly one delivery of block 0 + block 1, got "${concatenated}"`,
  );
});

test('REGRESSION (snapshot single-source): processMessageContent absorbs a snapshot-mode mid-stream rewrite instead of mis-slicing it', () => {
  // The snapshot path used to derive its delta with a naive
  // currentText.substring(previousBlock.length), which assumes the snapshot is
  // always a prefix-extension of the accumulated content. When a Claude-compatible
  // provider in cumulative-snapshot mode emits a FINAL assistant message that
  // rewrites the middle of a block (shared prefix, divergent middle, longer
  // overall), the substring sliced an arbitrary tail ("es") and emitted garbage,
  // diverging from the live processStreamEvent path which absorbs the rewrite.
  // Routing the snapshot through resolveSnapshotDelta (the same engine) makes the
  // two paths single-sourced: the corrective rewrite is absorbed (novel === '').
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Two live deltas: the second extends the first → confirms snapshot mode.
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'The result is ' } } },
      state,
    );
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'The result is 42 items' } } },
      state,
    );
    state.hasStreamEvents = true;

    // Final snapshot rewrites the middle: "42 items" → "43 oranges".
    const finalSnapshot = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'The result is 43 oranges' }] },
    };
    processMessageContent(finalSnapshot, state);
  });

  const emitted = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  // Live path emitted "The result is " + "42 items"; the corrective snapshot is
  // absorbed rather than appending a mis-sliced "es" tail (the pre-refactor bug).
  assert.equal(
    emitted,
    'The result is 42 items',
    `snapshot rewrite must be absorbed, not mis-sliced; got "${emitted}"`,
  );
  assert.ok(!emitted.includes('oranges'), 'must not splice the divergent rewrite tail');
});

test('REGRESSION (PR#1205 bug 2): tail-fill is still emitted when block has prior partial content', () => {
  // The suppression in bug 2 must NOT block legitimate tail-fill: when the
  // block already has streamed content and the snapshot extends it, the
  // missing tail must be emitted (otherwise content is silently dropped).
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      state,
    );
    state.hasStreamEvents = true;

    const finalSnapshot = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    };
    processMessageContent(finalSnapshot, state);
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');
  assert.equal(deltaLines.length, 2, 'stream fragment + tail-fill');
  assert.match(deltaLines[0], /"Hello"/);
  assert.match(deltaLines[1], /" world"/);
});
