import { useEffect } from 'react';
import type { MutableRefObject } from 'react';

interface CompletionOpenLike {
  isOpen: boolean;
}

export interface UseNativeEventCaptureOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  isComposing: boolean;
  isComposingRef: MutableRefObject<boolean>;
  lastCompositionEndTimeRef: MutableRefObject<number>;
  sendShortcut: 'enter' | 'cmdEnter';
  fileCompletion: CompletionOpenLike;
  commandCompletion: CompletionOpenLike;
  agentCompletion: CompletionOpenLike;
  completionSelectedRef: MutableRefObject<boolean>;
  submittedOnEnterRef: MutableRefObject<boolean>;
  handleSubmit: () => void;
  handleEnhancePrompt: () => void;
}

/**
 * useNativeEventCapture - Native event capture for JCEF/IME edge cases
 *
 * Uses capturing listeners to handle:
 * - IME confirm enter false trigger
 * - beforeinput insertParagraph handling (Enter-to-send mode)
 * - prompt enhancer shortcut (Cmd+/)
 */
export function useNativeEventCapture({
  editableRef,
  isComposing,
  isComposingRef,
  lastCompositionEndTimeRef,
  sendShortcut,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  completionSelectedRef,
  submittedOnEnterRef,
  handleSubmit,
  handleEnhancePrompt,
}: UseNativeEventCaptureOptions): void {
  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    const nativeKeyDown = (ev: KeyboardEvent) => {
      const isIMEProcessing = ev.keyCode === 229 || ev.isComposing;
      if (isIMEProcessing) {
        isComposingRef.current = true;
      }

      const isEnterKey = ev.key === 'Enter' || ev.keyCode === 13;

      if (ev.key === '/' && ev.metaKey && !ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
        handleEnhancePrompt();
        return;
      }

      const isMacCursorMovementOrDelete =
        (ev.key === 'ArrowLeft' && ev.metaKey) ||
        (ev.key === 'ArrowRight' && ev.metaKey) ||
        (ev.key === 'ArrowUp' && ev.metaKey) ||
        (ev.key === 'ArrowDown' && ev.metaKey) ||
        (ev.key === 'Backspace' && ev.metaKey);
      if (isMacCursorMovementOrDelete) return;

      const isCursorMovementKey =
        ev.key === 'Home' ||
        ev.key === 'End' ||
        ((ev.key === 'a' || ev.key === 'A') && ev.ctrlKey && !ev.metaKey) ||
        ((ev.key === 'e' || ev.key === 'E') && ev.ctrlKey && !ev.metaKey);
      if (isCursorMovementKey) return;

      if (fileCompletion.isOpen || commandCompletion.isOpen || agentCompletion.isOpen) {
        return;
      }

      const isRecentlyComposing = Date.now() - lastCompositionEndTimeRef.current < 100;
      const shift = (ev as KeyboardEvent).shiftKey === true;
      const metaOrCtrl = ev.metaKey || ev.ctrlKey;
      const isSendKey =
        sendShortcut === 'cmdEnter'
          ? isEnterKey && metaOrCtrl && !isComposingRef.current && !isComposing
          : isEnterKey &&
            !shift &&
            !isComposingRef.current &&
            !isComposing &&
            !isRecentlyComposing;

      if (!isSendKey) return;

      ev.preventDefault();
      submittedOnEnterRef.current = true;
      handleSubmit();
    };

    const nativeKeyUp = (ev: KeyboardEvent) => {
      const isEnterKey = ev.key === 'Enter' || ev.keyCode === 13;
      const shift = (ev as KeyboardEvent).shiftKey === true;
      const metaOrCtrl = ev.metaKey || ev.ctrlKey;

      const isSendKey =
        sendShortcut === 'cmdEnter' ? isEnterKey && metaOrCtrl : isEnterKey && !shift;
      if (!isSendKey) return;

      ev.preventDefault();
      if (completionSelectedRef.current) {
        completionSelectedRef.current = false;
        return;
      }
      if (submittedOnEnterRef.current) {
        submittedOnEnterRef.current = false;
      }
    };

    const nativeBeforeInput = (ev: InputEvent) => {
      const type = (ev as InputEvent).inputType;
      if (type !== 'insertParagraph') return;

      if (sendShortcut === 'cmdEnter') return;

      ev.preventDefault();
      if (completionSelectedRef.current) {
        completionSelectedRef.current = false;
        return;
      }
      if (fileCompletion.isOpen || commandCompletion.isOpen || agentCompletion.isOpen) {
        return;
      }
      handleSubmit();
    };

    el.addEventListener('keydown', nativeKeyDown, { capture: true });
    el.addEventListener('keyup', nativeKeyUp, { capture: true });
    el.addEventListener('beforeinput', nativeBeforeInput as EventListener, { capture: true });

    return () => {
      el.removeEventListener('keydown', nativeKeyDown, { capture: true });
      el.removeEventListener('keyup', nativeKeyUp, { capture: true });
      el.removeEventListener('beforeinput', nativeBeforeInput as EventListener, { capture: true });
    };
  }, [
    editableRef,
    isComposing,
    isComposingRef,
    lastCompositionEndTimeRef,
    sendShortcut,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    completionSelectedRef,
    submittedOnEnterRef,
    handleSubmit,
    handleEnhancePrompt,
  ]);
}
