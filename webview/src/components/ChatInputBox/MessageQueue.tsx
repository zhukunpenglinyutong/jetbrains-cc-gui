import { useCallback, useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { TFunction } from 'i18next';
import type { QueuedMessage } from '../../hooks/useMessageQueue';
import { createEdgeInsertResolver, useDragSort } from '../settings/hooks/useDragSort';
import { useDragAutoScroll } from './hooks/useDragAutoScroll.js';

export interface MessageQueueProps {
  /** Queue items */
  queue: QueuedMessage[];
  /** Remove item callback */
  onRemove: (id: string) => void;
  /**
   * Edit item callback: the caller removes the message from the queue and
   * restores its content and attachments into the input draft. The edit action
   * is only rendered when a handler is provided.
   */
  onEdit?: (id: string) => void;
  /** Reorder callback (orderedIds[0] executes first); drag is disabled when absent */
  onReorder?: (orderedIds: string[]) => void;
  /** Show the steer button when the live runtime can inject into the current turn */
  canSteer?: boolean;
  /** Steer a queued item into the live turn */
  onSteer?: (id: string) => void;
  /** Translation function */
  t: TFunction;
}

/**
 * Merge a reordered list of visible rows back into the full queue.
 *
 * Hidden `steering` rows are neither draggable nor rendered, so the visible
 * list a drag produces has no ids for them. Handing that list straight to the
 * parent would treat every hidden row as "missing" and push it to the tail,
 * which then shows up as a restored message landing at the end of the queue
 * instead of in the slot it was steered from. The hidden rows keep their
 * original slots here and only the visible rows trade places.
 *
 * @param queue full queue including hidden steering rows
 * @param orderedVisibleIds visible ids in their new order
 * @returns full id sequence covering every row
 */
export function mergeVisibleOrderIntoQueue(
  queue: QueuedMessage[],
  orderedVisibleIds: string[],
): string[] {
  const visibleIds = new Set(queue.filter(item => item.status !== 'steering').map(item => item.id));
  const reordered = orderedVisibleIds.filter(id => visibleIds.has(id));
  let cursor = 0;
  return queue.map(item => {
    if (item.status === 'steering') return item.id;
    const next = reordered[cursor];
    cursor += 1;
    return next ?? item.id;
  });
}

/**
 * MessageQueue - Displays queued messages above input box
 * Shows numbered list with drag handle, message preview, edit, steer and close
 * buttons, all rendered per item in that order.
 * Items render in reverse order so the next message to execute (queue[0]) is at the bottom.
 * Drag is initiated only from the gripper handle (pointer-based), so text in the
 * row stays selectable and other controls are unaffected.
 */
export function MessageQueue({
  queue, onRemove, onEdit, onReorder, canSteer = false, onSteer, t,
}: MessageQueueProps) {
  /**
   * A steering item has already been shown in the transcript as an optimistic
   * steered bubble, so it is hidden here to keep one message in one place. It
   * stays in the parent queue state (and in steeringItemsRef) so a rejected or
   * undelivered receipt can restore it to its original slot.
   */
  const visibleQueue = useMemo(
    () => queue.filter(item => item.status !== 'steering'),
    [queue],
  );

  /**
   * Sort callback fired when a drag completes.
   * useDragSort emits orderedIds in real queue order (not display order);
   * hidden rows are woven back by mergeVisibleOrderIntoQueue so they keep
   * their slots, then the full sequence goes to the parent reorder.
   */
  const handleSort = useCallback((orderedIds: string[]) => {
    const merged = mergeVisibleOrderIntoQueue(queue, orderedIds);
    onReorder?.(merged);
  }, [queue, onReorder]);

  /**
   * Keyboard reorder for the drag handle: the list renders reversed (queue[0]
   * at the bottom), so ArrowUp moves the message later in the queue (visually
   * up) and ArrowDown moves it earlier (visually down).
   */
  const handleReorderKeyDown = useCallback((e: KeyboardEvent, id: string) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const index = visibleQueue.findIndex(item => item.id === id);
    const swapIndex = e.key === 'ArrowUp' ? index + 1 : index - 1;
    if (index === -1 || swapIndex < 0 || swapIndex >= visibleQueue.length) return;
    const next = [...visibleQueue];
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    onReorder?.(mergeVisibleOrderIntoQueue(queue, next.map(item => item.id)));
  }, [queue, visibleQueue, onReorder]);

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
    items: visibleQueue,
    onSort: handleSort,
    resolveDropTarget,
  });

  // The list is a fixed-height scroll container; auto-scroll it while dragging
  // near its edges so rows outside the viewport can be reached.
  useDragAutoScroll(containerRef, draggedId !== null);

  if (visibleQueue.length === 0) {
    return null;
  }

  const canReorder = typeof onReorder === 'function' && visibleQueue.length > 1;

  return (
    <div className="message-queue" ref={containerRef}>
      {/* Render in reverse order so newest is at bottom (closest to input) */}
      {[...visibleQueue].reverse().map((item, reversedIndex) => {
        // Calculate actual queue position (1-based, from bottom)
        const queuePosition = visibleQueue.length - reversedIndex;
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
                aria-label={t('chat.queue.reorderLabel', { position: queuePosition })}
                title={t('chat.queue.reorderHint')}
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
            {onEdit && (
              <button
                type="button"
                className="message-queue-edit"
                aria-label={t('chat.queue.editLabel', { position: queuePosition })}
                title={t('chat.queue.edit')}
                onClick={() => onEdit(item.id)}
              >
                <span className="codicon codicon-edit" aria-hidden="true" />
              </button>
            )}
            {canSteer && (
              <button
                type="button"
                className="message-queue-steer"
                aria-label={t('chat.queue.steerNow')}
                title={t('chat.queue.steerNow')}
                onClick={() => onSteer?.(item.id)}
              >
                <span className="codicon codicon-run-above" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="message-queue-remove"
              aria-label={t('chat.queue.removeLabel', { position: queuePosition })}
              title={t('chat.queue.remove')}
              onClick={() => onRemove(item.id)}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default MessageQueue;
