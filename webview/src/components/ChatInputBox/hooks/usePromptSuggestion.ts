import { useCallback, useEffect, useRef, useState } from 'react';
import { sendToJava } from '../../../utils/bridge.js';

export interface UsePromptSuggestionReturn {
  /** The current suggestion text (empty string when none) */
  suggestion: string;
  /** Accept the current suggestion — returns the text or null */
  acceptSuggestion: () => string | null;
  /** Clear the current suggestion */
  clearSuggestion: () => void;
  /** Increment the epoch (call on message send or AI response start) */
  bumpEpoch: () => void;
  /** Request a new suggestion from Java backend */
  requestSuggestion: () => void;
}

/**
 * Manages AI-generated prompt suggestions displayed as ghost text
 * when the input box is empty.
 *
 * - Receives suggestions from Java backend via window.onPromptSuggestion
 * - Tracks a request epoch to discard stale suggestions
 * - Enabled/disabled state is controlled by Claude Code's own config (Java layer)
 */
export function usePromptSuggestion(): UsePromptSuggestionReturn {
  const [suggestion, setSuggestion] = useState('');

  // Epoch counter to detect stale suggestions
  const epochRef = useRef(0);
  // The epoch at which the most recent request was sent
  const requestEpochRef = useRef(0);

  // Register the window callback for receiving suggestions from Java
  useEffect(() => {
    const handler = (text: string) => {
      // Only accept if the epoch hasn't changed since the request
      if (epochRef.current !== requestEpochRef.current) {
        return;
      }
      setSuggestion(text || '');
    };

    (window as any).onPromptSuggestion = handler;

    return () => {
      if ((window as any).onPromptSuggestion === handler) {
        (window as any).onPromptSuggestion = undefined;
      }
    };
  }, []);

  const acceptSuggestion = useCallback((): string | null => {
    if (!suggestion) return null;
    const text = suggestion;
    setSuggestion('');
    return text;
  }, [suggestion]);

  const clearSuggestion = useCallback(() => {
    setSuggestion('');
  }, []);

  const bumpEpoch = useCallback(() => {
    epochRef.current += 1;
    setSuggestion('');
  }, []);

  const requestSuggestion = useCallback(() => {
    // Record the current epoch for this request
    requestEpochRef.current = epochRef.current;
    // Java layer extracts recent messages from session state
    sendToJava('request_prompt_suggestion', '');
  }, []);

  return {
    suggestion,
    acceptSuggestion,
    clearSuggestion,
    bumpEpoch,
    requestSuggestion,
  };
}
