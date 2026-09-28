import { useState, useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Attachment } from '../components/ChatInputBox/types';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
  queuedAt: number;
  /** queued waits for idle send; steering is in-flight on the live turn */
  status: 'queued' | 'steering';
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
  /** Clear entire queue */
  clearQueue: () => void;
  /** Reorder queue by an ordered list of ids (index 0 executes first) */
  reorder: (orderedIds: string[]) => void;
  /** Mark an item as steering after the daemon accepted it */
  markSteering: (id: string) => void;
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
  const steeringItemsRef = useRef<Map<string, QueuedMessage>>(new Map());

  // Generate unique ID
  const generateId = useCallback(() => {
    return `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  // Add message to queue
  const enqueue = useCallback((content: string, attachments?: Attachment[]) => {
    const newItem: QueuedMessage = {
      id: generateId(),
      content,
      attachments,
      queuedAt: Date.now(),
      status: 'queued',
    };
    setQueue(prev => [...prev, newItem]);
  }, [generateId]);

  // Remove message from queue
  const dequeue = useCallback((id: string) => {
    steeringItemsRef.current.delete(id);
    setQueue(prev => prev.filter(item => item.id !== id));
  }, []);

  // Clear entire queue
  const clearQueue = useCallback(() => {
    steeringItemsRef.current.clear();
    setQueue([]);
  }, []);

  /**
   * Reorder the queue by the given id sequence (orderedIds[0] executes next).
   * - Ids not present in the current queue are ignored.
   * - Items missing from orderedIds (e.g. enqueued mid-drag) are appended in
   *   their original order so no message is ever dropped.
   */
  const reorder = useCallback((orderedIds: string[]) => {
    setQueue(prev => {
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
  }, []);

  const markSteering = useCallback((id: string) => {
    setQueue(prev => prev.map(item => {
      if (item.id !== id) return item;
      const next: QueuedMessage = { ...item, status: 'steering' };
      steeringItemsRef.current.set(id, next);
      return next;
    }));
  }, []);

  const restore = useCallback((id: string, fallback?: QueuedMessage) => {
    steeringItemsRef.current.delete(id);
    setQueue(prev => {
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
  }, []);

  const requeueAtHead = useCallback((item: QueuedMessage) => {
    const restored: QueuedMessage = { ...item, status: 'queued' };
    steeringItemsRef.current.delete(item.id);
    setQueue(prev => {
      const without = prev.filter(existing => existing.id !== item.id);
      return [restored, ...without];
    });
  }, []);

  // Auto-execute the next message whenever the chat is idle. Dequeue and
  // execute must stay atomic (see 80027de2: deferring the execution behind a
  // timer let the dequeue's own re-render cancel it and silently drop the
  // already-dequeued message), so the dispatcher below removes the row and
  // calls onExecute synchronously.
  //
  // Plan B2/F2: only ONE row leaves the queue per idle window. The window
  // between handing a row to onExecute and the async send flipping isLoading
  // back to true re-ran this effect for every remaining row and flushed the
  // whole queue into a single turn — the second send then hit the daemon's
  // live turn and its message was never read (ghost transcript row). The
  // dispatchedRef latch closes that window; it resets when the next turn
  // flips isLoading to true.
  //
  // While a steer receipt is still outstanding (steeringItemsRef non-empty)
  // the dispatch waits briefly so the receipt can requeue the steered row at
  // the head first — TC-07/TC-08 expect the undelivered row to auto-send
  // before older rows. The row stays queued during the wait and the receipt
  // path re-runs this effect, so cancelling the backstop never strands a
  // message.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const dispatchedRef = useRef(false);
  const steerDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSteerDelay = useCallback(() => {
    if (steerDelayRef.current != null) {
      clearTimeout(steerDelayRef.current);
      steerDelayRef.current = null;
    }
  }, []);

  const dispatchNextQueued = useCallback(() => {
    clearSteerDelay();
    if (dispatchedRef.current) {
      return;
    }
    const nextMessage = queueRef.current.find(item => item.status === 'queued');
    if (!nextMessage) {
      return;
    }
    dispatchedRef.current = true;
    setQueue(prev => prev.filter(item => item.id !== nextMessage.id));
    onExecuteRef.current(nextMessage.content, nextMessage.attachments);
  }, [clearSteerDelay]);

  useEffect(() => {
    if (isLoading) {
      dispatchedRef.current = false;
      clearSteerDelay();
      return undefined;
    }
    if (dispatchedRef.current) {
      return undefined;
    }
    if (steeringItemsRef.current.size > 0) {
      // Outstanding steer receipt: hold the dispatch inside the backstop
      // window and let the receipt's requeue re-run this effect.
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
    clearQueue,
    reorder,
    markSteering,
    restore,
    requeueAtHead,
    steeringItemsRef,
    hasQueuedMessages: queue.length > 0,
  };
}
