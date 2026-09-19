import { useCallback, useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { QueuedMessage } from '../../hooks/useMessageQueue';
import { createEdgeInsertResolver, useDragSort } from '../settings/hooks/useDragSort';
import { useDragAutoScroll } from './hooks/useDragAutoScroll.js';

export interface MessageQueueProps {
  /** Queue items */
  queue: QueuedMessage[];
  /** Remove item callback */
  onRemove: (id: string) => void;
  /** Reorder callback (orderedIds[0] executes first); drag is disabled when absent */
  onReorder?: (orderedIds: string[]) => void;
}

/**
 * MessageQueue - Displays queued messages above input box
 * Shows numbered list with drag handle, message preview and close button.
 * Items render in reverse order so the next message to execute (queue[0]) is at the bottom.
 * Drag is initiated only from the gripper handle (pointer-based), so text in the
 * row stays selectable and other controls are unaffected.
 */
export function MessageQueue({ queue, onRemove, onReorder }: MessageQueueProps) {
  /**
   * Sort callback fired when a drag completes.
   * useDragSort emits orderedIds in real queue order (not display order), so
   * they can be handed straight to the parent reorder.
   */
  const handleSort = useCallback((orderedIds: string[]) => {
    onReorder?.(orderedIds);
  }, [onReorder]);
  /**
   * Keyboard reorder for the drag handle: the list renders reversed (queue[0]
   * at the bottom), so ArrowUp moves the message later in the queue (visually
   * up) and ArrowDown moves it earlier (visually down).
   */
  const handleReorderKeyDown = useCallback((e: KeyboardEvent, id: string) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const index = queue.findIndex(item => item.id === id);
    const swapIndex = e.key === 'ArrowUp' ? index + 1 : index - 1;
    if (index === -1 || swapIndex < 0 || swapIndex >= queue.length) return;
    const next = [...queue];
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    onReorder?.(next.map(item => item.id));
  }, [queue, onReorder]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Row middle drops 'on' the row (legacy dashed highlight); row edges, gaps
  // and container padding resolve to insert slots. Rows are displayed in
  // reverse of queue order, so `reversed` flips placements into queue order.
  const resolveDropTarget = useMemo(
    () => createEdgeInsertResolver(() => containerRef.current, { reversed: true }),
    [],
  );

  // Only the pointer-based path is used; `queue` (parent state) is the single
  // source of truth for rendering because reorder applies synchronously.
  const { draggedId, dragOverId, dragOverPlacement, handlePointerDown } = useDragSort({
    items: queue,
    onSort: handleSort,
    resolveDropTarget,
  });

  // The list is a fixed-height scroll container; auto-scroll it while dragging
  // near its edges so rows outside the viewport can be reached.
  useDragAutoScroll(containerRef, draggedId !== null);

  if (queue.length === 0) {
    return null;
  }

  const canReorder = typeof onReorder === 'function' && queue.length > 1;

  return (
    <div className="message-queue" ref={containerRef}>
      {/* Render in reverse order so newest is at bottom (closest to input) */}
      {[...queue].reverse().map((item, reversedIndex) => {
        // Calculate actual queue position (1-based, from bottom)
        const queuePosition = queue.length - reversedIndex;
        // Placement is in queue order; the display is reversed, so 'after'
        // (higher index) draws the insert line above the row and 'before' below it.
        const isDragOver = dragOverId === item.id;
        const itemClassName = [
          'message-queue-item',
          draggedId === item.id && 'dragging',
          isDragOver && dragOverPlacement === 'on' && 'drag-over',
          isDragOver && dragOverPlacement === 'after' && 'insert-above',
          isDragOver && dragOverPlacement === 'before' && 'insert-below',
        ].filter(Boolean).join(' ');
        return (
          <div key={item.id} className={itemClassName} data-drag-sort-id={item.id}>
            {canReorder && (
              <div
                className="message-queue-drag-handle"
                data-drag-sort-handle
                role="button"
                tabIndex={0}
                aria-label={`Reorder message ${queuePosition}`}
                title="Drag to reorder, or focus and use arrow keys"
                onKeyDown={(e) => handleReorderKeyDown(e, item.id)}
                onPointerDown={(e) => handlePointerDown(e, item.id, e.currentTarget.closest<HTMLElement>('[data-drag-sort-id]'))}
              >
                <span className="codicon codicon-gripper" />
              </div>
            )}
            <span className="message-queue-number">{queuePosition}</span>
            <span className="message-queue-content" title={item.content}>
              {item.content}
            </span>
            <button
              className="message-queue-remove"
              onClick={() => onRemove(item.id)}
              title="Remove from queue"
            >
              <span className="codicon codicon-close" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default MessageQueue;
