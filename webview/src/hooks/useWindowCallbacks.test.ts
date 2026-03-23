import { act, renderHook } from '@testing-library/react';
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
    useBackendStreamingRenderRef: { current: false },
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
    getOrCreateStreamingAssistantIndex: () => 0,
    patchAssistantForStreaming: (msg: ClaudeMessage) => msg,
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

  // ===== B-034: streaming placeholder preserved during tool_use updates =====

  it('B-034: does not stamp __turnId on old assistant when streaming placeholder exists', () => {
    const streamingMessageIndexRef = { current: 3 };
    const streamingTurnIdRef = { current: 2 };
    const isStreamingRef = { current: true };
    const seenToolUseCountRef = { current: 0 };

    // extractRawBlocks returns a tool_use block so the tool_use path is entered
    const extractRawBlocks = (raw: any) =>
      raw?.content ?? [];

    // patchAssistantForStreaming stamps the message so we can detect it
    const patchAssistantForStreaming = (msg: ClaudeMessage) => ({
      ...msg,
      __patched: true,
    });

    const opts = createOptions({
      streamingMessageIndexRef,
      streamingTurnIdRef,
      isStreamingRef,
      seenToolUseCountRef,
      extractRawBlocks: extractRawBlocks as any,
      patchAssistantForStreaming: patchAssistantForStreaming as any,
    });

    renderHook(() => useWindowCallbacks(opts));

    // Previous state: [user1, assistant1(old), user2, assistant2(streaming, __turnId=2)]
    const prevMessages: ClaudeMessage[] = [
      { type: 'user', content: 'hello', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'assistant', content: 'hi', timestamp: '2024-01-01T00:00:01Z',
        raw: { content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: {} }] } },
      { type: 'user', content: 'do something', timestamp: '2024-01-01T00:00:02Z' },
      { type: 'assistant', content: '', timestamp: '2024-01-01T00:00:03Z',
        __turnId: 2, isStreaming: true },
    ];

    // Backend sends update with only the old assistant (tool_use result arrived),
    // no new assistant placeholder yet — simulates the race condition.
    const backendUpdate: ClaudeMessage[] = [
      { type: 'user', content: 'hello', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'assistant', content: 'hi', timestamp: '2024-01-01T00:00:01Z',
        raw: { content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: {} }] } },
      { type: 'user', content: 'do something', timestamp: '2024-01-01T00:00:02Z' },
    ];

    // Trigger the update — need a new tool_use to enter the patching path
    seenToolUseCountRef.current = 0;

    act(() => {
      (window as any).updateMessages(JSON.stringify(backendUpdate));
    });

    // setMessages should have been called with an updater function
    expect(opts.setMessages).toHaveBeenCalled();
    const updater = (opts.setMessages as any).mock.calls[0][0];
    expect(typeof updater).toBe('function');

    // Execute the updater with the previous state
    const result = updater(prevMessages);

    // The old assistant (index 1) should NOT have been stamped with __turnId=2
    // because the streaming placeholder already exists at a different index
    const oldAssistant = result.find(
      (m: any) => m.type === 'assistant' && m.content === 'hi',
    );
    expect(oldAssistant?.__turnId).not.toBe(2);

    // streamingMessageIndexRef should NOT have been changed to the old assistant's index
    // (it should remain at 3 or be updated by ensureStreamingAssistantPreserved, not set to 1)
    expect(streamingMessageIndexRef.current).not.toBe(1);
  });
});
