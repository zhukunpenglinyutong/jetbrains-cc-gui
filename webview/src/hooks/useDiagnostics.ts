/**
 * F-007/F-010: Central diagnostics hook.
 * Consolidates snapshot collection, window callbacks, and /report command from App.tsx.
 *
 * Usage in App.tsx (minimal upstream footprint):
 *
 *   // 1. Diagnostics state + ring buffer (before useScrollBehavior)
 *   const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(...);
 *   const ringBuffer = useDiagnosticRingBuffer(diagnosticsEnabled);
 *
 *   // 2. Scroll behavior (uses pushEvent)
 *   const scrollRefs = useScrollBehavior({ ..., onDiagnosticEvent: ringBuffer.pushEvent });
 *
 *   // 3. Streaming messages
 *   const streamingRefs = useStreamingMessages(...);
 *
 *   // 4. Diagnostics (snapshot collection, window callbacks, /report)
 *   const diagnostics = useDiagnostics({ ... });
 *
 *   // 5. Pass to ChatHeader
 *   <ChatHeader diagnosticsEnabled={diagnosticsEnabled} onBugReport={diagnostics.handleBugReport} ... />
 */

import { useCallback, useEffect, useRef } from 'react';
import type { DiagnosticRingBuffer } from './useDiagnosticRingBuffer';
import { collectSnapshot, type CollectSnapshotRefs } from '../diagnostics/collectSnapshot';
import { sendBridgeEvent } from '../utils/bridge';

export interface UseDiagnosticsOptions {
  diagnosticsEnabled: boolean;
  ringBuffer: DiagnosticRingBuffer;

  // Scroll refs (from useScrollBehavior)
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  isUserAtBottomRef: React.MutableRefObject<boolean>;
  isAutoScrollingRef: React.MutableRefObject<boolean>;
  userPausedRef: React.MutableRefObject<boolean>;

  // Streaming refs (from useStreamingMessages)
  isStreamingRef: React.MutableRefObject<boolean>;
  streamingMessageIndexRef: React.MutableRefObject<number>;
  streamingContentRef: React.MutableRefObject<string>;
  streamingTextSegmentsRef: React.MutableRefObject<string[]>;
  streamingThinkingSegmentsRef: React.MutableRefObject<string[]>;
  seenToolUseCountRef: React.MutableRefObject<number>;
  useBackendStreamingRenderRef: React.MutableRefObject<boolean>;

  // App state
  messageCount: number;
  loading: boolean;
  isThinking: boolean;
  streamingActive: boolean;
  currentSessionId: string | null;
  currentView: string;
  currentProvider: string;
  selectedModel: string;

  // Diagnostics toggle handler (from App.tsx state)
  onDiagnosticsToggle: (enabled: boolean) => void;
}

export interface UseDiagnosticsReturn {
  /** Handle a bug report from the UI (BugDropdown selection) */
  handleBugReport: (bugId: string) => void;
  /** Check if text is a /report command and handle it. Returns true if handled. */
  handleReportCommand: (
    text: string,
    addToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void,
    t: (key: string, fallback: string) => string,
  ) => boolean;
}

export function useDiagnostics(options: UseDiagnosticsOptions): UseDiagnosticsReturn {
  const {
    // diagnosticsEnabled accessed via stateRef.current to avoid stale closures
    ringBuffer,
    messagesContainerRef,
    isUserAtBottomRef,
    isAutoScrollingRef,
    userPausedRef,
    isStreamingRef,
    streamingMessageIndexRef,
    streamingContentRef,
    streamingTextSegmentsRef,
    streamingThinkingSegmentsRef,
    seenToolUseCountRef,
    useBackendStreamingRenderRef,
    onDiagnosticsToggle,
  } = options;

  // Stable ref for dynamic state (avoids stale closures in window callbacks)
  const stateRef = useRef(options);
  stateRef.current = options;

  // Build CollectSnapshotRefs from current state
  const buildSnapshotRefs = useCallback(
    (bugId: string, trigger: 'ui' | 'file' | 'command'): CollectSnapshotRefs => {
      const s = stateRef.current;
      return {
        bugId,
        trigger,
        events: ringBuffer.getEvents(),
        messagesContainerRef,
        isUserAtBottomRef,
        isAutoScrollingRef,
        userPausedRef,
        isStreamingRef,
        streamingMessageIndexRef,
        streamingContentRef,
        streamingTextSegmentsRef,
        streamingThinkingSegmentsRef,
        seenToolUseCountRef,
        useBackendStreamingRenderRef,
        messageCount: s.messageCount,
        loading: s.loading,
        isThinking: s.isThinking,
        streamingActive: s.streamingActive,
        currentSessionId: s.currentSessionId,
        currentView: s.currentView,
        provider: s.currentProvider,
        model: s.selectedModel,
      };
    },
    // Refs are stable — only ringBuffer identity matters
    [ringBuffer, messagesContainerRef, isUserAtBottomRef, isAutoScrollingRef, userPausedRef,
     isStreamingRef, streamingMessageIndexRef, streamingContentRef, streamingTextSegmentsRef,
     streamingThinkingSegmentsRef, seenToolUseCountRef, useBackendStreamingRenderRef],
  );

  // Handle bug report from UI (BugDropdown)
  const handleBugReport = useCallback(
    (bugId: string) => {
      if (!stateRef.current.diagnosticsEnabled) return;
      const snapshot = collectSnapshot(buildSnapshotRefs(bugId, 'ui'));
      sendBridgeEvent('diagnostic_snapshot', JSON.stringify(snapshot));
    },
    [buildSnapshotRefs],
  );

  // Register window callbacks for Java → Webview communication
  useEffect(() => {
    window.updateDiagnosticsEnabled = (json: string) => {
      try {
        const data = JSON.parse(json);
        onDiagnosticsToggle(!!data.diagnosticsEnabled);
      } catch { /* ignore */ }
    };

    window.collectDiagnosticSnapshot = (bugId: string) => {
      const snapshot = collectSnapshot(buildSnapshotRefs(bugId, 'file'));
      sendBridgeEvent('diagnostic_snapshot', JSON.stringify(snapshot));
    };

    return () => {
      delete window.updateDiagnosticsEnabled;
      delete window.collectDiagnosticSnapshot;
    };
  }, [onDiagnosticsToggle, buildSnapshotRefs]);

  // /report command handler
  const handleReportCommand = useCallback(
    (
      text: string,
      addToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void,
      t: (key: string, fallback: string) => string,
    ): boolean => {
      if (!text.toLowerCase().startsWith('/report')) return false;
      const parts = text.split(/\s+/);
      if (parts[0].toLowerCase() !== '/report') return false;

      if (!stateRef.current.diagnosticsEnabled) {
        addToast(
          t('diagnostics.notEnabled', 'Diagnostics not enabled. Enable in settings or localStorage.'),
          'warning',
        );
        return true;
      }
      const bugId = parts[1] || 'UNKNOWN';
      const snapshot = collectSnapshot(buildSnapshotRefs(bugId, 'command'));
      sendBridgeEvent('diagnostic_snapshot', JSON.stringify(snapshot));
      addToast(t('diagnostics.snapshotSaved', 'Diagnostic snapshot saved'), 'success');
      return true;
    },
    [buildSnapshotRefs],
  );

  return {
    handleBugReport,
    handleReportCommand,
  };
}
