import { useState, useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Attachment } from '../components/ChatInputBox/types';
import { restoreQuotes, snapshotQuotes } from '../components/ChatInputBox/utils/quoteRegistry';
import type { QuoteSnapshot } from '../components/ChatInputBox/utils/quoteRegistry';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
  /**
   * Text behind the quote chips in `content`. The input prunes quotes it no
   * longer shows, so a queued message keeps its own copy for send and edit.
   */
  quotes?: QuoteSnapshot;
  queuedAt: number;
  /**
   * queued waits for idle send; steering is in-flight on the live turn.
   * Absent means `queued`, so existing constructions stay valid.
   */
  status?: 'queued' | 'steering';
}

export interface UseMessageQueueOptions {
  /** Whether AI is currently processing */
  isLoading: boolean;
  /** Callback to execute a message */
  onExecute: (content: string, attachments?: Attachment[]) => void;
}

/**
 * Grace period that lets an outstanding steer receipt requeue its row at the
 * head before the next queued message dispatches (plan B2/F2).
 */
const STEER_RECEIPT_DISPATCH_DELAY_MS = 2000;

export interface UseMessageQueueReturn {
  /** Current queue */
  queue: QueuedMessage[];
  /** Add message to queue */
  enqueue: (content: string, attachments?: Attachment[]) => void;
  /** Remove message from queue by id */
  dequeue: (id: string) => void;
  /**
   * Remove a queued message and return it so its content and attachments can be
   * restored into the input draft for editing. Messages around it keep their
   * order; an unknown id returns undefined and leaves the queue untouched.
   */
  dequeueForEdit: (id: string) => QueuedMessage | undefined;
  /** Read a queued message without removing it */
  peekQueuedMessage: (id: string) => QueuedMessage | undefined;
  /**
   * Take a steered row off the queue while keeping its recovery data.
   *
   * The fold backstop uses this when the turn has ended and no receipt ever
   * arrived: the row must stop showing as steering, but a late `undelivered`
   * still has to be able to put the message back, so `steeringItemsRef` must
   * keep holding it.
   */
  hideSteerRow: (id: string) => void;
  /** Clear entire queue */
  clearQueue: () => void;
  /** Reorder the queue by an ordered list of ids (index 0 executes first) */
  reorder: (orderedIds: string[]) => void;
  /** Mark an item as steering after the daemon accepted it */
  markSteering: (id: string) => void;
  /**
   * Whether the item is still mid-steer. `accepted` receipts are replayed
   * against this so a late receipt cannot re-hide a row that a rejected or
   * undelivered receipt already restored to the queue.
   */
  isSteering: (id: string) => boolean;
  /**
   * Restore a rejected item in place. When the queue row is already gone
   * (the receipt outlived it, e.g. a session transition cleared the queue),
   * `fallback` is requeued at the head instead of the receipt being dropped.
   */
  restore: (id: string, fallback?: QueuedMessage) => void;
  /** Put an undelivered item back at the head as queued */
  requeueAtHead: (item: QueuedMessage) => void;
  /** Steering items retained for undelivered receipts */
  steeringItemsRef: MutableRefObject<Map<string, QueuedMessage>>;
  /** Whether queue has items */
  hasQueuedMessages: boolean;
}

/**
 * Hook for managing message queue
 * Automatically executes next message when loading completes
 */
export function useMessageQueue({
  isLoading,
  onExecute,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Timestamp of the last dispatch. The drain effect re-runs synchronously after
  // its own dequeue (queue state change) while `isLoading` is still false — the
  // execute path flips it only in the next render. Without a gate the effect
  // drained the whole queue in one idle period, overlapping multiple sends on
  // the same Codex thread (writer-lock conflict).
  const dispatchedAtRef = useRef<number | null>(null);
  // The live queue. Every mutation moves it first and then publishes it to
  // state, so a removal can report what it took out and the idle dispatch
  // never sends a message an edit already took, even when either lands
  // between a render and its effects.
  const queueRef = useRef<QueuedMessage[]>(queue);
  // Steered rows that left the queue but must stay recoverable until a fold or
  // an undelivered receipt settles them.
  const steeringItemsRef = useRef<Map<string, QueuedMessage>>(new Map());

  const commitQueue = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);

  /**
   * Apply a queue transform against the live ref and publish the result.
   * Mutations read `queueRef` rather than React state so two calls in the same
   * tick cannot both act on a stale snapshot.
   */
  const mutateQueue = useCallback((updater: (prev: QueuedMessage[]) => QueuedMessage[]) => {
    commitQueue(updater(queueRef.current));
  }, [commitQueue]);

  // Generate unique ID
  const generateId = useCallback(() => {
    return `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  // Add message to queue
  const enqueue = useCallback((content: string, attachments?: Attachment[]) => {
    const quotes = snapshotQuotes(content);
    const newItem: QueuedMessage = {
      id: generateId(),
      content,
      attachments,
      ...(quotes ? { quotes } : {}),
      queuedAt: Date.now(),
      status: 'queued',
    };
    commitQueue([...queueRef.current, newItem]);
  }, [generateId, commitQueue]);

  // Remove a message for editing: the caller gets its payload back so the
  // draft can be restored in the same interaction (same semantics as dequeue
  // for the remaining items). The ref keeps repeated calls in one tick safe —
  // a state read would hand the same message out twice.
  const dequeueForEdit = useCallback((id: string): QueuedMessage | undefined => {
    const removed = queueRef.current.find(item => item.id === id);
    if (!removed) return undefined;
    steeringItemsRef.current.delete(id);
    commitQueue(queueRef.current.filter(item => item.id !== id));
    return removed;
  }, [commitQueue]);

  /** Read a queued message without removing it (used to vet an edit first) */
  const peekQueuedMessage = useCallback(
    (id: string): QueuedMessage | undefined => queueRef.current.find(item => item.id === id),
    [],
  );

  // Remove message from queue (the removed payload is ignored here)
  const dequeue = useCallback((id: string) => {
    dequeueForEdit(id);
  }, [dequeueForEdit]);

  // Drop the row from the queue without dropping the recovery copy
  const hideSteerRow = useCallback((id: string) => {
    commitQueue(queueRef.current.filter(item => item.id !== id));
  }, [commitQueue]);

  // Clear entire queue
  const clearQueue = useCallback(() => {
    steeringItemsRef.current.clear();
    commitQueue([]);
  }, [commitQueue]);

  /**
   * Reorder the queue by the given id sequence (orderedIds[0] executes next).
   * - Ids not present in the current queue are ignored.
   * - Items missing from orderedIds (e.g. enqueued mid-drag) are appended in
   *   their original order so no message is ever dropped.
   */
  const reorder = useCallback((orderedIds: string[]) => {
    mutateQueue(prev => {
      const byId = new Map(prev.map(item => [item.id, item]));
      const seen = new Set<string>();
      const ordered: QueuedMessage[] = [];
      for (const id of orderedIds) {
        const item = byId.get(id);
        if (item && !seen.has(id)) {
          ordered.push(item);
          seen.add(id);
        }
      }
      const remaining = prev.filter(item => !seen.has(item.id));
      return [...ordered, ...remaining];
    });
  }, [mutateQueue]);

  /** Mark an item as steering and keep its recovery copy for receipts */
  const markSteering = useCallback((id: string) => {
    mutateQueue(prev => prev.map(item => {
      if (item.id !== id) return item;
      const next: QueuedMessage = { ...item, status: 'steering' };
      steeringItemsRef.current.set(id, next);
      return next;
    }));
  }, [mutateQueue]);

  /** Whether the item still has an unsettled steer in flight */
  const isSteering = useCallback((id: string) => steeringItemsRef.current.has(id), []);

  /** Put a rejected item back in the queue, rebuilding it when the row is gone */
  const restore = useCallback((id: string, fallback?: QueuedMessage) => {
    steeringItemsRef.current.delete(id);
    mutateQueue(prev => {
      if (prev.some(item => item.id === id)) {
        return prev.map(item => (
          item.id === id ? { ...item, status: 'queued' } : item
        ));
      }
      // Steer plan F1: a receipt must never silently drop its message. When
      // the row is gone, rebuild it from the optimistic-bubble fallback.
      if (fallback && !prev.some(item => item.id === fallback.id)) {
        return [{ ...fallback, status: 'queued' }, ...prev];
      }
      return prev;
    });
  }, [mutateQueue]);

  /** Requeue an undelivered item at the head so it dispatches next */
  const requeueAtHead = useCallback((item: QueuedMessage) => {
    const restored: QueuedMessage = { ...item, status: 'queued' };
    steeringItemsRef.current.delete(item.id);
    mutateQueue(prev => {
      const without = prev.filter(existing => existing.id !== item.id);
      return [restored, ...without];
    });
  }, [mutateQueue]);

  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const steerDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSteerDelay = useCallback(() => {
    if (steerDelayRef.current != null) {
      clearTimeout(steerDelayRef.current);
      steerDelayRef.current = null;
    }
  }, []);

  /**
   * Hand the first non-steering row to `onExecute`.
   *
   * Dequeue and execute must stay atomic: deferring the execution behind a
   * timer let the dequeue's own re-render cancel it and silently drop the
   * already-dequeued message (80027de2). Rows marked `steering` are skipped —
   * they are already in the live turn and only return through a receipt.
   */
  const dispatchNextQueued = useCallback(() => {
    clearSteerDelay();
    if (dispatchedAtRef.current !== null) {
      return;
    }
    // Absent status means `queued`: only rows explicitly marked `steering`
    // are in the live turn and must wait for a receipt.
    const nextMessage = queueRef.current.find(item => item.status !== 'steering');
    if (!nextMessage) {
      return;
    }
    dispatchedAtRef.current = Date.now();
    commitQueue(queueRef.current.filter(item => item.id !== nextMessage.id));
    // The input may have pruned these while the message waited.
    restoreQuotes(nextMessage.quotes);
    onExecuteRef.current(nextMessage.content, nextMessage.attachments);
  }, [clearSteerDelay, commitQueue]);

  // Auto-execute next message whenever the chat is idle. Dequeue and execute
  // must stay atomic inside this effect: deferring the execution behind a
  // timer let the very next re-render (the dequeue's own state update) run
  // effect cleanup, cancel the timer, and silently drop the already-dequeued
  // message. Checking "idle && non-empty" instead of a loading transition also
  // covers messages enqueued while `isLoading` was already flipping to false.
  //
  // Single-flight: at most one dispatch per idle period. The drain effect
  // re-runs synchronously after its own dequeue while `isLoading` is still
  // false (the execute path flips it only in the next render); without the
  // gate it drained the whole queue at once, overlapping multiple sends on
  // the same Codex thread (thread-writer lock conflict). The gate reopens
  // when `isLoading` turns true — i.e. the dispatched message actually
  // started a turn. A dispatch that bails before flipping loading (e.g. SDK
  // missing) leaves the gate closed so the queue waits instead of spamming
  // doomed sends; any subsequent turn reopens it.
  //
  // While a steer receipt is still outstanding (steeringItemsRef non-empty)
  // the dispatch waits briefly so the receipt can requeue the steered row at
  // the head first — TC-07/TC-08 expect the undelivered row to auto-send
  // before older rows. The row stays queued during the wait and the receipt
  // path re-runs this effect, so cancelling the backstop never strands a
  // message.
  useEffect(() => {
    if (isLoading) {
      dispatchedAtRef.current = null;
      clearSteerDelay();
      return undefined;
    }
    if (dispatchedAtRef.current !== null) {
      return undefined;
    }
    if (steeringItemsRef.current.size > 0) {
      if (steerDelayRef.current == null) {
        steerDelayRef.current = setTimeout(() => {
          steerDelayRef.current = null;
          dispatchNextQueued();
        }, STEER_RECEIPT_DISPATCH_DELAY_MS);
      }
    } else {
      dispatchNextQueued();
    }
    return () => {
      clearSteerDelay();
    };
  }, [isLoading, queue, dispatchNextQueued, clearSteerDelay]);

  return {
    queue,
    enqueue,
    dequeue,
    dequeueForEdit,
    peekQueuedMessage,
    hideSteerRow,
    clearQueue,
    reorder,
    markSteering,
    isSteering,
    restore,
    requeueAtHead,
    steeringItemsRef,
    hasQueuedMessages: queue.length > 0,
  };
}
