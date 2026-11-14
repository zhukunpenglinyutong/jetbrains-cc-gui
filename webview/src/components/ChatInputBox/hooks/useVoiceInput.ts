import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

declare global {
  interface Window {
    onVoiceInputUpdate?: (payload: string) => void;
    /** Called by the IDE's Voice Input keymap action on key press and release. */
    voiceInputShortcut?: (phase: VoiceShortcutPhase) => void;
  }
}

export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

export type VoiceShortcutPhase = 'down' | 'up';

/** The endpoint or model is missing or unusable; the user has to fix the settings. */
export type VoiceInputConfigProblem =
  | 'missing_endpoint'
  | 'invalid_endpoint'
  | 'insecure_endpoint'
  | 'missing_model';

export const VOICE_INPUT_CONFIG_PROBLEMS: readonly VoiceInputConfigProblem[] = [
  'missing_endpoint',
  'invalid_endpoint',
  'insecure_endpoint',
  'missing_model',
];

export type VoiceInputErrorCode =
  | VoiceInputConfigProblem
  | 'mic_unavailable'
  | 'too_short'
  | 'no_speech'
  | 'config_unreadable'
  | 'transcription_failed';

/** Message pushed by VoiceInputHandler (Java). */
export interface VoiceInputUpdate {
  state?: VoiceInputState;
  text?: string;
  errorCode?: VoiceInputErrorCode;
  error?: string;
  /** Keymap binding of the Voice Input action, e.g. "Ctrl+Shift+."; empty when unbound. */
  shortcut?: string;
}

interface UseVoiceInputOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  setHasContent: (hasContent: boolean) => void;
  onInput?: (content: string) => void;
  onError?: (code: VoiceInputErrorCode, detail?: string) => void;
}

export interface UseVoiceInputReturn {
  state: VoiceInputState;
  /** Starts recording when idle, stops and transcribes when recording. */
  toggle: () => void;
  /** Drops the current clip without transcribing it. */
  cancel: () => void;
  /** Current keymap binding for push-to-talk; empty when unbound. */
  shortcut: string;
}

const VALID_STATES: readonly VoiceInputState[] = ['idle', 'recording', 'transcribing'];

/** A press held at least this long is push-to-talk (release stops); shorter is a toggle tap. */
export const PUSH_TO_TALK_HOLD_MS = 400;


/**
 * Inserts dictated text at a collapsed caret inside the input box, otherwise at the end,
 * with a separating space when it would otherwise glue onto the previous word.
 */
export function insertDictatedText(editable: HTMLElement, text: string): void {
  const selection = window.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const caretInside = range !== null && range.collapsed && editable.contains(range.startContainer);

  const target = caretInside ? range : document.createRange();
  if (!caretInside) {
    target.selectNodeContents(editable);
    target.collapse(false);
  }

  const before = textBefore(editable, target);
  // Live phrases may arrive as ". Next sentence" to close the previous one; drop that
  // when the user already ended the sentence or cleared the box in the meantime.
  const body = /(^|[.!?…])\s*$/.test(before) ? text.replace(/^\.\s+/, '') : text;
  const needsSpace = before.length > 0 && !/\s$/.test(before) && !/^[.,!?;:]/.test(body);
  const node = document.createTextNode(`${needsSpace ? ' ' : ''}${body}`);
  target.insertNode(node);

  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(after);
}

/** The chat stays mounted (display: none) while settings or history are open. */
function isShown(element: HTMLElement | null): boolean {
  if (!element) return false;
  return typeof element.checkVisibility === 'function' ? element.checkVisibility() : true;
}

function textBefore(editable: HTMLElement, caret: Range): string {
  const prefix = document.createRange();
  prefix.selectNodeContents(editable);
  prefix.setEnd(caret.startContainer, caret.startOffset);
  return prefix.toString();
}

/**
 * useVoiceInput - push-to-talk dictation into the chat input box.
 *
 * The microphone is recorded and transcribed on the Java side (JCEF has no
 * microphone or Web Speech access); this hook only drives state and inserts text.
 */
export function useVoiceInput({
  editableRef,
  getTextContent,
  setHasContent,
  onInput,
  onError,
}: UseVoiceInputOptions): UseVoiceInputReturn {
  const [state, setState] = useState<VoiceInputState>('idle');
  const [shortcut, setShortcut] = useState('');
  const stateRef = useRef<VoiceInputState>('idle');
  /** When the current shortcut press started a recording; null when it did not. */
  const pressStartedRef = useRef<number | null>(null);

  const applyState = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const toggle = useCallback(() => {
    if (!window.sendToJava) return;
    pressStartedRef.current = null;
    if (stateRef.current === 'idle') {
      // Optimistic: the mic button reacts at once; Java confirms or reports an error.
      applyState('recording');
      window.sendToJava('voice_input_start:');
    } else if (stateRef.current === 'recording') {
      applyState('transcribing');
      window.sendToJava('voice_input_stop:');
    }
  }, [applyState]);

  const cancel = useCallback(() => {
    if (stateRef.current === 'idle') return;
    applyState('idle');
    window.sendToJava?.('voice_input_cancel:');
  }, [applyState]);

  const handleUpdate = useEffectEvent((payload: string) => {
    let update: VoiceInputUpdate;
    try {
      update = JSON.parse(payload) as VoiceInputUpdate;
    } catch {
      return;
    }
    if (update.state && VALID_STATES.includes(update.state)) {
      applyState(update.state);
    }
    if (typeof update.shortcut === 'string') {
      setShortcut(update.shortcut);
    }
    if (update.errorCode) {
      onError?.(update.errorCode, update.error);
    }
    const text = update.text?.trim();
    if (text && editableRef.current) {
      insertDictatedText(editableRef.current, text);
      setHasContent(true);
      onInput?.(getTextContent());
    }
  });

  // The shortcut is an IDE keymap action (rebindable, works from the editor too); Java
  // forwards press and release, and the hold time decides push-to-talk versus toggle.
  const handleShortcut = useEffectEvent((phase: VoiceShortcutPhase) => {
    if (phase === 'down') {
      if (!isShown(editableRef.current) || stateRef.current === 'transcribing') return;
      const startsRecording = stateRef.current === 'idle';
      toggle();
      pressStartedRef.current = startsRecording ? Date.now() : null;
      return;
    }
    if (pressStartedRef.current === null) return;
    const heldMs = Date.now() - pressStartedRef.current;
    pressStartedRef.current = null;
    if (heldMs >= PUSH_TO_TALK_HOLD_MS && stateRef.current === 'recording') {
      toggle();
    }
  });

  const handleKeyDown = useEffectEvent((ev: KeyboardEvent) => {
    // Also while transcribing: an upload can take up to a minute and its result is then dropped.
    if (ev.key !== 'Escape' || stateRef.current === 'idle') return;
    // Only from the chat input (or nothing focused), so dialogs keep their own Escape.
    const target = ev.target as Node | null;
    const unfocused = target === document || target === document.body || target === document.documentElement;
    if (!unfocused && !editableRef.current?.contains(target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
  });

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  useEffect(() => {
    // Only remove what this mount installed; a newer mount may already own the globals.
    const onUpdate = (payload: string) => handleUpdate(payload);
    const onShortcut = (phase: VoiceShortcutPhase) => handleShortcut(phase);
    window.onVoiceInputUpdate = onUpdate;
    window.voiceInputShortcut = onShortcut;
    // Also tells Java that no older page is tracking a session (a reload skips our cleanup).
    window.sendToJava?.('voice_input_attach:');
    return () => {
      if (window.onVoiceInputUpdate === onUpdate) delete window.onVoiceInputUpdate;
      if (window.voiceInputShortcut === onShortcut) delete window.voiceInputShortcut;
      // Release the microphone if the input box goes away mid-recording.
      if (stateRef.current !== 'idle') {
        window.sendToJava?.('voice_input_cancel:');
      }
    };
  }, []);

  return { state, toggle, cancel, shortcut };
}
