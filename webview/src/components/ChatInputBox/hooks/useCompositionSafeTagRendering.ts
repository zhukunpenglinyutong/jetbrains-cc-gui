import { useCallback, useEffect, useMemo } from 'react';
import type { MutableRefObject } from 'react';
import { debounce } from '../utils/debounce.js';

interface UseCompositionSafeTagRenderingOptions {
  isComposingRef: MutableRefObject<boolean>;
  renderTags: () => void;
  delay: number;
}

interface UseCompositionSafeTagRenderingReturn {
  scheduleTagRendering: () => void;
  cancelTagRendering: () => void;
  renderTagsNowIfSafe: () => void;
}

/**
 * Schedules tag rendering without allowing delayed DOM mutations to cross an
 * IME composition boundary.
 *
 * The composing ref is checked both when work is scheduled and when the
 * debounced callback executes. The second check protects against work queued
 * by the previous input turn firing after the next composition has started.
 */
export function useCompositionSafeTagRendering({
  isComposingRef,
  renderTags,
  delay,
}: UseCompositionSafeTagRenderingOptions): UseCompositionSafeTagRenderingReturn {
  const debouncedRenderTags = useMemo(
    () => debounce(() => {
      if (isComposingRef.current) return;
      renderTags();
    }, delay),
    [delay, isComposingRef, renderTags]
  );

  useEffect(() => () => debouncedRenderTags.cancel(), [debouncedRenderTags]);

  const scheduleTagRendering = useCallback(() => {
    if (isComposingRef.current) return;
    debouncedRenderTags();
  }, [debouncedRenderTags, isComposingRef]);

  const cancelTagRendering = useCallback(() => {
    debouncedRenderTags.cancel();
  }, [debouncedRenderTags]);

  const renderTagsNowIfSafe = useCallback(() => {
    if (isComposingRef.current) return;
    debouncedRenderTags.cancel();
    renderTags();
  }, [debouncedRenderTags, isComposingRef, renderTags]);

  return { scheduleTagRendering, cancelTagRendering, renderTagsNowIfSafe };
}
