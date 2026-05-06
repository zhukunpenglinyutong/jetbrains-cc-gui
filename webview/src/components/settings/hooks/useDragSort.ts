import { useState, useCallback, useEffect } from 'react';

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
  handleDragStart: (e: React.DragEvent, id: string) => void;
  handleDragOver: (e: React.DragEvent, id: string) => void;
  handleDragLeave: () => void;
  handleDrop: (e: React.DragEvent, targetId: string) => void;
  handleDragEnd: () => void;
}

export function useDragSort<T extends DragSortItem>({
  items,
  onSort,
  pinnedIds = [],
}: UseDragSortOptions<T>): UseDragSortReturn<T> {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [localItems, setLocalItems] = useState<T[]>(items);

  // Sync localItems from props
  useEffect(() => {
    setLocalItems(items);
  }, [items]);

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    // JCEF/Chromium requires setData() in dragstart for drop to fire reliably.
    try {
      e.dataTransfer.setData('text/plain', id);
    } catch {
      // dataTransfer may be read-only in some edge cases; ignore.
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedId !== null && draggedId !== id) {
      setDragOverId(id);
    }
  }, [draggedId]);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (draggedId === null || draggedId === targetId) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    const sortableItems = localItems.filter(item => !pinnedIds.includes(item.id));
    const draggedIndex = sortableItems.findIndex(item => item.id === draggedId);
    const targetIndex = sortableItems.findIndex(item => item.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    const newOrder = [...sortableItems];
    const [removed] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, removed);

    // Optimistic update: reflect new order immediately
    const pinnedItems = localItems.filter(item => pinnedIds.includes(item.id));
    setLocalItems([...pinnedItems, ...newOrder]);

    onSort(newOrder.map(item => item.id));

    setDraggedId(null);
    setDragOverId(null);
  }, [draggedId, localItems, pinnedIds, onSort]);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  return {
    localItems,
    draggedId,
    dragOverId,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
  };
}
