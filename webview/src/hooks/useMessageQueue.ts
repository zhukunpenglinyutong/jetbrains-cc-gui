import { useState, useCallback, useEffect, useRef } from 'react';
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
}

/** A refusal leaves ownership with the queue; only accepted work can be removed. */
export type MessageDispatchResult = 'started' | 'handled' | 'blocked';

export interface UseMessageQueueOptions {
  /** Whether AI is currently processing */
  isLoading: boolean;
  /** Synchronous handoff: started a turn, handled locally, or refused the message. */
  onExecute: (content: string, attachments?: Attachment[]) => MessageDispatchResult;
  /** Changes only when a condition that refused dispatch can have changed. */
  retryKey?: unknown;
}

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
  /** Clear entire queue */
  clearQueue: () => void;
  /** Reorder the queue by an ordered list of ids (index 0 executes first) */
  reorder: (orderedIds: string[]) => void;
  /** Whether queue has items */
  hasQueuedMessages: boolean;
}

/**
 * Rebuild the queue in the order of `orderedIds` (index 0 executes next).
 * Kept out of the hook so the ordering rules read on their own; the hook still
 * has to move the queue mirror with the result.
 */
function applyQueueOrder(queue: QueuedMessage[], orderedIds: string[]): QueuedMessage[] {
  const byId = new Map(queue.map(item => [item.id, item]));
  const seen = new Set<string>();
  const ordered: QueuedMessage[] = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      ordered.push(item);
      seen.add(id);
    }
  }
  const remaining = queue.filter(item => !seen.has(item.id));
  return [...ordered, ...remaining];
}

/**
 * Hook for managing message queue
 * Automatically executes next message when loading completes
 */
export function useMessageQueue({
  isLoading,
  onExecute,
  retryKey,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Timestamp of the last dispatch. The drain effect re-runs synchronously after
  // its own dequeue (queue state change) while `isLoading` is still false — the
  // execute path flips it only in the next render. Without a gate the effect
  // drained the whole queue in one idle period, overlapping multiple sends on
  // the same Codex thread (writer-lock conflict).
  const dispatchedAtRef = useRef<number | null>(null);
  const refusedRef = useRef<{ id: string; retryKey: unknown } | null>(null);
  // The live queue. Every mutation moves it first and then publishes it to
  // state, so a removal can report what it took out and the idle dispatch
  // never sends a message an edit already took, even when either lands
  // between a render and its effects.
  const queueRef = useRef<QueuedMessage[]>(queue);

  const commitQueue = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);

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

  // Clear entire queue
  const clearQueue = useCallback(() => {
    commitQueue([]);
  }, [commitQueue]);

  /**
   * Reorder the queue by the given id sequence (orderedIds[0] executes next).
   * - Ids not present in the current queue are ignored.
   * - Items missing from orderedIds (e.g. enqueued mid-drag) are appended in
   *   their original order so no message is ever dropped.
   */
  const reorder = useCallback((orderedIds: string[]) => {
    commitQueue(applyQueueOrder(queueRef.current, orderedIds));
  }, [commitQueue]);

  // Read the live queue so an edit between render and effects cannot be sent.
  // Ownership transfers only after synchronous acceptance. Refused items keep
  // their ID, attachments, quotes and position, and retry when readiness changes.
  // Accepted model turns retain the single-flight gate until loading cycles;
  // locally handled commands can drain without waiting for a nonexistent turn.
  useEffect(() => {
    if (isLoading) {
      dispatchedAtRef.current = null;
      refusedRef.current = null;
      return;
    }
    const [nextMessage] = queueRef.current;
    if (!nextMessage || dispatchedAtRef.current !== null) {
      return;
    }
    if (refusedRef.current?.id === nextMessage.id && Object.is(refusedRef.current.retryKey, retryKey)) return;
    // The input may have pruned these while the message waited.
    restoreQuotes(nextMessage.quotes);
    const result = onExecute(nextMessage.content, nextMessage.attachments);
    if (result !== 'started' && result !== 'handled') {
      refusedRef.current = { id: nextMessage.id, retryKey };
      return;
    }
    refusedRef.current = null;
    if (result === 'started') dispatchedAtRef.current = Date.now();
    // The callback can itself change session/queue state. Never restore the
    // captured remainder over those mutations or remove a different item.
    commitQueue(queueRef.current.filter(item => item.id !== nextMessage.id));
  }, [isLoading, queue, onExecute, commitQueue, retryKey]);

  return {
    queue,
    enqueue,
    dequeue,
    dequeueForEdit,
    peekQueuedMessage,
    clearQueue,
    reorder,
    hasQueuedMessages: queue.length > 0,
  };
}
