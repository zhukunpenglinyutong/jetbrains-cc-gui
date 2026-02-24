import { useCallback, useEffect, useRef, useState } from 'react';

interface UseDialogResizeOptions {
  minHeight?: number;
}

interface UseDialogResizeReturn {
  dialogRef: React.RefObject<HTMLDivElement | null>;
  dialogHeight: number | null;
  setDialogHeight: React.Dispatch<React.SetStateAction<number | null>>;
  handleResizeStart: (e: React.PointerEvent) => void;
}

/**
 * Hook for dialog drag-to-resize behavior.
 * Manages pointer events for resizing a dialog by dragging its top edge.
 */
export function useDialogResize({ minHeight = 150 }: UseDialogResizeOptions = {}): UseDialogResizeReturn {
  const [dialogHeight, setDialogHeight] = useState<number | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    dragStartYRef.current = e.clientY;
    dragStartHeightRef.current = dialogRef.current?.offsetHeight ?? 0;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleResizeMove = (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      const delta = dragStartYRef.current - e.clientY;
      const newHeight = Math.max(minHeight, Math.min(window.innerHeight * 0.9, dragStartHeightRef.current + delta));
      setDialogHeight(newHeight);
    };
    const handleResizeEnd = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', handleResizeMove);
    window.addEventListener('pointerup', handleResizeEnd);
    return () => {
      window.removeEventListener('pointermove', handleResizeMove);
      window.removeEventListener('pointerup', handleResizeEnd);
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, [minHeight]);

  return { dialogRef, dialogHeight, setDialogHeight, handleResizeStart };
}
