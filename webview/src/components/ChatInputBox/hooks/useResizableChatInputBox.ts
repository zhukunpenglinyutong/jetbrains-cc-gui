import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

type ResizeDirection = 'n' | 'e' | 'ne';

interface SizeState {
  widthPx: number | null;
  wrapperHeightPx: number | null;
}

interface Bounds {
  minWidthPx: number;
  maxWidthPx: number;
  minWrapperHeightPx: number;
  maxWrapperHeightPx: number;
}

const STORAGE_KEY = 'chat-input-box:size-v1';

const DEFAULT_MIN_WIDTH_PX = 320;
const ABSOLUTE_MIN_WIDTH_PX = 240;
const PARENT_BORDER_GAP_PX = 2;

const VIEWPORT_HEIGHT_FALLBACK_PX = 800;
const MAX_WRAPPER_HEIGHT_VIEWPORT_RATIO = 0.55;
const MAX_WRAPPER_HEIGHT_CAP_PX = 520;
const MIN_MAX_WRAPPER_HEIGHT_PX = 140;
const DEFAULT_MIN_WRAPPER_HEIGHT_PX = 96;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function getBounds(containerEl: HTMLElement): Bounds {
  const parent = containerEl.parentElement;
  const parentWidth = parent?.getBoundingClientRect().width ?? containerEl.getBoundingClientRect().width;
  const maxWidthPx = Math.max(ABSOLUTE_MIN_WIDTH_PX, Math.floor(parentWidth - PARENT_BORDER_GAP_PX)); // keep within parent border
  const minWidthPx = Math.min(DEFAULT_MIN_WIDTH_PX, maxWidthPx);

  const viewportH = typeof window !== 'undefined' ? window.innerHeight : VIEWPORT_HEIGHT_FALLBACK_PX;
  // Wrapper height controls the editable scroll region; keep a sane cap so the input doesn't take over the UI.
  const maxWrapperHeightPx = Math.max(
    MIN_MAX_WRAPPER_HEIGHT_PX,
    Math.floor(Math.min(viewportH * MAX_WRAPPER_HEIGHT_VIEWPORT_RATIO, MAX_WRAPPER_HEIGHT_CAP_PX))
  );
  const minWrapperHeightPx = Math.min(DEFAULT_MIN_WRAPPER_HEIGHT_PX, maxWrapperHeightPx);

  return {
    minWidthPx,
    maxWidthPx,
    minWrapperHeightPx,
    maxWrapperHeightPx,
  };
}

function sanitizeLoadedSize(raw: unknown): SizeState {
  if (!raw || typeof raw !== 'object') return { widthPx: null, wrapperHeightPx: null };
  const obj = raw as Record<string, unknown>;

  const widthPx = typeof obj.widthPx === 'number' && Number.isFinite(obj.widthPx) ? obj.widthPx : null;
  const wrapperHeightPx =
    typeof obj.wrapperHeightPx === 'number' && Number.isFinite(obj.wrapperHeightPx) ? obj.wrapperHeightPx : null;

  return { widthPx, wrapperHeightPx };
}

export function computeResize(
  start: { startX: number; startY: number; startWidthPx: number; startWrapperHeightPx: number },
  current: { x: number; y: number },
  dir: ResizeDirection,
  bounds: Bounds
): { widthPx: number; wrapperHeightPx: number } {
  const dx = current.x - start.startX;
  const dy = current.y - start.startY;

  let nextWidth = start.startWidthPx;
  let nextHeight = start.startWrapperHeightPx;

  if (dir === 'e' || dir === 'ne') {
    nextWidth = start.startWidthPx + dx;
  }
  if (dir === 'n' || dir === 'ne') {
    // Dragging up (dy < 0) increases height.
    nextHeight = start.startWrapperHeightPx - dy;
  }

  return {
    widthPx: clamp(Math.round(nextWidth), bounds.minWidthPx, bounds.maxWidthPx),
    wrapperHeightPx: clamp(Math.round(nextHeight), bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx),
  };
}

export interface UseResizableChatInputBoxOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  editableWrapperRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * useResizableChatInputBox
 * - Adds pointer-driven resizing (width + editable-wrapper height)
 * - Persists/restores size via localStorage
 */
export function useResizableChatInputBox({
  containerRef,
  editableWrapperRef,
}: UseResizableChatInputBoxOptions): {
  isResizing: boolean;
  containerStyle: CSSProperties;
  editableWrapperStyle: CSSProperties;
  getHandleProps: (dir: ResizeDirection) => ComponentPropsWithoutRef<'div'>;
} {
  const [size, setSize] = useState<SizeState>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { widthPx: null, wrapperHeightPx: null };
      return sanitizeLoadedSize(JSON.parse(raw));
    } catch {
      return { widthPx: null, wrapperHeightPx: null };
    }
  });

  const [isResizing, setIsResizing] = useState(false);
  const startRef = useRef<{
    dir: ResizeDirection;
    startX: number;
    startY: number;
    startWidthPx: number;
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
      const el = containerRef.current;
      if (!el) return;
      const bounds = getBounds(el);
      setSize((prev) => {
        const nextWidthPx = prev.widthPx == null ? null : clamp(prev.widthPx, bounds.minWidthPx, bounds.maxWidthPx);
        const nextWrapperHeightPx =
          prev.wrapperHeightPx == null
            ? null
            : clamp(prev.wrapperHeightPx, bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx);
        if (nextWidthPx === prev.widthPx && nextWrapperHeightPx === prev.wrapperHeightPx) return prev;
        return { ...prev, widthPx: nextWidthPx, wrapperHeightPx: nextWrapperHeightPx };
      });
    };

    // Clamp once on mount (handles persisted sizes when the window is smaller/larger).
    onResize();

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [containerRef]);

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
      const { widthPx, wrapperHeightPx } = computeResize(
        {
          startX: start.startX,
          startY: start.startY,
          startWidthPx: start.startWidthPx,
          startWrapperHeightPx: start.startWrapperHeightPx,
        },
        { x: e.clientX, y: e.clientY },
        start.dir,
        start.bounds
      );

      setSize((prev) => ({ ...prev, widthPx, wrapperHeightPx }));
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
    (dir: ResizeDirection) => {
      return {
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();

          const containerEl = containerRef.current;
          const wrapperEl = editableWrapperRef.current;
          if (!containerEl || !wrapperEl) return;

          const bounds = getBounds(containerEl);
          const containerRect = containerEl.getBoundingClientRect();
          const wrapperRect = wrapperEl.getBoundingClientRect();

          const startWidthPx = size.widthPx ?? containerRect.width;
          const startWrapperHeightPx = size.wrapperHeightPx ?? wrapperRect.height;

          const prevUserSelect = document.body.style.userSelect;
          const prevCursor = document.body.style.cursor;

          document.body.style.userSelect = 'none';
          document.body.style.cursor = dir === 'e' ? 'ew-resize' : dir === 'n' ? 'ns-resize' : 'nesw-resize';

          startRef.current = {
            dir,
            startX: e.clientX,
            startY: e.clientY,
            startWidthPx,
            startWrapperHeightPx,
            bounds,
            prevUserSelect,
            prevCursor,
          };

          setIsResizing(true);
        },
      } satisfies ComponentPropsWithoutRef<'div'>;
    },
    [containerRef, editableWrapperRef, size.widthPx, size.wrapperHeightPx]
  );

  const containerStyle = useMemo((): CSSProperties => {
    return {
      width: size.widthPx == null ? undefined : `${size.widthPx}px`,
    };
  }, [size.widthPx]);

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
  };
}
