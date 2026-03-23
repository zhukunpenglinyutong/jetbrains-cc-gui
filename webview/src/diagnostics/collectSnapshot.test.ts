import { collectSnapshot, type CollectSnapshotRefs } from './collectSnapshot.js';
import type { DiagnosticEvent } from '../hooks/useDiagnosticRingBuffer.js';

describe('collectSnapshot', () => {
  function createMockRefs(
    overrides: Partial<CollectSnapshotRefs> = {},
  ): CollectSnapshotRefs {
    return {
      bugId: 'B-021',
      trigger: 'ui',
      events: [],

      // Scroll refs
      messagesContainerRef: { current: null },
      isUserAtBottomRef: { current: true },
      isAutoScrollingRef: { current: false },
      userPausedRef: { current: false },

      // Streaming refs
      isStreamingRef: { current: false },
      streamingMessageIndexRef: { current: -1 },
      streamingContentRef: { current: '' },
      streamingTextSegmentsRef: { current: [] },
      streamingThinkingSegmentsRef: { current: [] },
      seenToolUseCountRef: { current: 0 },
      useBackendStreamingRenderRef: { current: false },

      // App state
      messageCount: 0,
      loading: false,
      isThinking: false,
      streamingActive: false,
      currentSessionId: null,
      currentView: 'chat',
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250514',

      ...overrides,
    };
  }

  it('returns snapshot with correct structure and version', () => {
    const snapshot = collectSnapshot(createMockRefs());

    expect(snapshot.version).toBe(1);
    expect(snapshot.bugId).toBe('B-021');
    expect(snapshot.trigger).toBe('ui');
    expect(snapshot.timestamp).toBeTruthy();
    expect(new Date(snapshot.timestamp).getTime()).not.toBeNaN();

    // All top-level sections present
    expect(snapshot).toHaveProperty('events');
    expect(snapshot).toHaveProperty('scroll');
    expect(snapshot).toHaveProperty('streaming');
    expect(snapshot).toHaveProperty('app');
  });

  it('captures scroll state from container ref', () => {
    const container = {
      scrollTop: 500,
      scrollHeight: 2000,
      clientHeight: 600,
    } as unknown as HTMLDivElement;

    const snapshot = collectSnapshot(
      createMockRefs({
        messagesContainerRef: { current: container },
        isUserAtBottomRef: { current: false },
        isAutoScrollingRef: { current: true },
        userPausedRef: { current: true },
      }),
    );

    expect(snapshot.scroll.scrollTop).toBe(500);
    expect(snapshot.scroll.scrollHeight).toBe(2000);
    expect(snapshot.scroll.clientHeight).toBe(600);
    expect(snapshot.scroll.distanceFromBottom).toBe(900); // 2000 - 500 - 600
    expect(snapshot.scroll.isUserAtBottom).toBe(false);
    expect(snapshot.scroll.isAutoScrolling).toBe(true);
    expect(snapshot.scroll.userPaused).toBe(true);
  });

  it('defaults scroll values to 0 when container is null', () => {
    const snapshot = collectSnapshot(
      createMockRefs({ messagesContainerRef: { current: null } }),
    );

    expect(snapshot.scroll.scrollTop).toBe(0);
    expect(snapshot.scroll.scrollHeight).toBe(0);
    expect(snapshot.scroll.clientHeight).toBe(0);
    expect(snapshot.scroll.distanceFromBottom).toBe(0);
  });

  it('captures streaming state', () => {
    const snapshot = collectSnapshot(
      createMockRefs({
        isStreamingRef: { current: true },
        streamingMessageIndexRef: { current: 42 },
        streamingContentRef: { current: 'Hello world' },
        streamingTextSegmentsRef: { current: ['Hello', ' world'] },
        streamingThinkingSegmentsRef: { current: ['thinking...'] },
        seenToolUseCountRef: { current: 3 },
        useBackendStreamingRenderRef: { current: true },
      }),
    );

    expect(snapshot.streaming.isStreaming).toBe(true);
    expect(snapshot.streaming.streamingMessageIndex).toBe(42);
    expect(snapshot.streaming.contentLength).toBe(11); // 'Hello world'.length
    expect(snapshot.streaming.textSegmentCount).toBe(2);
    expect(snapshot.streaming.thinkingSegmentCount).toBe(1);
    expect(snapshot.streaming.toolUseCount).toBe(3);
    expect(snapshot.streaming.useBackendRendering).toBe(true);
  });

  it('captures app state', () => {
    const snapshot = collectSnapshot(
      createMockRefs({
        messageCount: 127,
        loading: true,
        isThinking: true,
        streamingActive: true,
        currentSessionId: 'sess-abc-123',
        currentView: 'history',
        provider: 'codex',
        model: 'gpt-5.4',
      }),
    );

    expect(snapshot.app.messageCount).toBe(127);
    expect(snapshot.app.loading).toBe(true);
    expect(snapshot.app.isThinking).toBe(true);
    expect(snapshot.app.streamingActive).toBe(true);
    expect(snapshot.app.currentSessionId).toBe('sess-abc-123');
    expect(snapshot.app.currentView).toBe('history');
    expect(snapshot.app.provider).toBe('codex');
    expect(snapshot.app.model).toBe('gpt-5.4');
  });

  it('includes diagnostic events in snapshot', () => {
    const events: DiagnosticEvent[] = [
      { ts: 1000, type: 'stream_start' },
      { ts: 2000, type: 'scroll_jump', data: { distance: 500 } },
      { ts: 3000, type: 'stream_end' },
    ];

    const snapshot = collectSnapshot(createMockRefs({ events }));

    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.events[0].type).toBe('stream_start');
    expect(snapshot.events[1].data).toEqual({ distance: 500 });
  });

  it('propagates trigger type correctly', () => {
    for (const trigger of ['ui', 'file', 'command'] as const) {
      const snapshot = collectSnapshot(createMockRefs({ trigger }));
      expect(snapshot.trigger).toBe(trigger);
    }
  });
});
