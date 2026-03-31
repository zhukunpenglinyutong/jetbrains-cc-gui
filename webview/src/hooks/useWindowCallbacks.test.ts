// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStreamingMessages } from './useStreamingMessages.js';
import { useWindowCallbacks } from './useWindowCallbacks.js';
import type { UseWindowCallbacksOptions } from './useWindowCallbacks.js';
import type { ClaudeMessage } from '../types/index.js';

/**
 * Integration tests for useWindowCallbacks — verifies the real window callback
 * chain (historyLoadComplete, addErrorMessage, updateMessages guard, clearMessages,
 * setSessionId) rather than simulating state bits.
 */
describe('useWindowCallbacks integration', () => {
  const t = ((key: string) => key) as any;

  const flushDeferredUpdateMessages = async () => {
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
  };

  /** Build the full options object with vi.fn() stubs for every field. */
  const createOptions = (overrides?: Partial<UseWindowCallbacksOptions>): UseWindowCallbacksOptions => ({
    t,
    addToast: vi.fn(),
    clearToasts: vi.fn(),

    // State setters
    setMessages: vi.fn(),
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setIsThinking: vi.fn(),
    setExpandedThinking: vi.fn(),
    setStreamingActive: vi.fn(),
    setHistoryData: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setUsagePercentage: vi.fn(),
    setUsageUsedTokens: vi.fn(),
    setUsageMaxTokens: vi.fn(),
    setPermissionMode: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setProviderConfigVersion: vi.fn(),
    setActiveProviderConfig: vi.fn(),
    setClaudeSettingsAlwaysThinkingEnabled: vi.fn(),
    setStreamingEnabledSetting: vi.fn(),
    setSendShortcut: vi.fn(),
    setAutoOpenFileEnabled: vi.fn(),
    setSdkStatus: vi.fn(),
    setSdkStatusLoaded: vi.fn(),
    setIsRewinding: vi.fn(),
    setRewindDialogOpen: vi.fn(),
    setCurrentRewindRequest: vi.fn(),
    setContextInfo: vi.fn(),
    setSelectedAgent: vi.fn(),

    // Refs
    currentProviderRef: { current: 'claude' },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
    suppressNextStatusToastRef: { current: false },
    streamingContentRef: { current: '' },
    isStreamingRef: { current: false },
    autoExpandedThinkingKeysRef: { current: new Set<string>() },
    streamingTextSegmentsRef: { current: [] },
    activeTextSegmentIndexRef: { current: -1 },
    streamingThinkingSegmentsRef: { current: [] },
    activeThinkingSegmentIndexRef: { current: -1 },
    seenToolUseCountRef: { current: 0 },
    streamingMessageIndexRef: { current: -1 },
    streamingTurnIdRef: { current: -1 },
    turnIdCounterRef: { current: 0 },
    lastContentUpdateRef: { current: 0 },
    contentUpdateTimeoutRef: { current: null },
    lastThinkingUpdateRef: { current: 0 },
    thinkingUpdateTimeoutRef: { current: null },

    // Functions
    findLastAssistantIndex: (msgs: ClaudeMessage[]) =>
      msgs.reduce((acc, m, i) => (m.type === 'assistant' ? i : acc), -1),
    extractRawBlocks: () => [],
    findStreamingAssistantIndex: () => 0,
    patchAssistantForStreaming: (msg: ClaudeMessage, _patchState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => msg,
    syncActiveProviderModelMapping: vi.fn(),
    openPermissionDialog: vi.fn(),
    openAskUserQuestionDialog: vi.fn(),
    openPlanApprovalDialog: vi.fn(),

    // B-011
    customSessionTitleRef: { current: null },
    currentSessionIdRef: { current: null },
    updateHistoryTitle: vi.fn(),

    ...overrides,
  });

  beforeEach(() => {
    (window as any).__sessionTransitioning = false;
    (window as any).__sessionTransitionToken = null;
    (window as any).__deniedToolIds = new Set();
    window.sendToJava = vi.fn();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== historyLoadComplete releases transition guard =====

  it('historyLoadComplete releases __sessionTransitioning guard', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    // Simulate: beginSessionTransition sets guard
    (window as any).__sessionTransitioning = true;
    (window as any).__sessionTransitionToken = 'transition-1';

    // Simulate: Java calls historyLoadComplete on success
    act(() => {
      (window as any).historyLoadComplete();
    });

    expect((window as any).__sessionTransitioning).toBe(false);
    expect((window as any).__sessionTransitionToken).toBeNull();
  });

  it('historyLoadComplete clones the last message object so tool-status selectors recompute after history hydration', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      (window as any).historyLoadComplete();
    });

    expect(opts.setMessages).toHaveBeenCalled();
    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const lastMessage: ClaudeMessage = {
      type: 'assistant',
      content: 'tool call',
      raw: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } } as any,
    };
    const previous: ClaudeMessage[] = [
      { type: 'user', content: 'hi', timestamp: new Date().toISOString() },
      lastMessage,
    ];

    const next = updater(previous);

    expect(next).not.toBe(previous);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).not.toBe(lastMessage);
    expect(next[1]).toEqual(lastMessage);
  });

  // ===== setSessionId releases transition guard =====

  it('setSessionId releases __sessionTransitioning guard', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    (window as any).__sessionTransitioning = true;
    (window as any).__sessionTransitionToken = 'transition-2';

    act(() => {
      (window as any).setSessionId('new-session-123');
    });

    expect((window as any).__sessionTransitioning).toBe(false);
    expect((window as any).__sessionTransitionToken).toBeNull();
    expect(opts.setCurrentSessionId).toHaveBeenCalledWith('new-session-123');
  });

  // ===== updateMessages is blocked during transition =====

  it('updateMessages is silently dropped while __sessionTransitioning is true', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    (window as any).__sessionTransitioning = true;

    const staleMessages: ClaudeMessage[] = [
      { type: 'assistant', content: 'stale content', timestamp: new Date().toISOString() },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(staleMessages));
    });

    // setMessages should NOT be called because guard is active
    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it('updateMessages works normally after guard is released', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    // Guard is NOT set
    expect((window as any).__sessionTransitioning).toBe(false);

    const freshMessages: ClaudeMessage[] = [
      { type: 'user', content: 'hello', timestamp: new Date().toISOString() },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(freshMessages));
    });

    // setMessages SHOULD be called
    expect(opts.setMessages).toHaveBeenCalled();
  });

  it('patchMessageUuid updates the latest unresolved user message using raw text fallback', () => {
    const opts = createOptions({
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      (window as any).patchMessageUuid?.('Generated attachment summary', 'uuid-123');
    });

    expect(opts.setMessages).toHaveBeenCalledTimes(1);
    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'user',
        content: 'older',
        timestamp: new Date().toISOString(),
        raw: {},
      },
      {
        type: 'user',
        content: '',
        timestamp: new Date().toISOString(),
        raw: {
          message: {
            content: [
              { type: 'attachment', fileName: 'trace.log' },
              { type: 'text', text: 'Generated attachment summary' },
            ],
          },
        } as any,
      },
    ];

    const next = updater(previous);

    expect((next[0].raw as any)?.uuid).toBeUndefined();
    expect((next[1].raw as any)?.uuid).toBe('uuid-123');
  });

  it('patchMessageUuid is ignored while __sessionTransitioning is true', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    (window as any).__sessionTransitioning = true;

    act(() => {
      (window as any).patchMessageUuid?.('hello', 'uuid-guarded');
    });

    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it('updateStatus does not release an active transition token', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    (window as any).__sessionTransitioning = true;
    (window as any).__sessionTransitionToken = 'transition-status';

    act(() => {
      (window as any).updateStatus('warming runtime');
    });

    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBe('transition-status');
    expect(opts.setStatus).toHaveBeenCalledWith('warming runtime');
  });

  // ===== addErrorMessage only shows toast (no status) =====

  it('addErrorMessage shows toast but does not set status', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      (window as any).addErrorMessage('Something went wrong');
    });

    expect(opts.addToast).toHaveBeenCalledWith('Something went wrong', 'error');
    expect(opts.setStatus).not.toHaveBeenCalled();
  });

  // ===== clearMessages resets all transient UI state =====

  it('clearMessages resets streaming refs, loading, thinking, and status', () => {
    const isStreamingRef = { current: true };
    const streamingContentRef = { current: 'partial content' };
    const streamingMessageIndexRef = { current: 3 };
    const opts = createOptions({
      isStreamingRef,
      streamingContentRef,
      streamingMessageIndexRef,
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      (window as any).clearMessages();
    });

    expect(opts.setMessages).toHaveBeenCalledWith([]);
    expect(opts.clearToasts).toHaveBeenCalled();
    expect(opts.setStatus).toHaveBeenCalledWith('');
    expect(opts.setLoading).toHaveBeenCalledWith(false);
    expect(opts.setIsThinking).toHaveBeenCalledWith(false);
    expect(opts.setStreamingActive).toHaveBeenCalledWith(false);
    expect(isStreamingRef.current).toBe(false);
    expect(streamingContentRef.current).toBe('');
    expect(streamingMessageIndexRef.current).toBe(-1);
  });

  // ===== clearMessages resets turn tracking refs =====

  it('clearMessages resets streamingTurnIdRef but preserves turnIdCounterRef', () => {
    const streamingTurnIdRef = { current: 5 };
    const turnIdCounterRef = { current: 10 };
    const opts = createOptions({
      streamingTurnIdRef,
      turnIdCounterRef,
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      (window as any).clearMessages();
    });

    // Turn ID should be reset to -1 (no active streaming turn)
    expect(streamingTurnIdRef.current).toBe(-1);
    // Counter stays monotonically increasing (NOT reset) so React keys stay unique across sessions
    expect(turnIdCounterRef.current).toBe(10);
  });

  it('useStreamingMessages preserves meaningful blank lines inside thinking blocks', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingThinkingSegmentsRef.current = ['line 1\n\nline 2\n\n\nline 3'];
    });

    const blocks = result.current.buildStreamingBlocks([]);

    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'line 1\n\nline 2\n\n\nline 3' },
    ]);
  });

  it('useStreamingMessages suppresses whitespace-only thinking blocks', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingThinkingSegmentsRef.current = ['  \n\t\n  '];
    });

    const blocks = result.current.buildStreamingBlocks([]);

    expect(blocks).toEqual([]);
  });

  it('useStreamingMessages keeps a single thinking block when text delta interleaves between thinking deltas', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.isStreamingRef.current = true;
      result.current.streamingThinkingSegmentsRef.current = ['first'];
      result.current.activeThinkingSegmentIndexRef.current = 0;
      result.current.streamingContentRef.current = 'answer';
      result.current.streamingTextSegmentsRef.current = ['answer'];
      result.current.activeTextSegmentIndexRef.current = 0;
    });

    const blocks = result.current.buildStreamingBlocks([]);

    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'first' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('useStreamingMessages keeps stable backend blocks anchored before canonical text when they originally appear first', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'answer';
      result.current.streamingThinkingSegmentsRef.current = ['reasoning'];
    });

    const blocks = result.current.buildStreamingBlocks([
      { type: 'custom_block', value: 'before' },
      { type: 'text', text: 'stale intro' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
    ] as any);

    expect(blocks).toEqual([
      { type: 'custom_block', value: 'before' },
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
    ]);
  });

  it('useStreamingMessages keeps stable backend blocks anchored between rebuilt streaming blocks and trailing stable blocks', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'answer';
      result.current.streamingThinkingSegmentsRef.current = ['reasoning'];
    });

    const blocks = result.current.buildStreamingBlocks([
      { type: 'thinking', thinking: 'stale reasoning' },
      { type: 'custom_block', value: 'middle' },
      { type: 'text', text: 'stale answer' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
    ] as any);

    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
      { type: 'custom_block', value: 'middle' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
    ]);
  });

  it('useStreamingMessages patchAssistantForStreaming honors explicit canonical patch state', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'stale text';
      result.current.streamingThinkingSegmentsRef.current = ['stale thinking'];
    });

    const patched = result.current.patchAssistantForStreaming(
      {
        type: 'assistant',
        content: 'old',
        timestamp: new Date().toISOString(),
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'old thinking' },
              { type: 'text', text: 'old text' },
              { type: 'tool_use', id: 'tool-1', name: 'Read' },
            ],
          },
        } as any,
      },
      {
        canonicalText: 'fresh text',
        canonicalThinking: 'fresh thinking',
        existingBlocks: [
          { type: 'thinking', thinking: 'old thinking' },
          { type: 'text', text: 'old text' },
          { type: 'tool_use', id: 'tool-1', name: 'Read' },
        ],
      },
    );

    expect(patched.content).toBe('fresh text');
    expect((patched.raw as any)?.message?.content).toEqual([
      { type: 'thinking', thinking: 'fresh thinking' },
      { type: 'text', text: 'fresh text' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
    ]);
  });

  it('updateMessages upgrades canonical text when backend snapshot exceeds local streaming buffer', () => {
    const streamingContentRef = { current: 'abc' };
    const streamingTextSegmentsRef = { current: ['abc'] };
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 1 },
      streamingContentRef,
      streamingTextSegmentsRef,
      streamingThinkingSegmentsRef: { current: ['reasoning'] },
      activeThinkingSegmentIndexRef: { current: 0 },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, _canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        content: streamingContentRef.current,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'reasoning' },
              { type: 'text', text: streamingContentRef.current },
            ],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'abcdef',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'reasoning' },
              { type: 'text', text: 'abcdef' },
            ],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'abc',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'reasoning' },
              { type: 'text', text: 'abc' },
            ],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    expect(streamingContentRef.current).toBe('abcdef');
    expect(streamingTextSegmentsRef.current).toEqual(['abcdef']);
    expect(next[0].content).toBe('abcdef');
    expect((next[0].raw as any)?.message?.content).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'abcdef' },
    ]);
  });

  it('updateMessages upgrades canonical thinking when backend snapshot exceeds local thinking buffer', () => {
    const streamingContentRef = { current: 'answer' };
    const streamingThinkingSegmentsRef = { current: ['think'] };
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 1 },
      streamingContentRef,
      streamingTextSegmentsRef: { current: ['answer'] },
      activeTextSegmentIndexRef: { current: 0 },
      streamingThinkingSegmentsRef,
      activeThinkingSegmentIndexRef: { current: 0 },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: canonicalState?.canonicalThinking ?? streamingThinkingSegmentsRef.current[0] },
              { type: 'text', text: canonicalState?.canonicalText ?? streamingContentRef.current },
            ],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'answer',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'thinking expanded' },
              { type: 'text', text: 'answer' },
            ],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'answer',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'think' },
              { type: 'text', text: 'answer' },
            ],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    expect(streamingThinkingSegmentsRef.current).toEqual(['thinking expanded']);
    expect((next[0].raw as any)?.message?.content).toEqual([
      { type: 'thinking', thinking: 'thinking expanded' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('updateMessages stamps the active turn ID onto the backend assistant before preserving identity', () => {
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 42 },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        raw: {
          message: {
            content: canonicalState?.existingBlocks ?? (msg.raw as any)?.message?.content ?? [],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'backend content',
        timestamp: '2024-01-01T00:00:01.000Z',
        raw: {
          message: {
            content: [{ type: 'text', text: 'backend content' }],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'placeholder',
        timestamp: '2024-01-01T00:00:00.000Z',
        __turnId: 42,
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'placeholder' }],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    expect(next[0].__turnId).toBe(42);
    expect(next[0].timestamp).toBe('2024-01-01T00:00:00.000Z');
  });

  it('updateMessages keeps the streaming assistant after the latest user message during active streaming', () => {
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 9 },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage) => ({
        ...msg,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      { type: 'user', content: 'new question', timestamp: '2024-01-01T00:00:01.000Z' },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      { type: 'user', content: 'old question', timestamp: '2024-01-01T00:00:00.000Z' },
      {
        type: 'assistant',
        content: 'streaming answer',
        timestamp: '2024-01-01T00:00:00.500Z',
        __turnId: 9,
        isStreaming: true,
      },
    ];

    const next = updater(previous);
    expect(next).toHaveLength(2);
    expect(next[0].type).toBe('user');
    expect(next[0].content).toBe('new question');
    expect(next[1].type).toBe('assistant');
    expect(next[1].__turnId).toBe(9);
  });


  it('useStreamingMessages preserves all stable backend blocks in anchored original order', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'answer';
      result.current.streamingThinkingSegmentsRef.current = ['reasoning'];
    });

    const blocks = result.current.buildStreamingBlocks([
      { type: 'metadata', label: 'before-tool' },
      { type: 'text', text: 'stale intro' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'custom_block', value: 42 },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
    ] as any);

    expect(blocks).toEqual([
      { type: 'metadata', label: 'before-tool' },
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'custom_block', value: 42 },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
    ]);
  });

  it('updateMessages accepts structural assistant block changes even without tool_use blocks', async () => {
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 1 },
      streamingContentRef: { current: 'buffered answer' },
      streamingThinkingSegmentsRef: { current: ['reasoning'] },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, _canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        content: 'buffered answer',
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'reasoning' },
              { type: 'text', text: 'buffered answer' },
            ],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'backend',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'backend reasoning' },
              { type: 'text', text: 'backend' },
            ],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });
    await flushDeferredUpdateMessages();

    expect(opts.setMessages).toHaveBeenCalled();
    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'partial',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'partial' }],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    expect(next).toHaveLength(1);
    expect(next[0].content).toBe('buffered answer');
    expect((next[0].raw as any)?.message?.content).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'buffered answer' },
    ]);
  });

  it('updateMessages accepts same-length text block changes while streaming', async () => {
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingContentRef: { current: 'buffered answer' },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
    });
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'backend',
        timestamp: new Date().toISOString(),
        raw: {
          message: {
            content: [{ type: 'text', text: 'axc' }],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });
    await flushDeferredUpdateMessages();

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'partial',
        timestamp: new Date().toISOString(),
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'abc' }],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    expect(next).not.toBe(previous);
  });

  it('updateMessages preserves local streaming content when assistant blocks are otherwise unchanged', async () => {
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingContentRef: { current: 'buffered answer' },
    });
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'backend',
        timestamp: new Date().toISOString(),
        raw: {
          message: {
            content: [{ type: 'text', text: 'backend' }],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });
    await flushDeferredUpdateMessages();

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'partial',
        timestamp: new Date().toISOString(),
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'backend' }],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    expect(next).not.toBe(previous);
    expect(next).toHaveLength(1);
    expect(next[0].content).toBe('buffered answer');
    expect(next[0].isStreaming).toBe(true);
  });

  // ===== Interleaved block structure tests =====

  it('useStreamingMessages preserves interleaved block ordering', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'stale textanswer';
      result.current.streamingThinkingSegmentsRef.current = ['stale thinking 1reasoning'];
    });

    // Interleaved structure: [thinking, text, custom, thinking, tool_result]
    // The last thinking block should be updated with remaining canonical content
    const blocks = result.current.buildStreamingBlocks([
      { type: 'thinking', thinking: 'stale thinking 1' },
      { type: 'text', text: 'stale text' },
      { type: 'custom_block', value: 'middle' },
      { type: 'thinking', thinking: 'stale thinking 2' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
    ] as any);

    // Interleaved mode: preserves original block order, updates last thinking/text in-place
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'stale thinking 1' },
      { type: 'text', text: 'stale textanswer' },
      { type: 'custom_block', value: 'middle' },
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
    ]);
  });

  it('useStreamingMessages handles empty existing blocks array', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'text content';
      result.current.streamingThinkingSegmentsRef.current = ['thinking content'];
    });

    const blocks = result.current.buildStreamingBlocks([]);

    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'thinking content' },
      { type: 'text', text: 'text content' },
    ]);
  });

  it('useStreamingMessages preserves multi-turn interleaved block order from backend', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // Simulate accumulation across 2 turns: thinking1 + thinking2, text1 + text2
    act(() => {
      result.current.streamingContentRef.current = 'I will read the file.Here is the result:';
      result.current.streamingThinkingSegmentsRef.current = ['Let me check.Now let me summarize.'];
    });

    // Multi-turn backend snapshot: thinking → text → tool_use → tool_result → thinking → text
    const blocks = result.current.buildStreamingBlocks([
      { type: 'thinking', thinking: 'Let me check.' },
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
      { type: 'thinking', thinking: 'Now let me summarize.' },
      { type: 'text', text: 'Here is the result:' },
    ] as any);

    // Should preserve original interleaved order exactly
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'Let me check.' },
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
      { type: 'thinking', thinking: 'Now let me summarize.' },
      { type: 'text', text: 'Here is the result:' },
    ]);
  });

  it('useStreamingMessages extends last text block when streaming adds new content', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // Canonical text has MORE content than backend blocks (still streaming)
    act(() => {
      result.current.streamingContentRef.current = 'I will read the file.Here is the result: the code looks';
      result.current.streamingThinkingSegmentsRef.current = ['Let me check.Now summarizing.'];
    });

    const blocks = result.current.buildStreamingBlocks([
      { type: 'thinking', thinking: 'Let me check.' },
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
      { type: 'thinking', thinking: 'Now summarize.' },
      { type: 'text', text: 'Here is the result:' },
    ] as any);

    // Last text block extended with streaming content; last thinking block updated from canonical
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'Let me check.' },
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
      { type: 'thinking', thinking: 'Now summarizing.' },
      { type: 'text', text: 'Here is the result: the code looks' },
    ]);
  });

  it('useStreamingMessages handles existing blocks with only stable blocks', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'answer';
      result.current.streamingThinkingSegmentsRef.current = ['reasoning'];
    });

    // Only stable blocks, no streaming blocks - all stable blocks become prefix
    // because encounteredStreamingBlock never becomes true
    const blocks = result.current.buildStreamingBlocks([
      { type: 'metadata', label: 'start' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
    ] as any);

    // All stable blocks become prefix, canonical blocks appended at end
    expect(blocks).toEqual([
      { type: 'metadata', label: 'start' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('useStreamingMessages handles invalid/null blocks in existing blocks array', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'answer';
      result.current.streamingThinkingSegmentsRef.current = ['reasoning'];
    });

    // Contains null and invalid entries
    const blocks = result.current.buildStreamingBlocks([
      null,
      undefined,
      { type: 'thinking', thinking: 'stale' },
      null,
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      undefined,
    ] as any);

    // Should filter out null/undefined and rebuild canonical blocks
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
    ]);
  });

  it('does not append a second thinking segment into the earlier thinking block before the next thinking block is explicit', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'First answer';
      result.current.streamingThinkingSegmentsRef.current = ['First thinkingSecond thinking'];
    });

    const output = result.current.buildStreamingBlocks([
      { type: 'thinking', thinking: 'First thinking' },
      { type: 'text', text: 'First answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
    ] as any);

    expect(output).toEqual([
      { type: 'thinking', thinking: 'First thinking' },
      { type: 'text', text: 'First answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
      { type: 'thinking', thinking: 'Second thinking' },
    ]);
  });

  it('does not move newly streamed assistant text ahead of tool_use before a later text block is explicit', () => {
    const { result } = renderHook(() => useStreamingMessages());

    act(() => {
      result.current.streamingContentRef.current = 'First answerSecond answer';
      result.current.streamingThinkingSegmentsRef.current = ['First thinking'];
    });

    const output = result.current.buildStreamingBlocks([
      { type: 'thinking', thinking: 'First thinking' },
      { type: 'text', text: 'First answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
    ] as any);

    expect(output).toEqual([
      { type: 'thinking', thinking: 'First thinking' },
      { type: 'text', text: 'First answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
      { type: 'text', text: 'Second answer' },
    ]);
  });

  it('updateMessages keeps tool_use blocks ahead of later assistant text when backend has not emitted the second text block yet', async () => {
    const { result: streamingHook } = renderHook(() => useStreamingMessages());
    streamingHook.current.streamingContentRef.current = 'First answerSecond answer';
    streamingHook.current.streamingTextSegmentsRef.current = ['First answerSecond answer'];
    streamingHook.current.streamingThinkingSegmentsRef.current = ['First thinking'];

    const opts = createOptions({
      isStreamingRef: streamingHook.current.isStreamingRef,
      streamingTurnIdRef: streamingHook.current.streamingTurnIdRef,
      streamingMessageIndexRef: streamingHook.current.streamingMessageIndexRef,
      streamingContentRef: streamingHook.current.streamingContentRef,
      streamingTextSegmentsRef: streamingHook.current.streamingTextSegmentsRef,
      streamingThinkingSegmentsRef: streamingHook.current.streamingThinkingSegmentsRef,
      activeThinkingSegmentIndexRef: streamingHook.current.activeThinkingSegmentIndexRef,
      activeTextSegmentIndexRef: streamingHook.current.activeTextSegmentIndexRef,
      seenToolUseCountRef: streamingHook.current.seenToolUseCountRef,
      lastContentUpdateRef: streamingHook.current.lastContentUpdateRef,
      lastThinkingUpdateRef: streamingHook.current.lastThinkingUpdateRef,
      contentUpdateTimeoutRef: streamingHook.current.contentUpdateTimeoutRef,
      thinkingUpdateTimeoutRef: streamingHook.current.thinkingUpdateTimeoutRef,
      autoExpandedThinkingKeysRef: streamingHook.current.autoExpandedThinkingKeysRef,
      extractRawBlocks: streamingHook.current.extractRawBlocks,
      findStreamingAssistantIndex: streamingHook.current.findStreamingAssistantIndex,
      patchAssistantForStreaming: streamingHook.current.patchAssistantForStreaming,
      findLastAssistantIndex: streamingHook.current.findLastAssistantIndex,
    });
    opts.isStreamingRef.current = true;
    opts.streamingTurnIdRef.current = 1;
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'First answer',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'First thinking' },
              { type: 'text', text: 'First answer' },
              { type: 'tool_use', id: 'tool-1', name: 'Read' },
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
            ],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'First answer',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'First thinking' },
              { type: 'text', text: 'First answer' },
              { type: 'tool_use', id: 'tool-1', name: 'Read' },
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
            ],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    const blocks = (next[0].raw as any)?.message?.content as any[];
    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'First thinking' },
      { type: 'text', text: 'First answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
      { type: 'text', text: 'Second answer' },
    ]);
  });

  // ===== Order invariant tests (S1: guard against PR regressions) =====
  // These tests verify the core ordering contract: if block A appears before
  // block B in the input, then A must appear before B in the output (regardless
  // of block type or streaming mode). This invariant is the root cause of the
  // "blocks grouped by type" bug that frequently appears in PRs.

  const assertOrderPreserved = (
    input: Array<{ type: string; [key: string]: unknown }>,
    output: Array<{ type: string; [key: string]: unknown }>,
  ) => {
    // For each pair of blocks (i, j) where i < j in input,
    // verify that the same blocks appear with i before j in output.
    // Use type+id as identity key for stable blocks.
    const getKey = (b: Record<string, unknown>) => {
      if (b.type === 'tool_use') return `tool_use:${b.id}`;
      if (b.type === 'tool_result') return `tool_result:${b.tool_use_id}`;
      return `${b.type}:${b.id ?? b.thinking ?? b.text ?? ''}`;
    };
    const outputKeys = output.map(getKey);
    for (let i = 0; i < input.length; i += 1) {
      const keyI = getKey(input[i]);
      const idxI = outputKeys.indexOf(keyI);
      if (idxI < 0) continue; // block may have been merged/replaced
      for (let j = i + 1; j < input.length; j += 1) {
        const keyJ = getKey(input[j]);
        const idxJ = outputKeys.indexOf(keyJ);
        if (idxJ < 0) continue;
        expect(idxI).toBeLessThan(idxJ);
      }
    }
  };

  it('order invariant: interleaved thinking→text→tool→thinking→text preserves relative order', () => {
    const { result } = renderHook(() => useStreamingMessages());
    const input = [
      { type: 'thinking', thinking: 'Think 1' },
      { type: 'text', text: 'Text 1' },
      { type: 'tool_use', id: 't1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'thinking', thinking: 'Think 2' },
      { type: 'text', text: 'Text 2' },
    ] as any[];

    act(() => {
      result.current.streamingContentRef.current = 'Text 1Text 2 extended';
      result.current.streamingThinkingSegmentsRef.current = ['Think 1Think 2 extended'];
    });

    const output = result.current.buildStreamingBlocks(input);
    assertOrderPreserved(input, output);
  });

  it('order invariant: simple mode — stable prefix stays before canonical blocks', () => {
    const { result } = renderHook(() => useStreamingMessages());
    const input = [
      { type: 'tool_use', id: 't1', name: 'Read' },
      { type: 'tool_result', tool_use_id: 't1', content: 'data' },
      { type: 'thinking', thinking: 'old' },
      { type: 'text', text: 'old' },
    ] as any[];

    act(() => {
      result.current.streamingContentRef.current = 'new text';
      result.current.streamingThinkingSegmentsRef.current = ['new thinking'];
    });

    const output = result.current.buildStreamingBlocks(input);
    // tool_use and tool_result must remain before thinking and text
    const toolIdx = output.findIndex((b) => (b as Record<string, unknown>).type === 'tool_use');
    const thinkIdx = output.findIndex((b) => (b as Record<string, unknown>).type === 'thinking');
    expect(toolIdx).toBeLessThan(thinkIdx);
  });

  it('order invariant: triple-turn interleaved structure', () => {
    const { result } = renderHook(() => useStreamingMessages());
    const input = [
      { type: 'thinking', thinking: 'T1' },
      { type: 'text', text: 'X1' },
      { type: 'tool_use', id: 't1', name: 'A' },
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
      { type: 'thinking', thinking: 'T2' },
      { type: 'text', text: 'X2' },
      { type: 'tool_use', id: 't2', name: 'B' },
      { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
      { type: 'thinking', thinking: 'T3' },
      { type: 'text', text: 'X3' },
    ] as any[];

    act(() => {
      result.current.streamingContentRef.current = 'X1X2X3 streaming';
      result.current.streamingThinkingSegmentsRef.current = ['T1T2T3 streaming'];
    });

    const output = result.current.buildStreamingBlocks(input);
    assertOrderPreserved(input, output);
    expect(output).toHaveLength(10);
  });

  // ===== Original tests =====

  it('stream end flushes throttled streaming refs into assistant raw blocks', () => {
    const setMessages = vi.fn();
    const opts = createOptions({
      setMessages,
      isStreamingRef: { current: true },
      streamingContentRef: { current: 'final answer' },
      streamingTextSegmentsRef: { current: ['final answer'] },
      activeTextSegmentIndexRef: { current: 0 },
      streamingThinkingSegmentsRef: { current: ['final reasoning'] },
      activeThinkingSegmentIndexRef: { current: 0 },
      streamingMessageIndexRef: { current: 0 },
      patchAssistantForStreaming: (msg: ClaudeMessage, _canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'final reasoning' },
              { type: 'text', text: 'final answer' },
            ],
          },
        } as any,
        content: 'final answer',
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      (window as any).onStreamEnd();
    });

    const updater = (setMessages as any).mock.calls[0][0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'partial',
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'partial' }],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    expect(next[0].isStreaming).toBe(false);
    expect(next[0].content).toBe('final answer');
    expect((next[0].raw as any).message.content).toEqual([
      { type: 'thinking', thinking: 'final reasoning' },
      { type: 'text', text: 'final answer' },
    ]);
  });

  // ===== Full failure scenario: load history fails, guard is released, new messages work =====

  it('full flow: history load failure releases guard so new messages can arrive', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    // Step 1: Frontend begins session transition
    (window as any).__sessionTransitioning = true;

    // Step 2: During transition, stale messages are blocked
    act(() => {
      (window as any).updateMessages(JSON.stringify([{ type: 'assistant', content: 'stale' }]));
    });
    expect(opts.setMessages).not.toHaveBeenCalled();

    // Step 3: Java calls historyLoadComplete (failure path also calls this before addErrorMessage)
    act(() => {
      (window as any).historyLoadComplete();
    });
    expect((window as any).__sessionTransitioning).toBe(false);

    // Step 4: Java calls addErrorMessage
    act(() => {
      (window as any).addErrorMessage('Failed to load session: network error');
    });
    expect(opts.addToast).toHaveBeenCalledWith('Failed to load session: network error', 'error');

    // Step 5: After guard release, new messages work
    act(() => {
      (window as any).updateMessages(
        JSON.stringify([{ type: 'user', content: 'new message' }])
      );
    });
    expect(opts.setMessages).toHaveBeenCalled();
  });

  // ===== Boundary case tests for code review fixes =====

  it('getContentHash detects changes in long thinking content suffix', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // Create a long thinking content (>100 chars)
    const longThinking = 'This is a very long thinking content that exceeds one hundred characters limit and the important change happens at the very end of this string: IMPORTANT_SUFFIX';

    act(() => {
      result.current.streamingThinkingSegmentsRef.current = [longThinking];
    });

    // Build blocks - should include the full thinking content
    const blocks = result.current.buildStreamingBlocks([]);
    expect(blocks).toEqual([
      { type: 'thinking', thinking: longThinking },
    ]);

    // Now test with a different suffix - should still be detected
    const differentSuffixThinking = longThinking.slice(0, -20) + 'DIFFERENT_SUFFIX';
    act(() => {
      result.current.streamingThinkingSegmentsRef.current = [differentSuffixThinking];
    });

    const blocksWithDifferentSuffix = result.current.buildStreamingBlocks([]);
    expect(blocksWithDifferentSuffix).toEqual([
      { type: 'thinking', thinking: differentSuffixThinking },
    ]);
  });

  it('chooseMoreCompleteStreamingValue keeps current for whitespace-only differences', () => {
    // This test verifies the fix for Issue 1: whitespace-only same-length changes
    // should not cause unnecessary visual flicker
    const streamingContentRef = { current: "hello\tworld" };
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 1 },
      streamingContentRef,
      streamingTextSegmentsRef: { current: ["hello\tworld"] },
      streamingThinkingSegmentsRef: { current: [] },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        content: canonicalState?.canonicalText ?? streamingContentRef.current,
        raw: {
          message: {
            content: [{ type: 'text', text: canonicalState?.canonicalText ?? streamingContentRef.current }],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    // Backend sends same-length but whitespace-only difference (space vs tab, both 11 chars)
    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'hello world', // Same length as "hello\tworld", whitespace-only difference
        timestamp: new Date().toISOString(),
        __turnId: 1,
        raw: {
          message: {
            content: [{ type: 'text', text: 'hello world' }],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: "hello\tworld",
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: "hello\tworld" }],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    // Should keep current content since whitespace-only difference is not meaningful
    expect(streamingContentRef.current).toBe("hello\tworld");
    expect(next[0].content).toBe("hello\tworld");
  });

  it('chooseMoreCompleteStreamingValue switches for meaningful same-length changes', () => {
    // This test verifies that typo fixes are still applied
    const streamingContentRef = { current: 'abc' };
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 1 },
      streamingContentRef,
      streamingTextSegmentsRef: { current: ['abc'] },
      streamingThinkingSegmentsRef: { current: [] },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        content: canonicalState?.canonicalText ?? streamingContentRef.current,
        raw: {
          message: {
            content: [{ type: 'text', text: canonicalState?.canonicalText ?? streamingContentRef.current }],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    // Backend sends typo fix - same length, meaningful content change
    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'axc', // Typo fix: same length but different character
        timestamp: new Date().toISOString(),
        __turnId: 1,
        raw: {
          message: {
            content: [{ type: 'text', text: 'xyz' }], // Backend has even better content
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'abc',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'abc' }],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    // Should upgrade to backend's longer content (xyz > abc)
    expect(streamingContentRef.current).toBe('xyz');
    expect(next[0].content).toBe('xyz');
  });

  it('updateMessages handles empty backend snapshot during streaming', () => {
    // Test for boundary case: empty array from backend
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 1 },
      streamingContentRef: { current: 'streaming content' },
      streamingTextSegmentsRef: { current: ['streaming content'] },
      streamingThinkingSegmentsRef: { current: ['thinking'] },
      streamingMessageIndexRef: { current: 0 },
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      (window as any).updateMessages(JSON.stringify([]));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'streaming content',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [
              { type: 'thinking', thinking: 'thinking' },
              { type: 'text', text: 'streaming content' },
            ],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    // Should preserve the streaming assistant message
    expect(next.length).toBeGreaterThanOrEqual(1);
    expect(next[0].type).toBe('assistant');
  });

  it('selectMostCompleteStreamingText chooses longest from multiple sources', () => {
    // Test for Issue 4: clear priority-based selection
    const streamingContentRef = { current: 'short' };
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 1 },
      streamingContentRef,
      streamingTextSegmentsRef: { current: ['short'] },
      streamingThinkingSegmentsRef: { current: [] },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        content: canonicalState?.canonicalText ?? streamingContentRef.current,
        raw: {
          message: {
            content: [{ type: 'text', text: canonicalState?.canonicalText ?? streamingContentRef.current }],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    // Backend has the longest content, assistant.content has medium
    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'medium length content', // Medium: 20 chars
        timestamp: new Date().toISOString(),
        __turnId: 1,
        raw: {
          message: {
            content: [{ type: 'text', text: 'this is the longest backend content' }], // Longest: 36 chars
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    // Previous state has OLD content (short), not the new backend content
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'short',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'short' }],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    // Should select the longest content from backend (trimmed content differs)
    expect(streamingContentRef.current).toBe('this is the longest backend content');
    expect(next[0].content).toBe('this is the longest backend content');
  });

  it('updateMessages detects structural change in legacy thinking blocks with text field', () => {
    // Regression test: backend sends { type: 'thinking', text: '...' } (legacy format)
    // instead of { type: 'thinking', thinking: '...' }. getStructuralBlockSignature must
    // fall back to block.text so hasStructuralBlockChange returns true.
    const streamingContentRef = { current: 'answer' };
    const streamingThinkingSegmentsRef = { current: ['old reasoning'] };
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 1 },
      streamingContentRef,
      streamingTextSegmentsRef: { current: ['answer'] },
      activeTextSegmentIndexRef: { current: 0 },
      streamingThinkingSegmentsRef,
      activeThinkingSegmentIndexRef: { current: 0 },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        content: canonicalState?.canonicalText ?? streamingContentRef.current,
        raw: {
          message: {
            content: [
              { type: 'thinking', text: canonicalState?.canonicalThinking ?? streamingThinkingSegmentsRef.current[0] },
              { type: 'text', text: canonicalState?.canonicalText ?? streamingContentRef.current },
            ],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    // Backend sends legacy-format thinking block with updated content
    const incoming: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'answer',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        raw: {
          message: {
            content: [
              { type: 'thinking', text: 'updated reasoning via legacy format' },
              { type: 'text', text: 'answer' },
            ],
          },
        } as any,
      },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'answer',
        timestamp: new Date().toISOString(),
        __turnId: 1,
        isStreaming: true,
        raw: {
          message: {
            content: [
              { type: 'thinking', text: 'old reasoning' },
              { type: 'text', text: 'answer' },
            ],
          },
        } as any,
      },
    ];

    const next = updater(previous);
    // Should NOT return prev (meaning the structural change was detected)
    expect(next).not.toBe(previous);
    // The thinking content should be upgraded to the longer legacy-format value
    expect(streamingThinkingSegmentsRef.current).toEqual(['updated reasoning via legacy format']);
  });

  it('onStreamEnd early-clear blocks late delta callbacks', () => {
    // Test for Issue 5: safety strategy for refs clearing
    const streamingContentRef = { current: 'content before end' };
    const isStreamingRef = { current: true };
    const setMessages = vi.fn();
    const opts = createOptions({
      setMessages,
      isStreamingRef,
      streamingContentRef,
      streamingTextSegmentsRef: { current: ['content before end'] },
      streamingThinkingSegmentsRef: { current: [] },
      streamingMessageIndexRef: { current: 0 },
      patchAssistantForStreaming: (msg: ClaudeMessage, _canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        content: streamingContentRef.current,
        raw: {
          message: {
            content: [{ type: 'text', text: streamingContentRef.current }],
          },
        } as any,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    // Call onStreamEnd
    act(() => {
      (window as any).onStreamEnd();
    });

    // Verify isStreamingRef was set to false early (before setMessages updater runs)
    expect(isStreamingRef.current).toBe(false);

    // The setMessages updater should have been called
    expect(setMessages).toHaveBeenCalled();
    const updater = setMessages.mock.calls[0][0] as (messages: ClaudeMessage[]) => ClaudeMessage[];

    // Run the updater to simulate React processing it
    const previous: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'content before end',
        timestamp: new Date().toISOString(),
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'content before end' }],
          },
        } as any,
      },
    ];
    updater(previous);

    // Now refs should be cleared
    expect(streamingContentRef.current).toBe('');

    // Try to send a late delta - should be blocked because isStreamingRef is false
    const contentBeforeDelta = streamingContentRef.current;
    act(() => {
      (window as any).onContentDelta(' late content');
    });

    // Content should not have changed because delta was blocked
    expect(streamingContentRef.current).toBe(contentBeforeDelta);
  });

  // ===== Full interleaving integration test (Decision 30 — post-review) =====

  it('preserves user-before-assistant order when updateMessages restores the current user before streaming assistant recovery', () => {
    const opts = createOptions({
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 2 },
      streamingMessageIndexRef: { current: 1 },
      streamingContentRef: { current: 'partial answer' },
      streamingTextSegmentsRef: { current: ['partial answer'] },
      streamingThinkingSegmentsRef: { current: [] },
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
      patchAssistantForStreaming: (msg: ClaudeMessage, canonicalState?: { canonicalText?: string; canonicalThinking?: string; existingBlocks?: any[] }) => ({
        ...msg,
        content: canonicalState?.canonicalText ?? msg.content,
        isStreaming: true,
      }),
    });
    renderHook(() => useWindowCallbacks(opts));

    const incoming: ClaudeMessage[] = [
      { type: 'user', content: 'previous user', timestamp: '2024-01-01T00:00:00.000Z' },
      { type: 'assistant', content: 'previous assistant', timestamp: '2024-01-01T00:00:01.000Z' },
      { type: 'user', content: 'current user', timestamp: '2024-01-01T00:00:02.000Z' },
    ];

    act(() => {
      (window as any).updateMessages(JSON.stringify(incoming));
    });

    const updater = (opts.setMessages as any).mock.calls.at(-1)[0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      { type: 'user', content: 'previous user', timestamp: '2024-01-01T00:00:00.000Z' },
      { type: 'assistant', content: 'previous assistant', timestamp: '2024-01-01T00:00:01.000Z' },
      { type: 'assistant', content: 'partial answer', timestamp: '2024-01-01T00:00:03.000Z', __turnId: 2, isStreaming: true },
    ];

    const next = updater(previous);
    expect(next.map((message) => message.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(next[2].content).toBe('current user');
    expect(next[3].__turnId).toBe(2);
  });

  it('keeps the latest user ahead of a new streaming placeholder when addUserMessage follows onStreamStart', () => {
    let messages: ClaudeMessage[] = [];
    const setMessages = vi.fn((updater: unknown) => {
      messages = typeof updater === 'function'
        ? (updater as (prev: ClaudeMessage[]) => ClaudeMessage[])(messages)
        : updater as ClaudeMessage[];
    });

    const { result: streamingHook } = renderHook(() => useStreamingMessages());
    const opts = createOptions({
      setMessages,
      streamingContentRef: streamingHook.current.streamingContentRef,
      streamingThinkingSegmentsRef: streamingHook.current.streamingThinkingSegmentsRef,
      streamingTextSegmentsRef: streamingHook.current.streamingTextSegmentsRef,
      activeThinkingSegmentIndexRef: streamingHook.current.activeThinkingSegmentIndexRef,
      activeTextSegmentIndexRef: streamingHook.current.activeTextSegmentIndexRef,
      isStreamingRef: streamingHook.current.isStreamingRef,
      streamingTurnIdRef: streamingHook.current.streamingTurnIdRef,
      turnIdCounterRef: streamingHook.current.turnIdCounterRef,
      seenToolUseCountRef: streamingHook.current.seenToolUseCountRef,
      streamingMessageIndexRef: streamingHook.current.streamingMessageIndexRef,
      lastContentUpdateRef: streamingHook.current.lastContentUpdateRef,
      lastThinkingUpdateRef: streamingHook.current.lastThinkingUpdateRef,
      contentUpdateTimeoutRef: streamingHook.current.contentUpdateTimeoutRef,
      thinkingUpdateTimeoutRef: streamingHook.current.thinkingUpdateTimeoutRef,
      autoExpandedThinkingKeysRef: streamingHook.current.autoExpandedThinkingKeysRef,
      extractRawBlocks: streamingHook.current.extractRawBlocks,
      findStreamingAssistantIndex: streamingHook.current.findStreamingAssistantIndex,
      patchAssistantForStreaming: streamingHook.current.patchAssistantForStreaming,
      findLastAssistantIndex: streamingHook.current.findLastAssistantIndex,
    });
    renderHook(() => useWindowCallbacks(opts));

    messages = [
      { type: 'user', content: 'previous user', timestamp: '2024-01-01T00:00:00.000Z' },
      { type: 'assistant', content: 'previous assistant', timestamp: '2024-01-01T00:00:01.000Z' },
    ];

    act(() => { (window as any).onStreamStart(); });
    act(() => { (window as any).addUserMessage('current user'); });

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2].content).toBe('current user');
    expect(messages[3].type).toBe('assistant');
    expect(messages[3].__turnId).toBe(1);
  });

  it('content delta fallback never patches an older assistant when the current turn placeholder is temporarily missing', () => {
    let messages: ClaudeMessage[] = [
      { type: 'assistant', content: 'old assistant', timestamp: '2024-01-01T00:00:00.000Z', __turnId: 1 },
    ];
    const setMessages = vi.fn((updater: unknown) => {
      messages = typeof updater === 'function'
        ? (updater as (prev: ClaudeMessage[]) => ClaudeMessage[])(messages)
        : updater as ClaudeMessage[];
    });

    const { result: streamingHook } = renderHook(() => useStreamingMessages());
    const opts = createOptions({
      setMessages,
      streamingContentRef: streamingHook.current.streamingContentRef,
      streamingThinkingSegmentsRef: streamingHook.current.streamingThinkingSegmentsRef,
      streamingTextSegmentsRef: streamingHook.current.streamingTextSegmentsRef,
      activeThinkingSegmentIndexRef: streamingHook.current.activeThinkingSegmentIndexRef,
      activeTextSegmentIndexRef: streamingHook.current.activeTextSegmentIndexRef,
      isStreamingRef: streamingHook.current.isStreamingRef,
      streamingTurnIdRef: streamingHook.current.streamingTurnIdRef,
      turnIdCounterRef: streamingHook.current.turnIdCounterRef,
      seenToolUseCountRef: streamingHook.current.seenToolUseCountRef,
      streamingMessageIndexRef: streamingHook.current.streamingMessageIndexRef,
      lastContentUpdateRef: streamingHook.current.lastContentUpdateRef,
      lastThinkingUpdateRef: streamingHook.current.lastThinkingUpdateRef,
      contentUpdateTimeoutRef: streamingHook.current.contentUpdateTimeoutRef,
      thinkingUpdateTimeoutRef: streamingHook.current.thinkingUpdateTimeoutRef,
      autoExpandedThinkingKeysRef: streamingHook.current.autoExpandedThinkingKeysRef,
      extractRawBlocks: streamingHook.current.extractRawBlocks,
      findStreamingAssistantIndex: streamingHook.current.findStreamingAssistantIndex,
      patchAssistantForStreaming: streamingHook.current.patchAssistantForStreaming,
      findLastAssistantIndex: streamingHook.current.findLastAssistantIndex,
    });
    renderHook(() => useWindowCallbacks(opts));

    opts.isStreamingRef.current = true;
    opts.streamingTurnIdRef.current = 2;
    opts.streamingMessageIndexRef.current = -1;

    act(() => {
      opts.streamingContentRef.current = 'current turn answer';
      (window as any).onContentDelta('!');
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('old assistant');
    expect(messages[0].__turnId).toBe(1);
  });

  it('content delta fallback never patches an older assistant when the current turn placeholder is temporarily missing', () => {
    let messages: ClaudeMessage[] = [
      { type: 'assistant', content: 'old assistant', timestamp: '2024-01-01T00:00:00.000Z', __turnId: 1 },
    ];
    const setMessages = vi.fn((updater: unknown) => {
      messages = typeof updater === 'function'
        ? (updater as (prev: ClaudeMessage[]) => ClaudeMessage[])(messages)
        : updater as ClaudeMessage[];
    });

    const { result: streamingHook } = renderHook(() => useStreamingMessages());
    const opts = createOptions({
      setMessages,
      streamingContentRef: streamingHook.current.streamingContentRef,
      streamingThinkingSegmentsRef: streamingHook.current.streamingThinkingSegmentsRef,
      streamingTextSegmentsRef: streamingHook.current.streamingTextSegmentsRef,
      activeThinkingSegmentIndexRef: streamingHook.current.activeThinkingSegmentIndexRef,
      activeTextSegmentIndexRef: streamingHook.current.activeTextSegmentIndexRef,
      isStreamingRef: streamingHook.current.isStreamingRef,
      streamingTurnIdRef: streamingHook.current.streamingTurnIdRef,
      turnIdCounterRef: streamingHook.current.turnIdCounterRef,
      seenToolUseCountRef: streamingHook.current.seenToolUseCountRef,
      streamingMessageIndexRef: streamingHook.current.streamingMessageIndexRef,
      lastContentUpdateRef: streamingHook.current.lastContentUpdateRef,
      lastThinkingUpdateRef: streamingHook.current.lastThinkingUpdateRef,
      contentUpdateTimeoutRef: streamingHook.current.contentUpdateTimeoutRef,
      thinkingUpdateTimeoutRef: streamingHook.current.thinkingUpdateTimeoutRef,
      autoExpandedThinkingKeysRef: streamingHook.current.autoExpandedThinkingKeysRef,
      extractRawBlocks: streamingHook.current.extractRawBlocks,
      findStreamingAssistantIndex: streamingHook.current.findStreamingAssistantIndex,
      patchAssistantForStreaming: streamingHook.current.patchAssistantForStreaming,
      findLastAssistantIndex: streamingHook.current.findLastAssistantIndex,
    });
    renderHook(() => useWindowCallbacks(opts));

    opts.isStreamingRef.current = true;
    opts.streamingTurnIdRef.current = 2;
    opts.streamingMessageIndexRef.current = -1;
    opts.streamingContentRef.current = 'current turn answer';

    act(() => {
      (window as any).onContentDelta('!');
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('old assistant');
    expect(messages[0].__turnId).toBe(1);
  });

  it('preserves content integrity when thinking_delta, content_delta, and updateMessages interleave', () => {
    vi.useFakeTimers();

    // Use real useStreamingMessages hook for authentic refs + functions
    const { result: streamingHook } = renderHook(() => useStreamingMessages());

    let messages: ClaudeMessage[] = [];
    const setMessages = vi.fn((updater: unknown) => {
      if (typeof updater === 'function') {
        messages = (updater as (prev: ClaudeMessage[]) => ClaudeMessage[])(messages);
      } else {
        messages = updater as ClaudeMessage[];
      }
    });

    const opts = createOptions({
      setMessages,
      // Wire all refs + functions from the real hook
      streamingContentRef: streamingHook.current.streamingContentRef,
      streamingThinkingSegmentsRef: streamingHook.current.streamingThinkingSegmentsRef,
      streamingTextSegmentsRef: streamingHook.current.streamingTextSegmentsRef,
      activeThinkingSegmentIndexRef: streamingHook.current.activeThinkingSegmentIndexRef,
      activeTextSegmentIndexRef: streamingHook.current.activeTextSegmentIndexRef,
      isStreamingRef: streamingHook.current.isStreamingRef,
      streamingTurnIdRef: streamingHook.current.streamingTurnIdRef,
      turnIdCounterRef: streamingHook.current.turnIdCounterRef,
      seenToolUseCountRef: streamingHook.current.seenToolUseCountRef,
      streamingMessageIndexRef: streamingHook.current.streamingMessageIndexRef,
      lastContentUpdateRef: streamingHook.current.lastContentUpdateRef,
      lastThinkingUpdateRef: streamingHook.current.lastThinkingUpdateRef,
      contentUpdateTimeoutRef: streamingHook.current.contentUpdateTimeoutRef,
      thinkingUpdateTimeoutRef: streamingHook.current.thinkingUpdateTimeoutRef,
      autoExpandedThinkingKeysRef: streamingHook.current.autoExpandedThinkingKeysRef,
      extractRawBlocks: streamingHook.current.extractRawBlocks,
      findStreamingAssistantIndex: streamingHook.current.findStreamingAssistantIndex,
      patchAssistantForStreaming: streamingHook.current.patchAssistantForStreaming,
      findLastAssistantIndex: streamingHook.current.findLastAssistantIndex,
    });
    renderHook(() => useWindowCallbacks(opts));

    // 1. Start stream
    act(() => { (window as any).onStreamStart(); });

    // 2. First thinking delta
    act(() => { (window as any).onThinkingDelta('think part 1'); });
    vi.advanceTimersByTime(60);

    // 3. First content delta
    act(() => { (window as any).onContentDelta('text part 1'); });
    vi.advanceTimersByTime(60);

    // 4. Stale updateMessages snapshot (shorter content than local buffers)
    const staleSnapshot: ClaudeMessage[] = [{
      type: 'assistant',
      content: 'text',
      timestamp: new Date().toISOString(),
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'think' },
            { type: 'text', text: 'text' },
          ],
        },
      } as any,
    }];
    act(() => { (window as any).updateMessages(JSON.stringify(staleSnapshot)); });

    // 5. More thinking arrives after stale snapshot
    act(() => { (window as any).onThinkingDelta(' think part 2'); });
    vi.advanceTimersByTime(60);

    // 6. End stream
    act(() => { (window as any).onStreamEnd(); });

    // Verify: content must not have been lost to the stale snapshot
    const lastAssistantIdx = messages.findIndex((m) => m.type === 'assistant');
    expect(lastAssistantIdx).toBeGreaterThanOrEqual(0);
    const assistant = messages[lastAssistantIdx];

    expect(assistant.content).toBe('text part 1');
    expect(assistant.isStreaming).toBe(false);

    const blocks = (assistant.raw as any)?.message?.content as any[];
    const thinkingBlock = blocks?.find((b: any) => b.type === 'thinking');
    const textBlock = blocks?.find((b: any) => b.type === 'text');

    expect(thinkingBlock?.thinking).toBe('think part 1 think part 2');
    expect(textBlock?.text).toBe('text part 1');

    vi.useRealTimers();
  });
});

