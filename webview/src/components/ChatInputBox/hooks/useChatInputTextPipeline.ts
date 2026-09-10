import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { ChatInputBoxProps } from '../types.js';
import { useTextContent } from './useTextContent.js';
import { useFileTags } from './useFileTags.js';
import { useQuoteTags } from './useQuoteTags.js';
import { useCompositionSafeTagRendering } from './useCompositionSafeTagRendering.js';
import { useChatInputCompletionsCoordinator } from './useChatInputCompletionsCoordinator.js';
import { useIMEComposition } from './useIMEComposition.js';
import { useInputHistory } from './useInputHistory.js';
import { useKeyboardNavigation } from './useKeyboardNavigation.js';
import { useSpaceKeyListener } from './useSpaceKeyListener.js';
import { debounce } from '../utils/debounce.js';
import { perfTimer } from '../../../utils/debug.js';
import { DEBOUNCE_TIMING } from '../../../constants/performance.js';

/**
 * InputEvent.inputType values that belong to an active IME composition.
 * Any other inputType arriving while isComposingRef is set means JCEF lost the
 * compositionEnd event (e.g. IME switched mid-composition) and the composing
 * state is stale.
 */
const COMPOSITION_INPUT_TYPES = new Set([
  'insertCompositionText',
  'deleteCompositionText',
  'insertFromComposition',
  'deleteByComposition',
]);

interface UseChatInputTextPipelineOptions
  extends Pick<
    ChatInputBoxProps,
    'onInput' | 'onAgentSelect' | 'onOpenAgentSettings' | 'onOpenPromptSettings'
  > {
  editableRef: RefObject<HTMLDivElement | null>;
  isExternalUpdateRef: MutableRefObject<boolean>;
  setHasContent: Dispatch<SetStateAction<boolean>>;
  currentProvider: string;
}

/**
 * useChatInputTextPipeline - Text content, IME composition, tag rendering and
 * completion detection pipeline for ChatInputBox.
 *
 * Owns the contenteditable text pipeline: text content caching, file/quote tag
 * rendering, completion coordinators, debounced parent sync, IME composition
 * state, input history and mac cursor movement. Extracted from ChatInputBox to
 * keep the component under size limits; the wiring is a verbatim move.
 */
export function useChatInputTextPipeline({
  editableRef,
  isExternalUpdateRef,
  setHasContent,
  onInput,
  currentProvider,
  onAgentSelect,
  onOpenAgentSettings,
  onOpenPromptSettings,
}: UseChatInputTextPipelineOptions) {
  const closeAllCompletionsRef = useRef<() => void>(() => {});
  const handleInputRef = useRef<() => void>(() => {});

  // Shared composing state ref - created early so it can be used by detectAndTriggerCompletion
  // This ref is synced with useIMEComposition's isComposingRef
  const sharedComposingRef = useRef(false);

  // Text content hook
  const { getTextContent, invalidateCache } = useTextContent({ editableRef });

  // Close all completions helper
  const closeAllCompletions = useCallback(() => {
    closeAllCompletionsRef.current();
  }, []);

  // File tags hook
  const { renderFileTags, pathMappingRef, justRenderedTagRef, extractFileTags, setCursorAfterPath } = useFileTags({
    editableRef,
    getTextContent,
    onCloseCompletions: closeAllCompletions,
  });

  // Quote tags hook (inline quote chips)
  const { renderQuoteTags } = useQuoteTags({ editableRef });

  // Combined tag rendering: file tags first, then quote chips.
  const renderTags = useCallback(() => {
    renderFileTags();
    renderQuoteTags();
  }, [renderFileTags, renderQuoteTags]);

  /**
   * Clear input box
   */
  const clearInput = useCallback(() => {
    if (editableRef.current) {
      editableRef.current.innerHTML = '';
      editableRef.current.style.height = 'auto';
      setHasContent(false);
      // Notify parent component that input is cleared
      onInput?.('');
    }
  }, [onInput]);

  /**
   * Adjust input box height
   * Let contenteditable element expand naturally (height: auto),
   * outer container (.input-editable-wrapper) controls scrolling via max-height and overflow-y.
   * This avoids double scrollbar issue from outer + inner element scrolling.
   */
  const adjustHeight = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;

    // Ensure height is auto, expanded by content
    el.style.height = 'auto';
    // Hide inner scrollbar, completely rely on outer container scrolling
    el.style.overflowY = 'hidden';
  }, []);

  const {
    scheduleTagRendering,
    cancelTagRendering,
    renderTagsNowIfSafe,
  } = useCompositionSafeTagRendering({
    isComposingRef: sharedComposingRef,
    renderTags,
    delay: DEBOUNCE_TIMING.FILE_TAG_RENDERING_MS,
  });

  const {
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    inlineCompletion,
    debouncedDetectCompletion,
    syncInlineCompletion,
    setRenderFileTags,
  } = useChatInputCompletionsCoordinator({
    editableRef,
    sharedComposingRef,
    justRenderedTagRef,
    getTextContent,
    pathMappingRef,
    setCursorAfterPath,
    closeAllCompletionsRef,
    handleInputRef,
    currentProvider,
    onAgentSelect,
    onOpenAgentSettings,
    onOpenPromptSettings,
  });

  // Performance optimization: Debounced onInput callback
  // Reduces parent component re-renders during rapid typing
  // Also skips during IME composition to prevent parent re-renders that cause JCEF stutter
  const debouncedOnInput = useMemo(
    () =>
      debounce((text: string) => {
        // Skip if this is an external value update to avoid loops
        if (isExternalUpdateRef.current) {
          isExternalUpdateRef.current = false;
          return;
        }
        // Skip during active IME composition to prevent parent re-renders
        // that can disrupt Korean/CJK input in JCEF environments.
        // The update will be triggered after compositionEnd via handleInput.
        if (sharedComposingRef.current) {
          return;
        }
        onInput?.(text);
      }, DEBOUNCE_TIMING.ON_INPUT_CALLBACK_MS),
    [onInput]
  );

  /**
   * Handle input event (optimized: use debounce to reduce performance overhead)
   *
   * @param inputType - InputEvent.inputType of the triggering native event,
   *   when available. Programmatic callers omit it.
   */
  const handleInput = useCallback(
    (inputType?: string) => {
      const timer = perfTimer('handleInput');

      // Only trust our composition-event-backed ref for IME state detection.
      // JCEF's InputEvent.isComposing is unreliable (can be false during active
      // composition, or true after compositionEnd). The ref is set synchronously
      // by compositionStart/End. Do not restore persistent keyCode 229 state: it
      // can get stuck for Korean IMEs when no matching compositionEnd arrives.
      if (isComposingRef.current) {
        // JCEF/OSR can drop compositionEnd entirely when the user switches the
        // input source mid-composition (e.g. Bopomofo -> English via Shift).
        // A non-composition input event while our flag is still set proves the
        // composition is over — reset the refs so completion detection and
        // parent sync are not blocked forever.
        const staleComposition =
          inputType !== undefined && !COMPOSITION_INPUT_TYPES.has(inputType);
        if (!staleComposition) {
          return;
        }
        isComposingRef.current = false;
        sharedComposingRef.current = false;
        lastCompositionEndTimeRef.current = Date.now();
      }

      // Cancel any pending compositionEnd fallback timeout.
      // The normal input event path handles state sync, so the fallback
      // (which would redundantly call handleInput again) is no longer needed.
      // This prevents: 1) double handleInput calls, 2) debouncedOnInput timer
      // reset that delays parent notification by an extra 100ms.
      cancelPendingFallback();

      // Invalidate cache since content changed
      invalidateCache();
      timer.mark('invalidateCache');

      const text = getTextContent();
      timer.mark('getTextContent');

      // Remove zero-width and other invisible characters before checking if empty, ensure placeholder shows when only zero-width characters remain
      const cleanText = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
      const isEmpty = !cleanText.trim();

      // If content is empty, clear innerHTML to ensure :empty pseudo-class works (show placeholder)
      if (isEmpty && editableRef.current) {
        editableRef.current.innerHTML = '';
      }

      // Adjust height
      adjustHeight();
      timer.mark('adjustHeight');

      // Trigger completion detection and state update
      debouncedDetectCompletion();
      setHasContent(!isEmpty);

      // Update inline history completion
      syncInlineCompletion(text);

      // Notify parent component (use debounced version to reduce re-renders)
      // If determined empty (only zero-width characters), pass empty string to parent
      debouncedOnInput(isEmpty ? '' : text);

      // Schedule file/quote tag rendering after the input DOM becomes stable.
      // Covers non-keyboard input paths (history restore, paste, etc.)
      // that don't fire the space-key listener.
      scheduleTagRendering();

      timer.end();
    },
    [
      getTextContent,
      adjustHeight,
      debouncedDetectCompletion,
      debouncedOnInput,
      scheduleTagRendering,
      invalidateCache,
      syncInlineCompletion,
    ]
  );

  useEffect(() => {
    handleInputRef.current = handleInput;
  }, [handleInput]);

  // IME composition hook (ref-only, no React state to avoid re-renders during composition)
  const {
    isComposingRef,
    lastCompositionEndTimeRef,
    handleCompositionStart: rawHandleCompositionStart,
    handleCompositionEnd: rawHandleCompositionEnd,
    cancelPendingFallback,
  } = useIMEComposition({
    handleInput,
  });

  // Wrap composition handlers to sync sharedComposingRef (used by completion detection)
  // Both refs are now set synchronously — no RAF, no race conditions.
  const handleCompositionStart = useCallback(() => {
    sharedComposingRef.current = true;
    cancelTagRendering();
    rawHandleCompositionStart();
  }, [cancelTagRendering, rawHandleCompositionStart]);

  const handleCompositionEnd = useCallback(() => {
    rawHandleCompositionEnd();
    sharedComposingRef.current = false;
  }, [rawHandleCompositionEnd]);

  useEffect(() => {
    setRenderFileTags(renderTagsNowIfSafe);
  }, [renderTagsNowIfSafe, setRenderFileTags]);

  const { record: recordInputHistory, handleKeyDown: handleHistoryKeyDown } = useInputHistory({
    editableRef,
    getTextContent,
    handleInput,
  });

  // Keyboard navigation hook
  const { handleMacCursorMovement } = useKeyboardNavigation({
    editableRef,
    handleInput,
  });

  /**
   * Handle keyboard down event (for detecting space to trigger tag rendering)
   * Optimized: use debounce for delayed rendering
   */
  const handleKeyDownForTagRendering = useCallback(
    (e: KeyboardEvent) => {
      // IME candidate confirmation also uses Space, so never schedule while composing.
      if (e.key === ' ' && !sharedComposingRef.current) {
        scheduleTagRendering();
      }
    },
    [scheduleTagRendering]
  );

  useSpaceKeyListener({ editableRef, onKeyDown: handleKeyDownForTagRendering });

  return {
    getTextContent,
    invalidateCache,
    pathMappingRef,
    extractFileTags,
    renderQuoteTags,
    renderTagsNowIfSafe,
    clearInput,
    adjustHeight,
    closeAllCompletions,
    debouncedOnInput,
    handleInput,
    isComposingRef,
    lastCompositionEndTimeRef,
    handleCompositionStart,
    handleCompositionEnd,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    inlineCompletion,
    recordInputHistory,
    handleHistoryKeyDown,
    handleMacCursorMovement,
  };
}
