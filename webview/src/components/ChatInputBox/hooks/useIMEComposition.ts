import { useCallback, useEffect, useRef } from 'react';

interface UseIMECompositionOptions {
  handleInput: () => void;
}

interface UseIMECompositionReturn {
  /** Sync IME state ref (primary source of truth, avoids re-renders) */
  isComposingRef: React.MutableRefObject<boolean>;
  /** Last composition end timestamp */
  lastCompositionEndTimeRef: React.MutableRefObject<number>;
  /** Handle composition start */
  handleCompositionStart: () => void;
  /** Handle composition end */
  handleCompositionEnd: () => void;
  /** Cancel pending fallback timeout (call when input event handles state sync) */
  cancelPendingFallback: () => void;
}

/**
 * useIMEComposition - Handle IME (Input Method Editor) composition
 *
 * Strategy: Synchronous state transitions, no requestAnimationFrame.
 *
 * Previous approach used RAF to defer compositionEnd cleanup, but this caused
 * race conditions during fast Korean typing: compositionStart for the next
 * syllable could fire before the previous compositionEnd's RAF executed,
 * and the stale RAF would then corrupt the active composition.
 *
 * New approach:
 * 1. compositionStart: synchronously set isComposingRef=true
 * 2. During composition: all handleInput calls are blocked by isComposingRef guard
 * 3. compositionEnd: synchronously set isComposingRef=false
 * 4. The browser's natural post-compositionEnd input event triggers handleInput
 * 5. A fallback timeout handles edge cases (IME cancel with no input event)
 *
 * Uses ref-only approach (no React state) to avoid triggering re-renders
 * during composition, which is critical for JCEF/Korean IME performance.
 */
export function useIMEComposition({
  handleInput,
}: UseIMECompositionOptions): UseIMECompositionReturn {
  // Ref-only composing state: avoids React re-renders during IME composition.
  // In JCEF, re-renders during composition cause visible stutter and character duplication.
  const isComposingRef = useRef(false);
  const lastCompositionEndTimeRef = useRef<number>(0);
  const fallbackTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef<boolean>(true);

  // Track component mount/unmount
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
        fallbackTimeoutRef.current = null;
      }
    };
  }, []);

  /**
   * Handle IME composition start
   */
  const handleCompositionStart = useCallback(() => {
    // Cancel any pending fallback timeout from a previous compositionEnd
    if (fallbackTimeoutRef.current) {
      clearTimeout(fallbackTimeoutRef.current);
      fallbackTimeoutRef.current = null;
    }
    // Synchronously set composing flag
    isComposingRef.current = true;
  }, []);

  /**
   * Handle IME composition end
   *
   * Sets isComposingRef=false synchronously so the browser's natural
   * post-compositionEnd input event will pass through the guard in handleInput.
   * No RAF means no race condition with the next compositionStart.
   */
  const handleCompositionEnd = useCallback(() => {
    lastCompositionEndTimeRef.current = Date.now();

    // Cancel any previous fallback timeout
    if (fallbackTimeoutRef.current) {
      clearTimeout(fallbackTimeoutRef.current);
      fallbackTimeoutRef.current = null;
    }

    // Synchronously clear composing flag.
    // The browser will fire a post-compositionEnd input event which will
    // naturally trigger handleInput via the onInput handler.
    isComposingRef.current = false;

    // Fallback: if no input event fires after compositionEnd (e.g., Escape cancel),
    // ensure state is synced. This timeout is cancelled by:
    // - The next compositionStart (if the user continues typing immediately)
    // - cancelPendingFallback() called from handleInput (normal input event handled it)
    fallbackTimeoutRef.current = window.setTimeout(() => {
      fallbackTimeoutRef.current = null;
      if (!isMountedRef.current) return;
      if (isComposingRef.current) return;
      handleInput();
    }, 100);
  }, [handleInput]);

  /**
   * Cancel any pending fallback timeout.
   * Call this from handleInput when the normal input event fires after compositionEnd,
   * so the fallback doesn't redundantly call handleInput again (which would reset
   * the debouncedOnInput timer and delay parent notification by an extra 100ms).
   */
  const cancelPendingFallback = useCallback(() => {
    if (fallbackTimeoutRef.current) {
      clearTimeout(fallbackTimeoutRef.current);
      fallbackTimeoutRef.current = null;
    }
  }, []);

  return {
    isComposingRef,
    lastCompositionEndTimeRef,
    handleCompositionStart,
    handleCompositionEnd,
    cancelPendingFallback,
  };
}
