import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialEventState,
  processCodexEventStream,
  isIgnorableWindowsTerminationNoiseLine,
  shouldSuppressCodexStreamParseErrorAfterCompletion,
} from './codex-event-handler.js';

async function* eventsFrom(items) {
  for (const item of items) {
    yield item;
  }
}

async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    captured.push(text);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

function tagLines(captured, tag) {
  return captured.filter((line) => line.startsWith(tag));
}

function makeConfig() {
  return {
    cwd: undefined,
    threadId: null,
    threadOptions: {},
    normalizedPermissionMode: 'default',
    turnAbortController: new AbortController(),
  };
}

test('Codex item.updated agent_message emits incremental content deltas before completion', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  const captured = await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'item.updated',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hel' },
        },
        {
          type: 'item.updated',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
        },
        {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(deltaLines.length, 2);
  assert.match(deltaLines[0], /"Hel"/);
  assert.match(deltaLines[1], /"lo"/);
  assert.equal(state.assistantText, 'Hello');
  assert.equal(emittedMessages.length, 1);
  assert.deepEqual(emittedMessages[0], {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    },
  });
});

test('recognizes localized Windows termination noise lines', () => {
  assert.equal(
    isIgnorableWindowsTerminationNoiseLine('SUCCESS: The process with PID 41032 (child process of PID 20716) has been terminated.'),
    true,
  );
  assert.equal(
    isIgnorableWindowsTerminationNoiseLine('成功: 已终止 PID 37392 (属于 PID 38456 子进程) 的进程。'),
    true,
  );
  assert.equal(
    isIgnorableWindowsTerminationNoiseLine('Failed to parse item: something else'),
    false,
  );
});

test('suppresses post-completion parse errors caused by Windows termination noise', () => {
  const state = createInitialEventState(() => {});
  state.turnCompletedObserved = true;

  assert.equal(
    shouldSuppressCodexStreamParseErrorAfterCompletion(
      'Failed to parse item: 成功: 已终止 PID 37392 (属于 PID 38456 子进程) 的进程。',
      state,
    ),
    true,
  );

  state.turnCompletedObserved = false;
  assert.equal(
    shouldSuppressCodexStreamParseErrorAfterCompletion(
      'Failed to parse item: 成功: 已终止 PID 37392 (属于 PID 38456 子进程) 的进程。',
      state,
    ),
    false,
  );
});
