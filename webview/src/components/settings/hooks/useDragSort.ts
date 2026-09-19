import { useState, useCallback, useEffect, useRef } from 'react';

const PROVIDER_SORT_MIME_TYPE = 'application/x-cc-gui-provider-sort';

// Stay above any modal/portal overlays without colliding with potential DOM owners.
const DRAG_PREVIEW_Z_INDEX = '2147483647';
const DRAG_PREVIEW_OPACITY = '0.92';
const DRAG_PREVIEW_SHADOW = '0 16px 36px rgba(0, 0, 0, 0.35)';
const DRAG_PREVIEW_BORDER_COLOR = '#0078d4';

interface DragSortItem {
  id: string;
}

/**
 * Where the dragged item lands relative to the target item, expressed in
 * `items` order:
 * - 'on': take the target's position (legacy behavior; the target shifts toward
 *   where the dragged item came from).
 * - 'before': insert at the slot just before the target (lower index).
 * - 'after': insert at the slot just after the target (higher index).
 */
export type DropPlacement = 'on' | 'before' | 'after';

export interface DropTarget {
  id: string;
  placement: DropPlacement;
}

interface UseDragSortOptions<T extends DragSortItem> {
  items: T[];
  onSort: (orderedIds: string[]) => void;
  /** IDs to exclude from sorting (e.g. pinned items). These items are preserved in their original position. */
  pinnedIds?: string[];
  /**
   * Custom drop-target resolver for the pointer-based path. Defaults to the
   * `[data-drag-sort-id]` element under the pointer with 'on' placement. Use
   * `createEdgeInsertResolver` to enable insert-between slots.
   */
  resolveDropTarget?: (x: number, y: number) => DropTarget | null;
}

interface UseDragSortReturn<T extends DragSortItem> {
  localItems: T[];
  draggedId: string | null;
  dragOverId: string | null;
  /** Placement for `dragOverId`; null when nothing is hovered. Always 'on' with the default resolver. */
  dragOverPlacement: DropPlacement | null;
  handlePointerDown: (e: React.PointerEvent, id: string, previewElement?: HTMLElement | null) => void;
  handleDragStart: (e: React.DragEvent, id: string) => void;
  handleDragOver: (e: React.DragEvent, id: string) => void;
  handleDragLeave: () => void;
  handleDrop: (e: React.DragEvent, targetId: string) => void;
  handleDragEnd: () => void;
}

const findDragSortId = (x: number, y: number): string | null => {
  const element = document.elementFromPoint(x, y);
  const sortable = element?.closest<HTMLElement>('[data-drag-sort-id]');
  return sortable?.dataset.dragSortId ?? null;
};

const defaultResolveDropTarget = (x: number, y: number): DropTarget | null => {
  const id = findDragSortId(x, y);
  return id === null ? null : { id, placement: 'on' };
};

/**
 * Build a resolver that splits every `[data-drag-sort-id]` row inside
 * `getContainer()` into three zones: the outer `edgeRatio` of its height on
 * each side maps to an insert slot ('before' / 'after'), the middle maps to
 * 'on'. Gaps between rows and the container's top/bottom padding map to the
 * adjacent slot, so the first and last slots are reachable. Horizontally
 * outside the container the resolver returns null (drop cancels); vertically
 * it tolerates `DROP_EDGE_TOLERANCE_PX` of overshoot and clamps into the
 * nearest edge slot, because auto-scroll deliberately scrolls while the
 * pointer sits beyond the top/bottom edge and releasing there must not
 * silently cancel the drag.
 *
 * Placement is computed in DOM order. When rows are rendered in reverse of
 * `items` order, pass `reversed: true` so 'before' / 'after' are flipped into
 * `items` order, which is what the hook's sort expects.
 */
/** Vertical overshoot (px) beyond the container that still resolves to the nearest edge slot. */
const DROP_EDGE_TOLERANCE_PX = 24;

export const createEdgeInsertResolver = (
  getContainer: () => HTMLElement | null,
  options: { edgeRatio?: number; reversed?: boolean } = {},
) => {
  const edgeRatio = options.edgeRatio ?? 0.25;
  const flip = (placement: DropPlacement): DropPlacement => {
    if (!options.reversed || placement === 'on') return placement;
    return placement === 'before' ? 'after' : 'before';
  };
  return (x: number, y: number): DropTarget | null => {
    const container = getContainer();
    if (!container) return null;
    const bounds = container.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right) return null;
    if (y < bounds.top - DROP_EDGE_TOLERANCE_PX || y > bounds.bottom + DROP_EDGE_TOLERANCE_PX) return null;
    const clampedY = Math.min(Math.max(y, bounds.top), bounds.bottom);

    let lastId: string | null = null;
    for (const row of container.querySelectorAll<HTMLElement>('[data-drag-sort-id]')) {
      const id = row.dataset.dragSortId;
      if (!id) continue;
      const rect = row.getBoundingClientRect();
      if (clampedY < rect.top) {
        // Gap above this row (or the container's top padding).
        return { id, placement: flip('before') };
      }
      if (clampedY <= rect.bottom) {
        const edge = rect.height * edgeRatio;
        if (clampedY < rect.top + edge) return { id, placement: flip('before') };
        if (clampedY > rect.bottom - edge) return { id, placement: flip('after') };
        return { id, placement: 'on' };
      }
      lastId = id;
    }
    // Below the last row (container's bottom padding).
    return lastId === null ? null : { id: lastId, placement: flip('after') };
  };
};

/**
 * Apply a drop target to `list` (already filtered to sortable items). Returns
 * the new order, or null when the drop would be a no-op or references an
 * unknown id.
 */
const applyDropTarget = <T extends DragSortItem>(list: T[], draggedId: string, target: DropTarget): T[] | null => {
  const draggedIndex = list.findIndex(item => item.id === draggedId);
  const targetIndex = list.findIndex(item => item.id === target.id);
  if (draggedIndex === -1 || targetIndex === -1) return null;

  let insertIndex: number;
  if (target.placement === 'on') {
    if (draggedIndex === targetIndex) return null;
    insertIndex = targetIndex;
  } else {
    // Slot index in the pre-removal list; shift left once the dragged item is removed ahead of it.
    const slot = target.placement === 'before' ? targetIndex : targetIndex + 1;
    insertIndex = slot > draggedIndex ? slot - 1 : slot;
    if (insertIndex === draggedIndex) return null;
  }

  const newOrder = [...list];
  const [removed] = newOrder.splice(draggedIndex, 1);
  newOrder.splice(insertIndex, 0, removed);
  return newOrder;
};

const isInteractiveTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  // The drag handle is focusable (role="button") for keyboard reordering, but
  // it initiates the pointer drag itself, so it must not block that drag.
  if (target.closest('[data-drag-sort-handle]') !== null) return false;
  return target.closest('button, a, input, textarea, select, [role="button"]') !== null;
};

// Strip identifiers / form state from the cloned subtree so the floating preview
// does not duplicate `id`, `name`, `for`, ARIA-relations, or interactive controls.
const sanitizeClonedPreview = (root: HTMLElement) => {
  root.removeAttribute('id');
  root.removeAttribute('name');
  const descendants = root.querySelectorAll<HTMLElement>(
    '[id], [name], [for], [aria-controls], [aria-labelledby], [aria-describedby], input, textarea, select, button',
  );
  descendants.forEach((node) => {
    node.removeAttribute('id');
    node.removeAttribute('name');
    node.removeAttribute('for');
    node.removeAttribute('aria-controls');
    node.removeAttribute('aria-labelledby');
    node.removeAttribute('aria-describedby');
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement || node instanceof HTMLButtonElement) {
      node.disabled = true;
      node.tabIndex = -1;
    }
  });
};

const createDragPreview = (source: HTMLElement, x: number, y: number) => {
  const rect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  const offset = {
    x: x - rect.left,
    y: y - rect.top,
  };
  sanitizeClonedPreview(preview);
  preview.dataset.dragSortPreview = 'true';
  preview.removeAttribute('data-drag-sort-id');
  preview.setAttribute('aria-hidden', 'true');
  preview.style.position = 'fixed';
  preview.style.left = '0';
  preview.style.top = '0';
  preview.style.width = `${rect.width}px`;
  preview.style.height = `${rect.height}px`;
  preview.style.pointerEvents = 'none';
  preview.style.zIndex = DRAG_PREVIEW_Z_INDEX;
  preview.style.opacity = DRAG_PREVIEW_OPACITY;
  preview.style.transform = `translate3d(${x - offset.x}px, ${y - offset.y}px, 0) scale(1.02)`;
  preview.style.boxShadow = DRAG_PREVIEW_SHADOW;
  preview.style.borderColor = DRAG_PREVIEW_BORDER_COLOR;
  document.body.appendChild(preview);
  return { preview, offset };
};

const moveDragPreview = (preview: HTMLElement, x: number, y: number, offset: { x: number; y: number }) => {
  preview.style.transform = `translate3d(${x - offset.x}px, ${y - offset.y}px, 0) scale(1.02)`;
};

export function useDragSort<T extends DragSortItem>({
  items,
  onSort,
  pinnedIds = [],
  resolveDropTarget,
}: UseDragSortOptions<T>): UseDragSortReturn<T> {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPlacement, setDragOverPlacement] = useState<DropPlacement | null>(null);
  const [localItems, setLocalItems] = useState<T[]>(items);
  const draggedIdRef = useRef<string | null>(null);
  const localItemsRef = useRef<T[]>(items);
  const pointerAbortRef = useRef<AbortController | null>(null);
  const dragPreviewRef = useRef<HTMLElement | null>(null);
  const dragPreviewOffsetRef = useRef({ x: 0, y: 0 });
  // Read through a ref so pointer listeners registered at pointerdown always use the latest resolver.
  const resolveDropTargetRef = useRef(resolveDropTarget ?? defaultResolveDropTarget);
  useEffect(() => {
    resolveDropTargetRef.current = resolveDropTarget ?? defaultResolveDropTarget;
  }, [resolveDropTarget]);
  // Last pointer position during a pointer-based drag; used to re-resolve the
  // drop target when a container scrolls under a stationary pointer.
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);

  // Sync localItems from props
  useEffect(() => {
    setLocalItems(items);
    localItemsRef.current = items;
  }, [items]);

  useEffect(() => {
    return () => {
      pointerAbortRef.current?.abort();
      dragPreviewRef.current?.remove();
    };
  }, []);

  const clearDragState = useCallback(() => {
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
    draggedIdRef.current = null;
    lastPointerPosRef.current = null;
    setDraggedId(null);
    setDragOverId(null);
    setDragOverPlacement(null);
  }, []);

  /**
   * Update hover state for the pointer path. 'on' keeps the legacy rule (any
   * other row highlights); insert placements only highlight when the drop
   * would actually move the dragged item, so no line is drawn at its own slot.
   */
  const updateDragOver = useCallback((target: DropTarget | null) => {
    const currentDraggedId = draggedIdRef.current;
    let visible = false;
    if (currentDraggedId !== null && target !== null) {
      if (target.placement === 'on') {
        visible = target.id !== currentDraggedId;
      } else {
        const sortableItems = localItemsRef.current.filter(item => !pinnedIds.includes(item.id));
        visible = applyDropTarget(sortableItems, currentDraggedId, target) !== null;
      }
    }
    setDragOverId(visible && target ? target.id : null);
    setDragOverPlacement(visible && target ? target.placement : null);
  }, [pinnedIds]);

  const sortDraggedToTarget = useCallback((target: DropTarget | null) => {
    const currentDraggedId = draggedIdRef.current;
    if (currentDraggedId === null || target === null) {
      clearDragState();
      return;
    }

    const currentLocalItems = localItemsRef.current;
    const sortableItems = currentLocalItems.filter(item => !pinnedIds.includes(item.id));
    const newOrder = applyDropTarget(sortableItems, currentDraggedId, target);

    if (newOrder === null) {
      clearDragState();
      return;
    }

    // Optimistic update: reflect new order immediately
    const pinnedItems = currentLocalItems.filter(item => pinnedIds.includes(item.id));
    const nextLocalItems = [...pinnedItems, ...newOrder];
    localItemsRef.current = nextLocalItems;
    setLocalItems(nextLocalItems);

    onSort(newOrder.map(item => item.id));
    clearDragState();
  }, [clearDragState, pinnedIds, onSort]);

  const handlePointerDown = useCallback((e: React.PointerEvent, id: string, previewElement?: HTMLElement | null) => {
    if (e.button !== 0) return;
    if (isInteractiveTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    pointerAbortRef.current?.abort();
    draggedIdRef.current = id;
    lastPointerPosRef.current = { x: e.clientX, y: e.clientY };
    setDraggedId(id);
    setDragOverId(null);
    dragPreviewRef.current?.remove();
    const { preview, offset } = createDragPreview(previewElement ?? e.currentTarget as HTMLElement, e.clientX, e.clientY);
    dragPreviewRef.current = preview;
    dragPreviewOffsetRef.current = offset;

    const abortController = new AbortController();
    pointerAbortRef.current = abortController;

    window.addEventListener('pointermove', (event) => {
      if (dragPreviewRef.current) {
        moveDragPreview(dragPreviewRef.current, event.clientX, event.clientY, dragPreviewOffsetRef.current);
      }
      lastPointerPosRef.current = { x: event.clientX, y: event.clientY };
      updateDragOver(resolveDropTargetRef.current(event.clientX, event.clientY));
    }, { signal: abortController.signal });

    // Auto-scroll moves rows under a stationary pointer without firing
    // pointermove; re-resolve on scroll so the highlight tracks the real slot.
    window.addEventListener('scroll', () => {
      const pos = lastPointerPosRef.current;
      if (pos) {
        updateDragOver(resolveDropTargetRef.current(pos.x, pos.y));
      }
    }, { capture: true, signal: abortController.signal });

    window.addEventListener('pointerup', (event) => {
      const target = resolveDropTargetRef.current(event.clientX, event.clientY);
      abortController.abort();
      pointerAbortRef.current = null;
      sortDraggedToTarget(target);
    }, { once: true, signal: abortController.signal });

    window.addEventListener('pointercancel', () => {
      abortController.abort();
      pointerAbortRef.current = null;
      clearDragState();
    }, { once: true, signal: abortController.signal });
  }, [clearDragState, sortDraggedToTarget, updateDragOver]);

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    e.stopPropagation();
    draggedIdRef.current = id;
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    // JCEF/Chromium requires setData() in dragstart for drop to fire reliably.
    try {
      e.dataTransfer.setData('text/plain', id);
    } catch {
      // dataTransfer may be read-only in some edge cases; ignore.
    }
    try {
      e.dataTransfer.setData(PROVIDER_SORT_MIME_TYPE, id);
    } catch {
      // Some webviews only allow standard MIME types.
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (draggedIdRef.current !== null && draggedIdRef.current !== id) {
      setDragOverId(id);
      setDragOverPlacement('on');
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
    setDragOverPlacement(null);
  }, []);

  // Native DnD path has no pointer geometry; it always drops 'on' the target row.
  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    sortDraggedToTarget({ id: targetId, placement: 'on' });
  }, [sortDraggedToTarget]);

  const handleDragEnd = useCallback(() => {
    clearDragState();
  }, [clearDragState]);

  return {
    localItems,
    draggedId,
    dragOverId,
    dragOverPlacement,
    handlePointerDown,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
  };
}
