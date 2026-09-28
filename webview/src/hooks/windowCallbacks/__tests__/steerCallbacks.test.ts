/**
 * steerCallbacks.test.ts
 *
 * The steered bubble is inserted optimistically when the user clicks steer, so
 * these receipts decide its fate:
 * - folded      → keep it, clear the pending marker, append the segment-2 bubble;
 * - rejected    → retract it and put the queue row back;
 * - undelivered → retract it and requeue the item at the head.
 */
import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { registerSteerCallbacks } from '../registerCallbacks/steerCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';
import { buildSteeredUserMessage } from '../../../utils/steerMessages';
import type { QueuedMessage } from '../../useMessageQueue';

type Ref<T> = { current: T };
const ref = <T,>(value: T): Ref<T> => ({ current: value });

const STEER_ID = 'queue-1';

function createHarness(initialMessages: ClaudeMessage[]) {
  let messages = [...initialMessages];
  const steeringItems = new Map<string, QueuedMessage>();
  /** What the controller's findSteeredBubble would return; settable per test. */
  let findSteeredBubbleResult: QueuedMessage | null = null;
  const calls = {
    markSteering: [] as string[],
    restore: [] as Array<[string, QueuedMessage | undefined]>,
    requeueAtHead: [] as QueuedMessage[],
    dequeue: [] as string[],
    toasts: [] as string[],
  };

  const refs = {
    turnIdCounterRef: ref(0),
    streamingTurnIdRef: ref(-1),
    streamingContentRef: ref('streamed'),
    streamingThinkingRef: ref(''),
    streamingMessageIndexRef: ref(-1),
  };

  const options = {
    ...refs,
    setMessages: (updater: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    },
    addToast: (message: string) => { calls.toasts.push(message); },
    messageQueueSteerRef: ref({
      markSteering: (id: string) => { calls.markSteering.push(id); },
      restore: (id: string, fallback?: QueuedMessage) => { calls.restore.push([id, fallback]); },
      requeueAtHead: (item: QueuedMessage) => { calls.requeueAtHead.push(item); },
      dequeue: (id: string) => { calls.dequeue.push(id); },
      steeringItemsRef: ref(steeringItems),
      findSteeredBubble: () => findSteeredBubbleResult,
      steerMessage: () => true,
    }),
  } as unknown as UseWindowCallbacksOptions;

  registerSteerCallbacks(options, ref(((key: string) => key) as unknown as TFunction));
  return {
    calls,
    refs,
    getMessages: () => messages,
    steeringItems,
    setFindSteeredBubbleResult: (item: QueuedMessage | null) => { findSteeredBubbleResult = item; },
  };
}

/** The optimistic bubble exactly as useMessageSender builds it. */
const optimisticBubble = (): ClaudeMessage => buildSteeredUserMessage(
  'do not touch file B',
  [{ type: 'text', text: 'do not touch file B' }],
  STEER_ID,
);

const streamingAssistant: ClaudeMessage = {
  type: 'assistant',
  content: 'segment 1',
  isStreaming: true,
  __turnId: 1,
};

describe('steerCallbacks', () => {
  it('rejected retracts the optimistic bubble and restores the queue row', () => {
    const { calls, getMessages } = createHarness([streamingAssistant, optimisticBubble()]);

    window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'rejected', reason: 'no_active_turn' }));

    expect(getMessages()).toHaveLength(1);
    expect(getMessages()[0].type).toBe('assistant');
    expect(calls.restore).toEqual([[STEER_ID, undefined]]);
    expect(calls.toasts).toHaveLength(1);
  });

  it('rejected passes the bubble fallback to restore when the map lost the row', () => {
    const { calls, setFindSteeredBubbleResult } = createHarness([streamingAssistant, optimisticBubble()]);
    const rebuilt: QueuedMessage = { id: STEER_ID, content: 'do not touch file B', queuedAt: 1, status: 'queued' };
    setFindSteeredBubbleResult(rebuilt);

    window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'rejected', reason: 'session_mismatch' }));

    expect(calls.restore).toEqual([[STEER_ID, rebuilt]]);
    expect(calls.toasts).toHaveLength(1);
  });

  it('undelivered retracts the bubble and requeues the item at the head', () => {
    const { calls, getMessages, steeringItems } = createHarness([streamingAssistant, optimisticBubble()]);
    const item: QueuedMessage = {
      id: STEER_ID, content: 'do not touch file B', queuedAt: 1, status: 'steering',
    };
    steeringItems.set(STEER_ID, item);

    window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'undelivered' }));

    expect(getMessages()).toHaveLength(1);
    expect(calls.requeueAtHead).toEqual([item]);
    // TC-07 expects visible feedback even when the recovery succeeds.
    expect(calls.toasts).toEqual(['chat.steerUndelivered']);
  });

  it('undelivered rebuilds the queue item from the bubble when the map misses it', () => {
    // Steer plan F1/B1: a receipt that outlives the steering map (e.g. a
    // session transition cleared it) must still requeue — from the bubble.
    const { calls, getMessages, setFindSteeredBubbleResult } = createHarness([
      streamingAssistant,
      optimisticBubble(),
    ]);
    const rebuilt: QueuedMessage = { id: STEER_ID, content: 'do not touch file B', queuedAt: 1, status: 'queued' };
    setFindSteeredBubbleResult(rebuilt);

    window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'undelivered' }));

    expect(getMessages()).toHaveLength(1);
    expect(calls.requeueAtHead).toEqual([rebuilt]);
    expect(calls.toasts).toEqual(['chat.steerUndelivered']);
  });

  it('undelivered warns instead of silently dropping an unrecoverable message', () => {
    const { calls, getMessages, setFindSteeredBubbleResult } = createHarness([streamingAssistant]);
    setFindSteeredBubbleResult(null);

    window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'undelivered' }));

    expect(calls.requeueAtHead).toHaveLength(0);
    expect(calls.toasts).toHaveLength(1);
    expect(calls.toasts[0]).toBe('chat.steerUndeliveredLost');
    // No bubble was present to begin with, so the message list is untouched.
    expect(getMessages()).toHaveLength(1);
  });

  it('fold clears the pending marker instead of inserting a second user row', () => {
    const { calls, refs, getMessages } = createHarness([streamingAssistant, optimisticBubble()]);

    window.onSteerFolded!(JSON.stringify({
      steerId: STEER_ID,
      message: { type: 'user', content: 'do not touch file B', timestamp: 1, raw: { steered: true } },
    }));

    const messages = getMessages();
    expect(messages.filter((m) => m.type === 'user')).toHaveLength(1);
    expect(messages[1]).toMatchObject({ steered: true, steerPending: false, isOptimistic: false });
    // Segment 1 is settled and segment 2 gets a fresh streaming placeholder.
    expect(messages[0].isStreaming).toBe(false);
    expect(messages[2]).toMatchObject({ type: 'assistant', isStreaming: true, content: '' });
    expect(calls.dequeue).toEqual([STEER_ID]);
    // The placeholder is the streaming target, and the stale segment-1 buffer is dropped.
    expect(refs.streamingMessageIndexRef.current).toBe(2);
    expect(refs.streamingContentRef.current).toBe('');
  });

  it('fold without an optimistic bubble inserts the user row once', () => {
    const { getMessages } = createHarness([streamingAssistant]);

    window.onSteerFolded!(JSON.stringify({
      steerId: STEER_ID,
      message: { type: 'user', content: 'do not touch file B', timestamp: 1, raw: {} },
    }));

    const messages = getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ type: 'user', steered: true });
    expect(messages[2]).toMatchObject({ type: 'assistant', isStreaming: true });
  });
});
