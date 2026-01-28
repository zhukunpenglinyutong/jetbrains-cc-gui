import { useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';

interface CompletionWithKeyDown {
  isOpen: boolean;
  handleKeyDown: (ev: KeyboardEvent) => boolean;
}

export interface UseKeyboardHandlerOptions {
  isComposing: boolean;
  lastCompositionEndTimeRef: MutableRefObject<number>;
  sendShortcut: 'enter' | 'cmdEnter';
  sdkStatusLoading: boolean;
  sdkInstalled: boolean;
  fileCompletion: CompletionWithKeyDown;
  commandCompletion: CompletionWithKeyDown;
  agentCompletion: CompletionWithKeyDown;
  handleMacCursorMovement: (e: ReactKeyboardEvent<HTMLDivElement>) => boolean;
  handleHistoryKeyDown: (e: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => boolean;
  completionSelectedRef: MutableRefObject<boolean>;
  submittedOnEnterRef: MutableRefObject<boolean>;
  handleSubmit: () => void;
}

/**
 * useKeyboardHandler - React keyboard event handling for the chat input box
 *
 * Handles:
 * - Completion dropdown navigation
 * - History navigation (when input empty)
 * - Send shortcut (Enter / Cmd+Enter)
 * - Preventing IME "confirm enter" false send
 */
export function useKeyboardHandler({
  isComposing,
  lastCompositionEndTimeRef,
  sendShortcut,
  sdkStatusLoading,
  sdkInstalled,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  handleMacCursorMovement,
  handleHistoryKeyDown,
  completionSelectedRef,
  submittedOnEnterRef,
  handleSubmit,
}: UseKeyboardHandlerOptions) {
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const isIMEComposing = isComposing || e.nativeEvent.isComposing;

      const isEnterKey =
        e.key === 'Enter' || e.nativeEvent.keyCode === 13;

      if (handleMacCursorMovement(e)) return;

      const isCursorMovementKey =
        e.key === 'Home' ||
        e.key === 'End' ||
        ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.metaKey) ||
        ((e.key === 'e' || e.key === 'E') && e.ctrlKey && !e.metaKey);
      if (isCursorMovementKey) return;

      if (fileCompletion.isOpen) {
        const handled = fileCompletion.handleKeyDown(e.nativeEvent);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Enter') completionSelectedRef.current = true;
          return;
        }
      }

      if (commandCompletion.isOpen) {
        const handled = commandCompletion.handleKeyDown(e.nativeEvent);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Enter') completionSelectedRef.current = true;
          return;
        }
      }

      if (agentCompletion.isOpen) {
        const handled = agentCompletion.handleKeyDown(e.nativeEvent);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Enter') completionSelectedRef.current = true;
          return;
        }
      }

      if (handleHistoryKeyDown(e)) return;

      const isRecentlyComposing = Date.now() - lastCompositionEndTimeRef.current < 100;
      const isSendKey =
        sendShortcut === 'cmdEnter'
          ? isEnterKey && (e.metaKey || e.ctrlKey) && !isIMEComposing
          : isEnterKey && !e.shiftKey && !isIMEComposing && !isRecentlyComposing;

      if (!isSendKey) return;

      e.preventDefault();
      if (sdkStatusLoading || !sdkInstalled) return;

      submittedOnEnterRef.current = true;
      handleSubmit();
    },
    [
      isComposing,
      handleMacCursorMovement,
      fileCompletion,
      commandCompletion,
      agentCompletion,
      handleHistoryKeyDown,
      lastCompositionEndTimeRef,
      sendShortcut,
      sdkStatusLoading,
      sdkInstalled,
      submittedOnEnterRef,
      completionSelectedRef,
      handleSubmit,
    ]
  );

  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const isEnterKey =
        e.key === 'Enter' || e.nativeEvent.keyCode === 13;

      const isSendKey =
        sendShortcut === 'cmdEnter'
          ? isEnterKey && (e.metaKey || e.ctrlKey)
          : isEnterKey && !e.shiftKey;

      if (!isSendKey) return;
      e.preventDefault();

      if (completionSelectedRef.current) {
        completionSelectedRef.current = false;
        return;
      }
      if (submittedOnEnterRef.current) {
        submittedOnEnterRef.current = false;
      }
    },
    [sendShortcut, completionSelectedRef, submittedOnEnterRef]
  );

  return { onKeyDown, onKeyUp };
}
