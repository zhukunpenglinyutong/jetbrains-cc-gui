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

interface UseDragSortOptions<T extends DragSortItem> {
  items: T[];
  onSort: (orderedIds: string[]) => void;
  /** IDs to exclude from sorting (e.g. pinned items). These items are preserved in their original position. */
  pinnedIds?: string[];
}

interface UseDragSortReturn<T extends DragSortItem> {
  localItems: T[];
  draggedId: string | null;
  dragOverId: string | null;
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

const isInteractiveTarget = (target: EventTarget | null): boolean => {
  return target instanceof Element && target.closest('button, a, input, textarea, select, [role="button"]') !== null;
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
}: UseDragSortOptions<T>): UseDragSortReturn<T> {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [localItems, setLocalItems] = useState<T[]>(items);
  const draggedIdRef = useRef<string | null>(null);
  const localItemsRef = useRef<T[]>(items);
  const pointerAbortRef = useRef<AbortController | null>(null);
  const dragPreviewRef = useRef<HTMLElement | null>(null);
  const dragPreviewOffsetRef = useRef({ x: 0, y: 0 });

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
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  const sortDraggedToTarget = useCallback((targetId: string | null) => {
    const currentDraggedId = draggedIdRef.current;
    if (currentDraggedId === null || targetId === null || currentDraggedId === targetId) {
      clearDragState();
      return;
    }

    const currentLocalItems = localItemsRef.current;
    const sortableItems = currentLocalItems.filter(item => !pinnedIds.includes(item.id));
    const draggedIndex = sortableItems.findIndex(item => item.id === currentDraggedId);
    const targetIndex = sortableItems.findIndex(item => item.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) {
      clearDragState();
      return;
    }

    const newOrder = [...sortableItems];
    const [removed] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, removed);

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
      const targetId = findDragSortId(event.clientX, event.clientY);
      if (targetId !== null && targetId !== draggedIdRef.current) {
        setDragOverId(targetId);
      } else {
        setDragOverId(null);
      }
    }, { signal: abortController.signal });

    window.addEventListener('pointerup', (event) => {
      const targetId = findDragSortId(event.clientX, event.clientY);
      abortController.abort();
      pointerAbortRef.current = null;
      sortDraggedToTarget(targetId);
    }, { once: true, signal: abortController.signal });

    window.addEventListener('pointercancel', () => {
      abortController.abort();
      pointerAbortRef.current = null;
      clearDragState();
    }, { once: true, signal: abortController.signal });
  }, [clearDragState, sortDraggedToTarget]);

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
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    sortDraggedToTarget(targetId);
  }, [sortDraggedToTarget]);

  const handleDragEnd = useCallback(() => {
    clearDragState();
  }, [clearDragState]);

  return {
    localItems,
    draggedId,
    dragOverId,
    handlePointerDown,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
  };
}
