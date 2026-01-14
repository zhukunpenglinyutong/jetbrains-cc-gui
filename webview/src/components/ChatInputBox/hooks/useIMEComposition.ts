import { useCallback, useEffect, useRef, useState } from 'react';

interface UseIMECompositionOptions {
  handleInput: () => void;
  renderFileTags: () => void;
}

interface UseIMECompositionReturn {
  /** Whether IME composition is active (React state) */
  isComposing: boolean;
  /** Sync IME state ref (faster than React state) */
  isComposingRef: React.MutableRefObject<boolean>;
  /** Last composition end timestamp */
  lastCompositionEndTimeRef: React.MutableRefObject<number>;
  /** Handle composition start */
  handleCompositionStart: () => void;
  /** Handle composition end */
  handleCompositionEnd: () => void;
}

/**
 * useIMEComposition - Handle IME (Input Method Editor) composition
 *
 * Manages IME state to prevent interference with:
 * - Completion dropdown detection during composition
 * - File tag rendering during composition
 * - Submit handling during composition
 */
export function useIMEComposition({
  handleInput,
  renderFileTags,
}: UseIMECompositionOptions): UseIMECompositionReturn {
  const [isComposing, setIsComposing] = useState(false);
  // Sync IME state ref, faster than React state
  const isComposingRef = useRef(false);
  const compositionTimeoutRef = useRef<number | null>(null);
  const lastCompositionEndTimeRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null); // Track requestAnimationFrame ID
  const isMountedRef = useRef<boolean>(true); // Track component mount state

  // Track component mount/unmount
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      // Clean up requestAnimationFrame
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      // Clean up compositionTimeout
      if (compositionTimeoutRef.current) {
        clearTimeout(compositionTimeoutRef.current);
        compositionTimeoutRef.current = null;
      }
    };
  }, []);

  /**
   * Handle IME composition start
   */
  const handleCompositionStart = useCallback(() => {
    // Clear previous timeout
    if (compositionTimeoutRef.current) {
      clearTimeout(compositionTimeoutRef.current);
      compositionTimeoutRef.current = null;
    }
    // Update both ref and state, ref is sync, state is async
    isComposingRef.current = true;
    setIsComposing(true);
  }, []);

  /**
   * Handle IME composition end
   */
  const handleCompositionEnd = useCallback(() => {
    lastCompositionEndTimeRef.current = Date.now();

    // Cancel previous requestAnimationFrame (if any)
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    // Optimization: Use requestAnimationFrame to sync state at browser's next frame
    // This is more reliable than setTimeout, ensures DOM is fully updated
    rafIdRef.current = requestAnimationFrame(() => {
      // Check if component is still mounted
      if (!isMountedRef.current) return;

      rafIdRef.current = null;

      // Clear previous timeout
      if (compositionTimeoutRef.current) {
        clearTimeout(compositionTimeoutRef.current);
        compositionTimeoutRef.current = null;
      }

      // Update both ref and state
      isComposingRef.current = false;
      setIsComposing(false);

      // After composition ends, force sync input state once
      // At this point DOM is stable, safe to read and update
      handleInput();

      // In next microtask, trigger file tag rendering (only when component is mounted)
      Promise.resolve().then(() => {
        if (isMountedRef.current) {
          renderFileTags();
        }
      });
    });
  }, [handleInput, renderFileTags]);

  return {
    isComposing,
    isComposingRef,
    lastCompositionEndTimeRef,
    handleCompositionStart,
    handleCompositionEnd,
  };
}
