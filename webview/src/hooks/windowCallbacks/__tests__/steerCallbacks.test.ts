/**
 * steerCallbacks.test.ts
 *
 * The steered bubble is inserted optimistically when the user clicks steer, so
 * these receipts decide its fate:
 * - folded      → keep it, clear the pending marker, append the segment-2 bubble;
 * - rejected    → retract it and put the queue row back;
 * - undelivered → retract it and requeue the item at the head.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TFunction } from 'i18next';
import {
  armSteerReceiptTimeout,
  clearSteerReceiptTimeouts,
  registerSteerCallbacks,
} from '../registerCallbacks/steerCallbacks';
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
  /** What the queue hook reports as still mid-steer; settable per test. */
  let steering = true;
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
      isSteering: () => steering,
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
    setSteering: (next: boolean) => { steering = next; },
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

  it('settles as rejected when no receipt arrives within the backstop window', () => {
    vi.useFakeTimers();
    try {
      const { calls, getMessages } = createHarness([streamingAssistant, optimisticBubble()]);

      armSteerReceiptTimeout(STEER_ID);
      vi.advanceTimersByTime(15_000);

      // The bubble is retracted and the queue row restored, as if Java had
      // answered rejected — the steer can no longer strand in `steering`.
      expect(getMessages()).toHaveLength(1);
      expect(calls.restore).toHaveLength(1);
      expect(calls.restore[0][0]).toBe(STEER_ID);
      expect(calls.toasts).toEqual(['chat.steerRejected.timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a real receipt disarms the backstop', () => {
    vi.useFakeTimers();
    try {
      const { calls } = createHarness([streamingAssistant, optimisticBubble()]);

      armSteerReceiptTimeout(STEER_ID);
      window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'accepted' }));
      vi.advanceTimersByTime(60_000);

      expect(calls.markSteering).toEqual([STEER_ID]);
      expect(calls.restore).toHaveLength(0);
      expect(calls.toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearing on a session switch drops the backstop of the previous session', () => {
    vi.useFakeTimers();
    try {
      const { calls, getMessages } = createHarness([streamingAssistant, optimisticBubble()]);

      armSteerReceiptTimeout(STEER_ID);
      armSteerReceiptTimeout('queue-2');
      clearSteerReceiptTimeouts();
      vi.advanceTimersByTime(60_000);

      // No synthetic reject reaches the freshly opened session.
      expect(calls.restore).toHaveLength(0);
      expect(calls.toasts).toHaveLength(0);
      expect(getMessages()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a malformed receipt instead of throwing', () => {
    const { calls, getMessages } = createHarness([streamingAssistant, optimisticBubble()]);

    expect(() => window.onSteerResult!('{not json')).not.toThrow();
    expect(() => window.onSteerFolded!('null')).not.toThrow();
    expect(() => window.onProviderCapabilities!('oops')).not.toThrow();
    expect(calls.restore).toHaveLength(0);
    expect(getMessages()).toHaveLength(2);
  });

  it('accepted settles a fold that never arrives instead of hiding the row forever', () => {
    vi.useFakeTimers();
    try {
      const { calls, getMessages } = createHarness([streamingAssistant, optimisticBubble()]);

      window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'accepted' }));
      expect(calls.markSteering).toEqual([STEER_ID]);

      // The dispatch backstop is disarmed on accept, so the fold backstop is the
      // only thing left that can settle a fold tag lost on the way back.
      vi.advanceTimersByTime(60_000);
      expect(calls.dequeue).toHaveLength(0);

      vi.advanceTimersByTime(40_000);
      expect(calls.dequeue).toEqual([STEER_ID]);
      // Settled as delivered: the bubble stays (only its pending marker clears)
      // because the CLI already took the message.
      expect(calls.restore).toHaveLength(0);
      expect(getMessages()).toHaveLength(2);
      expect(getMessages()[1].steerPending).toBe(false);
    } finally {
      clearSteerReceiptTimeouts();
      vi.useRealTimers();
    }
  });

  it('a fold disarms the fold backstop', () => {
    vi.useFakeTimers();
    try {
      const { calls } = createHarness([streamingAssistant, optimisticBubble()]);

      window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'accepted' }));
      window.onSteerFolded!(JSON.stringify({
        steerId: STEER_ID,
        message: { type: 'user', content: 'do not touch file B', timestamp: Date.now() },
      }));
      expect(calls.dequeue).toEqual([STEER_ID]);

      vi.advanceTimersByTime(120_000);
      // Folded once, settled once.
      expect(calls.dequeue).toEqual([STEER_ID]);
    } finally {
      clearSteerReceiptTimeouts();
      vi.useRealTimers();
    }
  });

  it('a late accepted receipt does not re-hide a row another receipt restored', () => {
    const { calls, setSteering } = createHarness([streamingAssistant, optimisticBubble()]);

    window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'rejected', reason: 'timeout' }));
    expect(calls.restore).toHaveLength(1);

    // The queue hook no longer holds the item (it was restored), so a late
    // duplicate accept must not flip the visible row back to hidden.
    setSteering(false);
    window.onSteerResult!(JSON.stringify({ steerId: STEER_ID, status: 'accepted' }));

    expect(calls.markSteering).toHaveLength(0);
  });

  it('ignores a fold that lands mid session transition', () => {
    const { calls, getMessages } = createHarness([streamingAssistant]);
    window.__sessionTransitioning = true;
    try {
      window.onSteerFolded!(JSON.stringify({
        steerId: STEER_ID,
        message: { type: 'user', content: 'stale', timestamp: Date.now() },
      }));

      // Nothing is appended to the transcript being opened, and no placeholder
      // is left spinning.
      expect(getMessages()).toHaveLength(1);
      expect(calls.dequeue).toHaveLength(0);
    } finally {
      delete window.__sessionTransitioning;
    }
  });
});
