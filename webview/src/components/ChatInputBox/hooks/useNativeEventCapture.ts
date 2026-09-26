import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import type { SendShortcut } from '../types.js';
import {
  catchStrayEnter,
  claimEnterPress,
  isEnterKey,
  isSendKey,
  releaseEnterKeyUp,
  releaseEnterPress,
  triageEnterKeyDown,
} from '../utils/enterKeyGuard.js';
import type { EnterKeyRefs } from '../utils/enterKeyGuard.js';

interface CompletionOpenLike {
  isOpen: boolean;
}

export interface UseNativeEventCaptureOptions extends EnterKeyRefs {
  editableRef: React.RefObject<HTMLDivElement | null>;
  sendShortcut: SendShortcut;
  fileCompletion: CompletionOpenLike;
  commandCompletion: CompletionOpenLike;
  agentCompletion: CompletionOpenLike;
  promptCompletion: CompletionOpenLike;
  dollarCommandCompletion: CompletionOpenLike;
  handleSubmit: () => void;
  handleEnhancePrompt: () => void;
  handleCompositionEnd: () => void;
}

function isAnyCompletionOpen(options: UseNativeEventCaptureOptions): boolean {
  return (
    options.fileCompletion.isOpen ||
    options.commandCompletion.isOpen ||
    options.agentCompletion.isOpen ||
    options.promptCompletion.isOpen ||
    options.dollarCommandCompletion.isOpen
  );
}

/**
 * useNativeEventCapture - Native event capture for JCEF/IME edge cases
 *
 * Capturing listeners run before React's delegated handlers, so this layer
 * speaks for Enter first and useKeyboardHandler skips anything already
 * `defaultPrevented`. It also covers:
 * - beforeinput insertParagraph that JCEF delivers without a keydown (Enter-to-send mode)
 * - prompt enhancer shortcut (Cmd+/)
 */
export function useNativeEventCapture(options: UseNativeEventCaptureOptions): void {
  const { editableRef, sendShortcut, handleSubmit, handleEnhancePrompt } = options;
  const enterWasComposingRef = useRef(false);
  // useEffectEvent keeps the first committed submit in JCEF. Enter would then
  // still see the initial Claude frame, where SDK status is loading and the
  // provider is not installed, and toast instead of sending.
  const handleSubmitRef = useRef(handleSubmit);
  useLayoutEffect(() => {
    handleSubmitRef.current = handleSubmit;
  });

  // Effect Events only swap their implementation on commit, so the listeners
  // below stay subscribed for the element's lifetime yet never act on props
  // from a render that was interrupted or suspended.
  const onNativeKeyDown = useEffectEvent((ev: KeyboardEvent) => {
    if (ev.key === '/' && ev.metaKey && !ev.shiftKey && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      handleEnhancePrompt();
      return;
    }

    // NOTE: We intentionally do NOT set isComposingRef here based on keyCode 229.
    // IME composing state is managed exclusively by compositionStart/End events.
    // In JCEF, keyCode 229 is reported for ALL keys while the Korean IME is active,
    // including space, which is not an actual composition. Setting isComposingRef=true
    // here without a corresponding compositionEnd to clear it causes the ref to get
    // stuck, blocking handleInput and causing cursor jumping on space key.
    if (!isEnterKey(ev.key, ev.keyCode)) return;
    if (!ev.repeat) enterWasComposingRef.current = ev.isComposing;

    const verdict = triageEnterKeyDown(ev, ev.isComposing, sendShortcut, options);
    if (verdict === 'awaitingIme') {
      // Keep the native candidate confirmation, but don't let React reclassify
      // this same press if the composition guard expires during propagation.
      ev.stopPropagation();
      return;
    }
    if (verdict === 'swallowed') return;
    // Open completion menus read Enter through the React handler.
    if (isAnyCompletionOpen(options) || !isSendKey(sendShortcut, ev)) return;

    claimEnterPress(ev, options);
    handleSubmitRef.current();
  });

  const onNativeKeyUp = useEffectEvent((ev: KeyboardEvent) => {
    if (!isEnterKey(ev.key, ev.keyCode)) return;
    enterWasComposingRef.current = false;
    releaseEnterKeyUp(ev, sendShortcut, options);
  });

  const onNativeBeforeInput = useEffectEvent((ev: InputEvent) => {
    catchStrayEnter(ev, sendShortcut, options, isAnyCompletionOpen(options), () => {
      handleSubmitRef.current();
    });
    if (
      ev.inputType === 'insertParagraph' &&
      options.isComposingRef.current &&
      !ev.isComposing &&
      !enterWasComposingRef.current
    ) {
      // Chromium can emit a non-composing paragraph during an IME-owned Enter.
      // Only recover a lost compositionend when neither event signals composition.
      options.handleCompositionEnd();
    }
  });

  // Focus can leave the editor before Enter's keyup arrives (a dialog opened by
  // the send, an IDE shortcut); the press must not stay spoken for.
  const onBlur = useEffectEvent(() => {
    enterWasComposingRef.current = false;
    releaseEnterPress(options);
  });

  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    el.addEventListener('keydown', onNativeKeyDown, { capture: true });
    el.addEventListener('keyup', onNativeKeyUp, { capture: true });
    el.addEventListener('beforeinput', onNativeBeforeInput as EventListener, { capture: true });
    el.addEventListener('blur', onBlur);

    return () => {
      el.removeEventListener('keydown', onNativeKeyDown, { capture: true });
      el.removeEventListener('keyup', onNativeKeyUp, { capture: true });
      el.removeEventListener('beforeinput', onNativeBeforeInput as EventListener, { capture: true });
      el.removeEventListener('blur', onBlur);
    };
  }, [editableRef]);
}
