import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createInitialEventState,
  isWindowsTaskkillParseNoise,
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

function sessionLine(payload) {
  return JSON.stringify({
    timestamp: '2026-06-08T07:00:00.000Z',
    type: 'response_item',
    payload,
  });
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

test('Codex agent_message completion with different item id does not replay identical text delta', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  const text = '好的，我继续基于之前的探索结果来设计方案并实现。';
  const captured = await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'item.updated',
          item: { id: 'msg-updated', type: 'agent_message', text },
        },
        {
          type: 'item.completed',
          item: { id: 'msg-completed', type: 'agent_message', text },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(deltaLines.length, 1);
  assert.match(deltaLines[0], new RegExp(JSON.stringify(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(state.assistantText, text);
  assert.equal(emittedMessages.length, 1);
});

test('Codex new thread replays function calls from current thread session file during stream', async () => {
  const originalSessionsDir = process.env.CODEX_SESSIONS_DIR;
  const fakeHome = join(tmpdir(), `codex-event-handler-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const threadId = 'thread-live-tools';
  const sessionsDir = join(fakeHome, '.codex', 'sessions', '2026', '06', '08');
  const sessionFile = join(sessionsDir, `rollout-2026-06-08T07-00-00-${threadId}.jsonl`);
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(sessionFile, '', 'utf8');
  process.env.CODEX_SESSIONS_DIR = join(fakeHome, '.codex', 'sessions');

  try {
    async function* liveEvents() {
      yield { type: 'thread.started', thread_id: threadId };
      yield { type: 'turn.started' };
      await writeFile(
        sessionFile,
        [
          sessionLine({
            type: 'function_call',
            call_id: 'call-read',
            name: 'shell_command',
            arguments: JSON.stringify({ command: 'cat README.md' }),
          }),
          sessionLine({
            type: 'function_call_output',
            call_id: 'call-read',
            output: 'README content',
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      yield { type: 'event_msg', payload: { type: 'token_count' } };
    }

    const emittedMessages = [];
    const state = createInitialEventState((message) => emittedMessages.push(message));
    await processCodexEventStream(
      liveEvents(),
      state,
      makeConfig(),
    );

    assert.equal(emittedMessages.length, 2);
    assert.equal(emittedMessages[0].type, 'assistant');
    assert.equal(emittedMessages[0].message.content[0].type, 'tool_use');
    assert.equal(emittedMessages[1].type, 'user');
    assert.equal(emittedMessages[1].message.content[0].type, 'tool_result');
  } finally {
    if (originalSessionsDir === undefined) {
      delete process.env.CODEX_SESSIONS_DIR;
    } else {
      process.env.CODEX_SESSIONS_DIR = originalSessionsDir;
    }
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test('isWindowsTaskkillParseNoise: matches English SUCCESS taskkill output', () => {
  const message =
    'Failed to parse item: SUCCESS: The process with PID 12345 (child process of PID 67890) has been terminated.';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: matches Chinese 成功 taskkill output', () => {
  const message = 'Failed to parse item: 成功: 进程 PID 12345 (PID 67890 的子进程) 已被终止';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: matches mojibake (replacement char) with PID pair', () => {
  const message = 'Failed to parse item: ���: PID 12345 PID 67890 ��';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: ignores message without "Failed to parse item:" prefix', () => {
  const message = 'SUCCESS: process PID 12345 (child PID 67890) terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: ignores message with only a single PID', () => {
  const message = 'Failed to parse item: SUCCESS: process PID 12345 terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: ignores real Codex parse errors without taskkill keywords', () => {
  const message = 'Failed to parse item: {"id":"msg-1","type":"agent_message"';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: returns false for non-string input', () => {
  assert.equal(isWindowsTaskkillParseNoise(null), false);
  assert.equal(isWindowsTaskkillParseNoise(undefined), false);
  assert.equal(isWindowsTaskkillParseNoise(42), false);
  assert.equal(isWindowsTaskkillParseNoise({ msg: 'x' }), false);
});

test('isWindowsTaskkillParseNoise: returns false for empty payload after prefix', () => {
  assert.equal(isWindowsTaskkillParseNoise('Failed to parse item:'), false);
  assert.equal(isWindowsTaskkillParseNoise('Failed to parse item:   '), false);
});

test('isWindowsTaskkillParseNoise: matches when only "terminated" keyword present with PID pair', () => {
  const message = 'Failed to parse item: PID 100 PID 200 process tree terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
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
    isIgnorableWindowsTerminationNoiseLine('�ɹ�: ����ֹ PID 42484 (���� PID 47728 �ӽ���)�Ľ��̡�'),
    true,
  );
  assert.equal(
    isIgnorableWindowsTerminationNoiseLine('�ɹ�: ����ֹ PID 38792 (���� PID 49056 �ӽ���)�Ľ��̡�'),
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
  assert.equal(
    shouldSuppressCodexStreamParseErrorAfterCompletion(
      'Failed to parse item: �ɹ�: ����ֹ PID 42484 (���� PID 47728 �ӽ���)�Ľ��̡�',
      state,
    ),
    true,
  );
  assert.equal(
    shouldSuppressCodexStreamParseErrorAfterCompletion(
      'Failed to parse item: �ɹ�: ����ֹ PID 38792 (���� PID 49056 �ӽ���)�Ľ��̡�',
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

test('Codex event stream stops waiting when abort signal fires', async () => {
  const state = createInitialEventState(() => {});
  const controller = new AbortController();
  let returnCalled = false;

  const events = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise(() => {});
        },
        async return() {
          returnCalled = true;
          return { done: true };
        },
      };
    },
  };

  const processing = processCodexEventStream(events, state, {
    ...makeConfig(),
    turnAbortController: controller,
  });

  controller.abort();
  await processing;

  assert.equal(state.userAbortObserved, true);
  assert.equal(state.suppressNoResponseFallback, true);
  assert.equal(returnCalled, true);
});

test('Codex event stream propagates no-rollout resume failures when not aborted', async () => {
  const state = createInitialEventState(() => {});
  const error = new Error('Codex Exec exited with code 1: thread/resume failed: no rollout found for thread id abc');

  const events = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw error;
        },
      };
    },
  };

  await assert.rejects(
    () => processCodexEventStream(events, state, makeConfig()),
    /no rollout found/,
  );

  assert.equal(state.userAbortObserved, false);
});

test('isWindowsTaskkillParseNoise: matches English SUCCESS taskkill output', () => {
  const message =
    'Failed to parse item: SUCCESS: The process with PID 12345 (child process of PID 67890) has been terminated.';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: matches Chinese 成功 taskkill output', () => {
  const message = 'Failed to parse item: 成功: 进程 PID 12345 (PID 67890 的子进程) 已被终止';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: matches mojibake (replacement char) with PID pair', () => {
  const message = 'Failed to parse item: ���: PID 12345 PID 67890 ��';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: ignores message without "Failed to parse item:" prefix', () => {
  const message = 'SUCCESS: process PID 12345 (child PID 67890) terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: ignores message with only a single PID', () => {
  const message = 'Failed to parse item: SUCCESS: process PID 12345 terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: ignores real Codex parse errors without taskkill keywords', () => {
  const message = 'Failed to parse item: {"id":"msg-1","type":"agent_message"';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: returns false for non-string input', () => {
  assert.equal(isWindowsTaskkillParseNoise(null), false);
  assert.equal(isWindowsTaskkillParseNoise(undefined), false);
  assert.equal(isWindowsTaskkillParseNoise(42), false);
  assert.equal(isWindowsTaskkillParseNoise({ msg: 'x' }), false);
});

test('isWindowsTaskkillParseNoise: returns false for empty payload after prefix', () => {
  assert.equal(isWindowsTaskkillParseNoise('Failed to parse item:'), false);
  assert.equal(isWindowsTaskkillParseNoise('Failed to parse item:   '), false);
});

test('isWindowsTaskkillParseNoise: matches when only "terminated" keyword present with PID pair', () => {
  const message = 'Failed to parse item: PID 100 PID 200 process tree terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});
