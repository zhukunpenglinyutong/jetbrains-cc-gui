/**
 * streamingCallbacks.test.ts
 *
 * onStreamStart bubble routing:
 * - a still-streaming assistant from an OLDER turn (dropped onStreamEnd) is
 *   finalized and new deltas land on a fresh bubble;
 * - a replay start REUSES the last assistant bubble — the stale-bubble
 *   finalize must not hijack that path (it would strand the replayed turn's
 *   earlier content in a duplicate bubble);
 * - the normal path appends a fresh streaming bubble.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerStreamingCallbacks } from './streamingCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';

type Ref<T> = { current: T };
const ref = <T,>(value: T): Ref<T> => ({ current: value });

function createHarness(initialMessages: ClaudeMessage[], turnIdCounter: number) {
  let messages = [...initialMessages];
  let blockResetCount = 0;

  const refs = {
    streamingContentRef: ref(''),
    streamingThinkingRef: ref(''),
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    autoExpandedThinkingKeysRef: ref(new Set<string>()),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    turnIdCounterRef: ref(turnIdCounter),
    recordStreamingBlockReset: () => { blockResetCount += 1; },
    lastContentUpdateRef: ref(0),
    contentUpdateTimeoutRef: ref<number | null>(null),
    lastThinkingUpdateRef: ref(0),
    thinkingUpdateTimeoutRef: ref<number | null>(null),
    currentProviderRef: ref('claude'),
  };

  const options = {
    ...refs,
    setMessages: (updater: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    },
    setStreamingActive: () => {},
    setLoading: () => {},
    setLoadingStartTime: () => {},
    setIsThinking: () => {},
    setExpandedThinking: () => {},
    getOrCreateStreamingAssistantIndex: () => -1,
    patchAssistantForStreaming: (message: ClaudeMessage) => message,
    findLastAssistantIndex: (list: ClaudeMessage[]) =>
      list.reduce((acc, m, i) => (m.type === 'assistant' ? i : acc), -1),
  } as unknown as UseWindowCallbacksOptions;

  registerStreamingCallbacks(options);
  return { refs, getMessages: () => messages, getBlockResetCount: () => blockResetCount };
}

describe('onStreamStart bubble routing', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
  });

  afterEach(() => {
    // registerStreamingCallbacks starts a stall watchdog on stream start.
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  });

  it('records block reset boundaries without clearing the active stream', () => {
    const { getBlockResetCount, refs } = createHarness([], 0);

    window.onStreamStart!();
    window.onBlockReset!();

    expect(getBlockResetCount()).toBe(1);
    expect(refs.isStreamingRef.current).toBe(true);
  });

  const olderTurnStreamingAssistant: ClaudeMessage = {
    type: 'assistant',
    content: 'partial answer from turn 1',
    isStreaming: true,
    __turnId: 1,
  };

  it('finalizes a still-streaming assistant from an older turn and opens a fresh bubble', () => {
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }, { ...olderTurnStreamingAssistant }],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(3);
    // The orphaned bubble is closed with its content intact...
    expect(messages[1].isStreaming).toBe(false);
    expect(messages[1].content).toBe('partial answer from turn 1');
    // ...and the new turn streams into a fresh bubble.
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].isStreaming).toBe(true);
    expect(messages[2].content).toBe('');
    expect(messages[2].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(2);
  });

  it('replay start reuses the last assistant bubble even when it is a stale streaming one', () => {
    // Regression: the stale-bubble finalize must not run before the replay
    // branch. A replay re-delivers the last turn into the LAST bubble; adding
    // a fresh bubble here would duplicate the partial content on screen.
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }, { ...olderTurnStreamingAssistant }],
      1,
    );

    window.onStreamStart!('replay');

    const messages = getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].content).toBe('partial answer from turn 1');
    expect(messages[1].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });

  it('appends a fresh streaming bubble on the normal path (last assistant already finalized)', () => {
    const { refs, getMessages } = createHarness(
      [
        { type: 'user', content: 'q1' },
        { type: 'assistant', content: 'finished answer', isStreaming: false, __turnId: 1 },
      ],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[1].isStreaming).toBe(false);
    expect(messages[1].content).toBe('finished answer');
    expect(messages[2].isStreaming).toBe(true);
    expect(messages[2].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(2);
  });

  it('does not finalize history assistants without a __turnId', () => {
    // History messages loaded from JSONL have no __turnId; they are never
    // "streaming leftovers" of this webview instance and must be left as-is.
    const { getMessages } = createHarness(
      [{ type: 'assistant', content: 'history entry', isStreaming: true }],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].isStreaming).toBe(true);
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].__turnId).toBe(2);
  });

  it('reuses an EMPTY older streaming bubble instead of leaving a blank ghost', () => {
    // Regression for duplicated/ghost bubbles: an empty streaming bubble from an
    // older turn (a redundant STREAM_START, or one with no deltas yet) must be
    // reused for the new turn — not finalized as a blank message with a fresh
    // bubble appended after it.
    const { refs, getMessages } = createHarness(
      [
        { type: 'user', content: 'q1' },
        { type: 'assistant', content: '', isStreaming: true, __turnId: 1 },
      ],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    // No extra bubble: the empty placeholder is reused for turn 2.
    expect(messages).toHaveLength(2);
    expect(messages[1].type).toBe('assistant');
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].content).toBe('');
    expect(messages[1].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });

  it('does not create a ghost bubble when onStreamStart fires twice with no deltas', () => {
    // Duplicate STREAM_START delivery: two starts back-to-back before any delta.
    // Must end with exactly one streaming bubble, not two.
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }],
      0,
    );

    window.onStreamStart!(); // turn 1 bubble (empty)
    window.onStreamStart!(); // duplicate — must reuse, not append

    const messages = getMessages();
    const assistantBubbles = messages.filter((m) => m.type === 'assistant');
    expect(assistantBubbles).toHaveLength(1);
    expect(assistantBubbles[0].isStreaming).toBe(true);
    expect(assistantBubbles[0].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });
});

describe('onStreamEnd finalizes dangling tool_use when the turn never streamed', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__deniedToolIds = undefined;
  });

  afterEach(() => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
    window.__deniedToolIds = undefined;
  });

  const assistantWithToolUse = (id: string): ClaudeMessage => ({
    type: 'assistant',
    content: '',
    raw: { message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } },
  });

  it('marks an unresolved tool_use as denied on a non-streaming/error turn (skip mode)', () => {
    // Reproduces "API request failed but the last tool just spins": the turn
    // never streamed (isStreaming=false, turnId=-1 → skip mode), an assistant
    // emitted a tool_use, and the error arrives before any tool_result. The
    // tool must be marked denied so it stops spinning.
    const { getMessages } = createHarness(
      [{ type: 'user', content: 'run ls' }, assistantWithToolUse('tool-1')],
      0,
    );

    // No onStreamStart happened; streaming refs are at their idle defaults.
    window.onStreamEnd!();

    expect(window.__deniedToolIds).toBeDefined();
    expect(window.__deniedToolIds!.has('tool-1')).toBe(true);
    // The list gets a new reference so the denied tool card re-renders.
    expect(getMessages()).toHaveLength(2);
  });

  it('does not lose a tool-only assistant carried only by the pending backend snapshot', () => {
    const initialMessages: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: '',
        isStreaming: true,
        __turnId: 1,
      },
    ];

    const { refs, getMessages } = createHarness(initialMessages, 1);
    refs.isStreamingRef.current = true;
    refs.streamingMessageIndexRef.current = 0;
    refs.streamingTurnIdRef.current = 1;

    window.__pendingUpdateJson = JSON.stringify([
      {
        type: 'assistant',
        content: '',
        raw: {
          message: {
            content: [
              { type: 'tool_use', id: 'tool-only', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        },
      },
    ]);

    window.onStreamEnd!('1');

    const raw = getMessages()[0].raw as any;
    const blocks = raw?.message?.content ?? [];
    expect(blocks.some((block: any) =>
      block?.type === 'tool_use' && block.id === 'tool-only'
    )).toBe(true);
  });

  it('is a no-op when the tool_use already has a matching tool_result', () => {
    const { getMessages } = createHarness(
      [
        { type: 'user', content: 'run ls' },
        assistantWithToolUse('tool-2'),
        {
          type: 'user',
          content: '[tool_result]',
          raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] } },
        },
      ],
      0,
    );
    const before = getMessages();

    window.onStreamEnd!();

    // Nothing dangling → no id denied, and the list reference is unchanged.
    expect(window.__deniedToolIds?.has('tool-2') ?? false).toBe(false);
    expect(getMessages()).toBe(before);
  });
});

describe('onStreamEnd append guard for a pending backend snapshot', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    delete (window as any).__pendingUpdateJson;
    delete (window as any).__deniedToolIds;
    // onStreamEnd records the finalized turn id; without clearing it the next
    // case reusing the same turn id would take the idempotency early-return.
    delete (window as any).__streamEndProcessedTurnId;
    void harness;
  });

  it('does not overwrite another assistant at a stale but valid index', () => {
    const older: ClaudeMessage = {
      type: 'assistant', content: 'older answer', __turnId: 1,
      raw: { uuid: 'older', message: { content: [{ type: 'text', text: 'older answer' }] } },
    } as unknown as ClaudeMessage;
    harness = createHarness([older], 2);
    harness.refs.isStreamingRef.current = true;
    harness.refs.streamingMessageIndexRef.current = 0;
    harness.refs.streamingTurnIdRef.current = 2;
    window.__pendingUpdateJson = JSON.stringify([{
      type: 'assistant', content: 'new answer',
      raw: { uuid: 'new', message: { content: [{ type: 'text', text: 'new answer' }] } },
    }]);

    window.onStreamEnd!('1');

    expect(harness.getMessages().map(message => message.content)).toEqual(['older answer', 'new answer']);
    expect(harness.getMessages()[0]).toEqual(older);
  });

  it('finds an existing UUID before the last assistant even when raw is a JSON string', () => {
    const existing: ClaudeMessage = {
      type: 'assistant', content: 'answer',
      raw: JSON.stringify({ uuid: 'matching', message: { content: [{ type: 'text', text: 'answer' }] } }),
    } as unknown as ClaudeMessage;
    harness = createHarness([existing, { type: 'assistant', content: 'later answer' }], 1);
    harness.refs.isStreamingRef.current = true;
    harness.refs.streamingTurnIdRef.current = 1;
    window.__pendingUpdateJson = JSON.stringify([{
      ...existing, raw: { uuid: 'matching', message: { content: [{ type: 'text', text: 'answer' }] } },
    }]);

    window.onStreamEnd!('1');

    expect(harness.getMessages()).toHaveLength(2);
    expect(harness.getMessages()[1].content).toBe('later answer');
  });

  it('patches the existing assistant instead of appending a duplicate bubble', () => {
    // The list already holds this turn's assistant, finalized by an earlier path
    // and carrying no __turnId (so the scan above cannot find it). The pending
    // snapshot must land on it: appending would render two bubbles for one answer.
    const existing: ClaudeMessage = {
      type: 'assistant',
      content: 'answer',
      isStreaming: false,
      raw: { uuid: 'turn-1', message: { content: [{ type: 'text', text: 'answer' }] } },
    } as unknown as ClaudeMessage;

    harness = createHarness([existing], 1);
    harness.refs.isStreamingRef.current = true;
    // The snapshot index is stale, and the turn id belongs to a turn the list has
    // no message for — both primary lookups miss, leaving only the identity guard.
    harness.refs.streamingMessageIndexRef.current = -1;
    harness.refs.streamingTurnIdRef.current = 2;

    window.__pendingUpdateJson = JSON.stringify([
      {
        type: 'assistant',
        content: 'answer',
        raw: { uuid: 'turn-1', message: { content: [{ type: 'text', text: 'answer' }] } },
      },
    ]);

    window.onStreamEnd!('1');

    expect(harness.getMessages()).toHaveLength(1);
    expect(harness.getMessages()[0].content).toBe('answer');
  });

  it('appends when the pending assistant is genuinely new to the list', () => {
    harness = createHarness([], 1);
    harness.refs.isStreamingRef.current = true;
    harness.refs.streamingTurnIdRef.current = 1;

    window.__pendingUpdateJson = JSON.stringify([
      {
        type: 'assistant',
        content: 'fresh',
        raw: { uuid: 'turn-9', message: { content: [{ type: 'text', text: 'fresh' }] } },
      },
    ]);

    window.onStreamEnd!('1');

    expect(harness.getMessages()).toHaveLength(1);
    expect(harness.getMessages()[0].content).toBe('fresh');
  });

  it('patches the turn-stamped bubble even when its uuid lags the final snapshot', () => {
    // The backend row's uuid rotates per tool-loop iteration (Java's
    // MessageMerger copies every top-level field, uuid included, onto the single
    // live row), and the bubble inherits it from its last APPLIED flush. When the
    // turn ends right after a tool iteration — instant denial, instant error,
    // abort — the final flush is still parked in __pendingUpdateJson, so the
    // bubble carries iteration N's uuid against the snapshot's N+1. That conflict
    // must not append a second bubble: the __turnId stamp already proves the
    // bubble belongs to the ended turn.
    const bubble: ClaudeMessage = {
      type: 'assistant', content: 'partial', isStreaming: true, __turnId: 1,
      raw: { uuid: 'iter-1', message: { content: [{ type: 'text', text: 'partial' }] } },
    } as unknown as ClaudeMessage;
    harness = createHarness([bubble], 1);
    harness.refs.isStreamingRef.current = true;
    harness.refs.streamingMessageIndexRef.current = 0;
    harness.refs.streamingTurnIdRef.current = 1;

    window.__pendingUpdateJson = JSON.stringify([{
      type: 'assistant', content: 'final answer',
      raw: { uuid: 'iter-2', message: { content: [{ type: 'text', text: 'final answer' }] } },
    }]);

    window.onStreamEnd!('1');

    expect(harness.getMessages()).toHaveLength(1);
    expect(harness.getMessages()[0].content).toBe('final answer');
    expect(harness.getMessages()[0].isStreaming).toBe(false);
  });

  it('does not patch a still-streaming assistant with a provably different uuid', () => {
    // A streaming bubble from another turn sits last in the list. The pending
    // snapshot carries a different uuid, so the isStreaming fallback must reject
    // it and append instead — patching would overwrite unrelated content.
    const otherTurn: ClaudeMessage = {
      type: 'assistant',
      content: 'other turn',
      isStreaming: true,
      raw: { uuid: 'turn-other', message: { content: [{ type: 'text', text: 'other turn' }] } },
    } as unknown as ClaudeMessage;

    harness = createHarness([otherTurn], 1);
    harness.refs.isStreamingRef.current = true;
    harness.refs.streamingMessageIndexRef.current = -1;
    harness.refs.streamingTurnIdRef.current = 2;

    window.__pendingUpdateJson = JSON.stringify([
      {
        type: 'assistant',
        content: 'incoming',
        raw: { uuid: 'turn-1', message: { content: [{ type: 'text', text: 'incoming' }] } },
      },
    ]);

    window.onStreamEnd!('1');

    expect(harness.getMessages()).toHaveLength(2);
    expect(harness.getMessages()[1].content).toBe('incoming');
    // The conflicting streaming bubble is left untouched.
    expect(harness.getMessages()[0].content).toBe('other turn');
    expect(harness.getMessages()[0].isStreaming).toBe(true);
  });
});
