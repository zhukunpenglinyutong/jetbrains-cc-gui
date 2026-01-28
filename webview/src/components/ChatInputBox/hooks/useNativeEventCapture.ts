import { useEffect, useRef } from 'react';
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
  // Keep latest values without re-subscribing native listeners on every render.
  const latestRef = useRef<UseNativeEventCaptureOptions>({
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
  });
  latestRef.current = {
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
  };

  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    const nativeKeyDown = (ev: KeyboardEvent) => {
      const latest = latestRef.current;
      const isIMEProcessing = ev.keyCode === 229 || ev.isComposing;
      if (isIMEProcessing) {
        latest.isComposingRef.current = true;
      }

      const isEnterKey = ev.key === 'Enter' || ev.keyCode === 13;

      if (ev.key === '/' && ev.metaKey && !ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
        latest.handleEnhancePrompt();
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

      if (latest.fileCompletion.isOpen || latest.commandCompletion.isOpen || latest.agentCompletion.isOpen) {
        return;
      }

      const isRecentlyComposing = Date.now() - latest.lastCompositionEndTimeRef.current < 100;
      const shift = (ev as KeyboardEvent).shiftKey === true;
      const metaOrCtrl = ev.metaKey || ev.ctrlKey;
      const isSendKey =
        latest.sendShortcut === 'cmdEnter'
          ? isEnterKey && metaOrCtrl && !latest.isComposingRef.current && !latest.isComposing
          : isEnterKey &&
            !shift &&
            !latest.isComposingRef.current &&
            !latest.isComposing &&
            !isRecentlyComposing;

      if (!isSendKey) return;

      ev.preventDefault();
      latest.submittedOnEnterRef.current = true;
      latest.handleSubmit();
    };

    const nativeKeyUp = (ev: KeyboardEvent) => {
      const latest = latestRef.current;
      const isEnterKey = ev.key === 'Enter' || ev.keyCode === 13;
      const shift = (ev as KeyboardEvent).shiftKey === true;
      const metaOrCtrl = ev.metaKey || ev.ctrlKey;

      const isSendKey =
        latest.sendShortcut === 'cmdEnter' ? isEnterKey && metaOrCtrl : isEnterKey && !shift;
      if (!isSendKey) return;

      ev.preventDefault();
      if (latest.completionSelectedRef.current) {
        latest.completionSelectedRef.current = false;
        return;
      }
      if (latest.submittedOnEnterRef.current) {
        latest.submittedOnEnterRef.current = false;
      }
    };

    const nativeBeforeInput = (ev: InputEvent) => {
      const latest = latestRef.current;
      const type = (ev as InputEvent).inputType;
      if (type !== 'insertParagraph') return;

      if (latest.sendShortcut === 'cmdEnter') return;

      ev.preventDefault();
      if (latest.completionSelectedRef.current) {
        latest.completionSelectedRef.current = false;
        return;
      }
      if (latest.fileCompletion.isOpen || latest.commandCompletion.isOpen || latest.agentCompletion.isOpen) {
        return;
      }
      latest.handleSubmit();
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
  ]);
}
