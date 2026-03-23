/**
 * F-007: Collect a diagnostic snapshot from the webview side.
 * Gathers scroll state, streaming state, app state, and the event ring buffer.
 */

import type { DiagnosticEvent } from '../hooks/useDiagnosticRingBuffer';

export interface WebviewSnapshot {
  version: number;
  bugId: string;
  timestamp: string;
  trigger: 'ui' | 'file' | 'command';

  events: DiagnosticEvent[];

  scroll: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    distanceFromBottom: number;
    isUserAtBottom: boolean;
    isAutoScrolling: boolean;
    userPaused: boolean;
  };

  streaming: {
    isStreaming: boolean;
    streamingMessageIndex: number;
    contentLength: number;
    textSegmentCount: number;
    thinkingSegmentCount: number;
    toolUseCount: number;
    useBackendRendering: boolean;
  };

  app: {
    messageCount: number;
    loading: boolean;
    isThinking: boolean;
    streamingActive: boolean;
    currentSessionId: string | null;
    currentView: string;
    provider: string;
    model: string;
  };
}

export interface CollectSnapshotRefs {
  bugId: string;
  trigger: 'ui' | 'file' | 'command';
  events: DiagnosticEvent[];

  // Scroll refs
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  isUserAtBottomRef: React.MutableRefObject<boolean>;
  isAutoScrollingRef: React.MutableRefObject<boolean>;
  userPausedRef: React.MutableRefObject<boolean>;

  // Streaming refs
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
  provider: string;
  model: string;
}

export function collectSnapshot(refs: CollectSnapshotRefs): WebviewSnapshot {
  const container = refs.messagesContainerRef.current;
  const scrollTop = container?.scrollTop ?? 0;
  const scrollHeight = container?.scrollHeight ?? 0;
  const clientHeight = container?.clientHeight ?? 0;

  return {
    version: 1,
    bugId: refs.bugId,
    timestamp: new Date().toISOString(),
    trigger: refs.trigger,

    events: refs.events,

    scroll: {
      scrollTop,
      scrollHeight,
      clientHeight,
      distanceFromBottom: scrollHeight - scrollTop - clientHeight,
      isUserAtBottom: refs.isUserAtBottomRef.current,
      isAutoScrolling: refs.isAutoScrollingRef.current,
      userPaused: refs.userPausedRef.current,
    },

    streaming: {
      isStreaming: refs.isStreamingRef.current,
      streamingMessageIndex: refs.streamingMessageIndexRef.current,
      contentLength: refs.streamingContentRef.current.length,
      textSegmentCount: refs.streamingTextSegmentsRef.current.length,
      thinkingSegmentCount: refs.streamingThinkingSegmentsRef.current.length,
      toolUseCount: refs.seenToolUseCountRef.current,
      useBackendRendering: refs.useBackendStreamingRenderRef.current,
    },

    app: {
      messageCount: refs.messageCount,
      loading: refs.loading,
      isThinking: refs.isThinking,
      streamingActive: refs.streamingActive,
      currentSessionId: refs.currentSessionId,
      currentView: refs.currentView,
      provider: refs.provider,
      model: refs.model,
    },
  };
}
