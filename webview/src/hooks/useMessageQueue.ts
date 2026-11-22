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

export interface UseMessageQueueOptions {
  /** Whether AI is currently processing */
  isLoading: boolean;
  /** Callback to execute a message */
  onExecute: (content: string, attachments?: Attachment[]) => void;
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
  // `queue` only triggers the effect; the live ref is what gets read, because
  // a message taken for editing after this render committed is already gone
  // from the ref while the render's `queue` still holds it.
  useEffect(() => {
    if (isLoading) {
      dispatchedAtRef.current = null;
      return;
    }
    const [nextMessage, ...remaining] = queueRef.current;
    if (!nextMessage || dispatchedAtRef.current !== null) {
      return;
    }
    dispatchedAtRef.current = Date.now();
    commitQueue(remaining);
    // The input may have pruned these while the message waited.
    restoreQuotes(nextMessage.quotes);
    onExecute(nextMessage.content, nextMessage.attachments);
  }, [isLoading, queue, onExecute, commitQueue]);

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
