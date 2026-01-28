import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

type ResizeDirection = 'n';

interface SizeState {
  wrapperHeightPx: number | null;
}

interface Bounds {
  minWrapperHeightPx: number;
  maxWrapperHeightPx: number;
}

// Use v2 key to avoid loading old width values from v1
const STORAGE_KEY = 'chat-input-box:size-v2';

const VIEWPORT_HEIGHT_FALLBACK_PX = 800;
const MAX_WRAPPER_HEIGHT_VIEWPORT_RATIO = 0.55;
const MAX_WRAPPER_HEIGHT_CAP_PX = 520;
const MIN_MAX_WRAPPER_HEIGHT_PX = 140;
const DEFAULT_MIN_WRAPPER_HEIGHT_PX = 96;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function getBounds(): Bounds {
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : VIEWPORT_HEIGHT_FALLBACK_PX;
  // Wrapper height controls the editable scroll region; keep a sane cap so the input doesn't take over the UI.
  const maxWrapperHeightPx = Math.max(
    MIN_MAX_WRAPPER_HEIGHT_PX,
    Math.floor(Math.min(viewportH * MAX_WRAPPER_HEIGHT_VIEWPORT_RATIO, MAX_WRAPPER_HEIGHT_CAP_PX))
  );
  const minWrapperHeightPx = Math.min(DEFAULT_MIN_WRAPPER_HEIGHT_PX, maxWrapperHeightPx);

  return {
    minWrapperHeightPx,
    maxWrapperHeightPx,
  };
}

function sanitizeLoadedSize(raw: unknown): SizeState {
  if (!raw || typeof raw !== 'object') return { wrapperHeightPx: null };
  const obj = raw as Record<string, unknown>;

  const wrapperHeightPx =
    typeof obj.wrapperHeightPx === 'number' && Number.isFinite(obj.wrapperHeightPx) ? obj.wrapperHeightPx : null;

  return { wrapperHeightPx };
}

export function computeResize(
  start: { startY: number; startWrapperHeightPx: number },
  current: { y: number },
  bounds: Bounds
): { wrapperHeightPx: number } {
  const dy = current.y - start.startY;
  // Dragging up (dy < 0) increases height.
  const nextHeight = start.startWrapperHeightPx - dy;

  return {
    wrapperHeightPx: clamp(Math.round(nextHeight), bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx),
  };
}

export interface UseResizableChatInputBoxOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  editableWrapperRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * useResizableChatInputBox
 * - Adds pointer-driven resizing (editable-wrapper height only, width is always 100%)
 * - Persists/restores size via localStorage
 */
export function useResizableChatInputBox({
  containerRef: _containerRef,
  editableWrapperRef,
}: UseResizableChatInputBoxOptions): {
  isResizing: boolean;
  containerStyle: CSSProperties;
  editableWrapperStyle: CSSProperties;
  getHandleProps: (dir: ResizeDirection) => ComponentPropsWithoutRef<'div'>;
  nudge: (delta: { wrapperHeightPx?: number }) => void;
} {
  const [size, setSize] = useState<SizeState>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { wrapperHeightPx: null };
      return sanitizeLoadedSize(JSON.parse(raw));
    } catch {
      return { wrapperHeightPx: null };
    }
  });
  const sizeRef = useRef<SizeState>(size);
  sizeRef.current = size;

  const [isResizing, setIsResizing] = useState(false);
  const startRef = useRef<{
    startY: number;
    startWrapperHeightPx: number;
    bounds: Bounds;
    prevUserSelect: string;
    prevCursor: string;
  } | null>(null);

  // Persist size changes (best-effort).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
    } catch {
      // ignore
    }
  }, [size]);

  // Clamp persisted size on window resize (e.g., user shrinks the tool window).
  useEffect(() => {
    const onResize = () => {
      const bounds = getBounds();
      setSize((prev) => {
        const nextWrapperHeightPx =
          prev.wrapperHeightPx == null
            ? null
            : clamp(prev.wrapperHeightPx, bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx);
        if (nextWrapperHeightPx === prev.wrapperHeightPx) return prev;
        return { wrapperHeightPx: nextWrapperHeightPx };
      });
    };

    // Clamp once on mount (handles persisted sizes when the window is smaller/larger).
    onResize();

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const nudge = useCallback(
    (delta: { wrapperHeightPx?: number }) => {
      const wrapperEl = editableWrapperRef.current;
      if (!wrapperEl) return;

      const bounds = getBounds();
      const wrapperRect = wrapperEl.getBoundingClientRect();

      const currentHeight = sizeRef.current.wrapperHeightPx ?? wrapperRect.height;

      const nextHeight =
        delta.wrapperHeightPx == null
          ? currentHeight
          : clamp(Math.round(currentHeight + delta.wrapperHeightPx), bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx);

      setSize((prev) => ({
        wrapperHeightPx: delta.wrapperHeightPx == null ? prev.wrapperHeightPx : nextHeight,
      }));
    },
    [editableWrapperRef]
  );

  const stopResize = useCallback(() => {
    const start = startRef.current;
    if (!start) return;

    document.body.style.userSelect = start.prevUserSelect;
    document.body.style.cursor = start.prevCursor;

    startRef.current = null;
    setIsResizing(false);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      e.preventDefault();
      const { wrapperHeightPx } = computeResize(
        {
          startY: start.startY,
          startWrapperHeightPx: start.startWrapperHeightPx,
        },
        { y: e.clientY },
        start.bounds
      );

      setSize({ wrapperHeightPx });
    };

    const onUp = () => stopResize();
    const onCancel = () => stopResize();

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [stopResize]);

  const getHandleProps = useCallback(
    (_dir: ResizeDirection) => {
      return {
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();

          const wrapperEl = editableWrapperRef.current;
          if (!wrapperEl) return;

          const bounds = getBounds();
          const wrapperRect = wrapperEl.getBoundingClientRect();

          const startWrapperHeightPx = sizeRef.current.wrapperHeightPx ?? wrapperRect.height;

          const prevUserSelect = document.body.style.userSelect;
          const prevCursor = document.body.style.cursor;

          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'ns-resize';

          startRef.current = {
            startY: e.clientY,
            startWrapperHeightPx,
            bounds,
            prevUserSelect,
            prevCursor,
          };

          setIsResizing(true);
        },
      } satisfies ComponentPropsWithoutRef<'div'>;
    },
    [editableWrapperRef]
  );

  // containerStyle is now empty - width is always auto (100% of parent)
  const containerStyle = useMemo((): CSSProperties => {
    return {};
  }, []);

  const editableWrapperStyle = useMemo((): CSSProperties => {
    return {
      height: size.wrapperHeightPx == null ? undefined : `${size.wrapperHeightPx}px`,
      maxHeight: size.wrapperHeightPx == null ? undefined : `${size.wrapperHeightPx}px`,
    };
  }, [size.wrapperHeightPx]);

  return {
    isResizing,
    containerStyle,
    editableWrapperStyle,
    getHandleProps,
    nudge,
  };
}
