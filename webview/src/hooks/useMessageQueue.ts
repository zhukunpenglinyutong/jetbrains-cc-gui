import { useState, useCallback, useEffect } from 'react';
import type { Attachment } from '../components/ChatInputBox/types';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
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
  /** Clear entire queue */
  clearQueue: () => void;
  /** Reorder queue by an ordered list of ids (index 0 executes first) */
  reorder: (orderedIds: string[]) => void;
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
    };
    setQueue(prev => [...prev, newItem]);
  }, [generateId]);

  // Remove message from queue
  const dequeue = useCallback((id: string) => {
    setQueue(prev => prev.filter(item => item.id !== id));
  }, []);

  // Clear entire queue
  const clearQueue = useCallback(() => {
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

  // Auto-execute next message whenever the chat is idle. Dequeue and execute
  // must stay atomic inside this effect: deferring the execution behind a
  // timer let the very next re-render (the dequeue's own state update) run
  // effect cleanup, cancel the timer, and silently drop the already-dequeued
  // message. Checking "idle && non-empty" instead of a loading transition also
  // covers messages enqueued while `isLoading` was already flipping to false.
  useEffect(() => {
    if (isLoading || queue.length === 0) {
      return;
    }
    const nextMessage = queue[0];
    setQueue(prev => prev.slice(1));
    onExecute(nextMessage.content, nextMessage.attachments);
  }, [isLoading, queue, onExecute]);

  return {
    queue,
    enqueue,
    dequeue,
    clearQueue,
    reorder,
    hasQueuedMessages: queue.length > 0,
  };
}
