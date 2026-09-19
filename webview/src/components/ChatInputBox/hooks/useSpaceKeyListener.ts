import { useEffect, useRef } from 'react';

export interface UseSpaceKeyListenerOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: KeyboardEvent) => void;
}

/**
 * useSpaceKeyListener - Attaches a keydown listener for space-triggered tag rendering
 *
 * Uses native DOM listener to ensure consistent behavior across environments.
 * The handler is kept in a ref so the listener subscribes only once per element
 * while always invoking the latest callback.
 */
export function useSpaceKeyListener({ editableRef, onKeyDown }: UseSpaceKeyListenerOptions): void {
  const onKeyDownRef = useRef(onKeyDown);

  useEffect(() => {
    onKeyDownRef.current = onKeyDown;
  }, [onKeyDown]);

  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      onKeyDownRef.current(e);
    };
    el.addEventListener('keydown', handler);
    return () => {
      el.removeEventListener('keydown', handler);
    };
  }, [editableRef]);
}
