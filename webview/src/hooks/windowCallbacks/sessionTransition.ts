/**
 * sessionTransition.ts
 *
 * Helpers for session transition guard management and transient UI state reset.
 * These functions encapsulate the logic that coordinates the React state setters
 * and streaming refs when a new session is initiated.
 */

import type { MutableRefObject } from 'react';

export interface ResetTransientUiStateOptions {
  clearToasts: () => void;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;

  // Streaming refs
  isStreamingRef: MutableRefObject<boolean>;
  useBackendStreamingRenderRef: MutableRefObject<boolean>;
  streamingMessageIndexRef: MutableRefObject<number>;
  streamingContentRef: MutableRefObject<string>;
  streamingTextSegmentsRef: MutableRefObject<string[]>;
  activeTextSegmentIndexRef: MutableRefObject<number>;
  streamingThinkingSegmentsRef: MutableRefObject<string[]>;
  activeThinkingSegmentIndexRef: MutableRefObject<number>;
  seenToolUseCountRef: MutableRefObject<number>;
  autoExpandedThinkingKeysRef: MutableRefObject<Set<string>>;
  contentUpdateTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  thinkingUpdateTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;

  // Turn tracking ref (for streaming assistant isolation)
  streamingTurnIdRef: MutableRefObject<number>;
}

/**
 * Clear all transient UI state (streaming refs + React state flags).
 * Called on clearMessages and exposed as window.__resetTransientUiState so
 * useSessionManagement can invoke it synchronously during session transitions.
 */
export const buildResetTransientUiState = (opts: ResetTransientUiStateOptions) => {
  return () => {
    opts.clearToasts();
    opts.setStatus('');
    opts.setLoading(false);
    opts.setLoadingStartTime(null);
    opts.setIsThinking(false);
    opts.setStreamingActive(false);
    opts.isStreamingRef.current = false;
    opts.useBackendStreamingRenderRef.current = false;
    opts.streamingMessageIndexRef.current = -1;
    opts.streamingContentRef.current = '';
    opts.streamingTextSegmentsRef.current = [];
    opts.activeTextSegmentIndexRef.current = -1;
    opts.streamingThinkingSegmentsRef.current = [];
    opts.activeThinkingSegmentIndexRef.current = -1;
    opts.seenToolUseCountRef.current = 0;
    opts.autoExpandedThinkingKeysRef.current.clear();
    // Reset active turn ID to prevent stale streaming assistant recovery.
    // NOTE: turnIdCounterRef is intentionally NOT reset — it must stay monotonically
    // increasing across sessions so that stale messages from an old session can never
    // collide with a new session's turn IDs (and React keys like "turn-N" stay unique).
    opts.streamingTurnIdRef.current = -1;
    if (opts.contentUpdateTimeoutRef.current) {
      clearTimeout(opts.contentUpdateTimeoutRef.current);
      opts.contentUpdateTimeoutRef.current = null;
    }
    if (opts.thinkingUpdateTimeoutRef.current) {
      clearTimeout(opts.thinkingUpdateTimeoutRef.current);
      opts.thinkingUpdateTimeoutRef.current = null;
    }
  };
};

/**
 * Release the session transition guard flags set by beginSessionTransition
 * (useSessionManagement).
 */
export const releaseSessionTransition = (): void => {
  if (window.__sessionTransitioning) {
    window.__sessionTransitioning = false;
  }
  window.__sessionTransitionToken = null;
};
