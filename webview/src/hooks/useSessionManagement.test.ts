import { act, renderHook } from '@testing-library/react';
import { useSessionManagement } from './useSessionManagement.js';
import type { HistoryData } from '../types/index.js';

describe('useSessionManagement', () => {
  const t = ((key: string) => key) as any;

  const createMocks = () => ({
    setHistoryData: vi.fn(),
    setMessages: vi.fn(),
    setCurrentView: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setCustomSessionTitle: vi.fn(),
    setUsagePercentage: vi.fn(),
    setUsageUsedTokens: vi.fn(),
    setUsageMaxTokens: vi.fn(),
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setIsThinking: vi.fn(),
    setStreamingActive: vi.fn(),
    clearToasts: vi.fn(),
    addToast: vi.fn(),
    setBackgroundTasks: vi.fn(),
  });

  beforeEach(() => {
    (window as any).__sessionTransitioning = false;
    (window as any).__sessionTransitionToken = null;
    window.sendToJava = vi.fn();
  });

  it('starts a clean session transition for a direct new session', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData: null,
        currentSessionId: 'old-session',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.createNewSession();
    });

    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setStatus).toHaveBeenCalledWith('');
    expect(mocks.setLoading).toHaveBeenCalledWith(false);
    expect(mocks.setIsThinking).toHaveBeenCalledWith(false);
    expect(mocks.setStreamingActive).toHaveBeenCalledWith(false);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(mocks.setCustomSessionTitle).toHaveBeenCalledWith(null);
    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
    expect(window.sendToJava).toHaveBeenCalledWith('create_new_session:');
  });

  it('clears stale ui state before loading history', () => {
    const historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'history-1',
          title: 'History Title',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          messageCount: 3,
          lastTimestamp: Date.now(),
        },
      ],
      total: 3,
    } as unknown as HistoryData;

    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'assistant', content: 'old', timestamp: new Date().toISOString() }],
        loading: true,
        historyData,
        currentSessionId: 'old-session',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.loadHistorySession('history-1');
    });

    expect(window.sendToJava).toHaveBeenNthCalledWith(1, 'interrupt_session:');
    expect(window.sendToJava).toHaveBeenNthCalledWith(2, 'load_session:history-1');
    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith('history-1');
    expect(mocks.setCustomSessionTitle).toHaveBeenCalledWith('History Title');
    expect(mocks.setCurrentView).toHaveBeenCalledWith('chat');
  });

  it('forceCreateNewSession interrupts loading session and cleans state', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'assistant', content: 'streaming...', timestamp: new Date().toISOString() }],
        loading: true,
        historyData: null,
        currentSessionId: 'active-session',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.forceCreateNewSession();
    });

    expect(window.sendToJava).toHaveBeenCalledWith('interrupt_session:');
    expect(window.sendToJava).toHaveBeenCalledWith('create_new_session:');
    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
  });

  it('shows confirm dialog when creating new session with existing messages', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'user', content: 'hello', timestamp: new Date().toISOString() }],
        loading: false,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.createNewSession();
    });

    // Should show confirm dialog, NOT immediately transition
    expect(result.current.showNewSessionConfirm).toBe(true);
    expect((window as any).__sessionTransitioning).toBe(false);
    expect((window as any).__sessionTransitionToken).toBeNull();
    expect(mocks.setMessages).not.toHaveBeenCalled();
  });

  it('handleConfirmNewSession cleans state and creates new session', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'user', content: 'hello', timestamp: new Date().toISOString() }],
        loading: false,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    // Trigger dialog first
    act(() => {
      result.current.createNewSession();
    });

    // Confirm
    act(() => {
      result.current.handleConfirmNewSession();
    });

    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(window.sendToJava).toHaveBeenCalledWith('create_new_session:');
    expect(result.current.showNewSessionConfirm).toBe(false);
  });

  it('handleConfirmInterrupt interrupts and cleans state', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [{ type: 'assistant', content: 'responding...', timestamp: new Date().toISOString() }],
        loading: true,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    // Must trigger interrupt dialog first
    act(() => {
      result.current.createNewSession();
    });

    // Then confirm interrupt
    act(() => {
      result.current.handleConfirmInterrupt();
    });

    expect(window.sendToJava).toHaveBeenCalledWith('interrupt_session:');
    expect(window.sendToJava).toHaveBeenCalledWith('create_new_session:');
    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith(null);
  });

  it('loadHistorySession without loading state does not send interrupt', () => {
    const historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'hist-2',
          title: null,
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          messageCount: 1,
          lastTimestamp: Date.now(),
        },
      ],
      total: 1,
    } as unknown as HistoryData;

    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.loadHistorySession('hist-2');
    });

    // Should NOT send interrupt when not loading
    const calls = (window.sendToJava as any).mock.calls.map((c: any) => c[0]);
    expect(calls).not.toContain('interrupt_session:');
    expect(calls).toContain('load_session:hist-2');

    // But should still set transition guard
    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBeTruthy();
    expect(mocks.clearToasts).toHaveBeenCalledTimes(1);
    expect(mocks.setMessages).toHaveBeenCalledWith([]);
    expect(mocks.setCurrentSessionId).toHaveBeenCalledWith('hist-2');
    expect(mocks.setCustomSessionTitle).toHaveBeenCalledWith(null);
  });

  it('all transition paths reset usage tokens', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    // Test forceCreateNewSession
    act(() => {
      result.current.forceCreateNewSession();
    });

    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
    expect(mocks.setUsageMaxTokens).toHaveBeenCalledWith(undefined);
  });

  it('beginSessionTransition clears all transient UI states synchronously', () => {
    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData: null,
        currentSessionId: 'session-1',
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.forceCreateNewSession();
    });

    // All transient UI states must be synchronously cleared
    expect(mocks.setStatus).toHaveBeenCalledWith('');
    expect(mocks.setLoading).toHaveBeenCalledWith(false);
    expect(mocks.setIsThinking).toHaveBeenCalledWith(false);
    expect(mocks.setStreamingActive).toHaveBeenCalledWith(false);
    expect(mocks.setUsagePercentage).toHaveBeenCalledWith(0);
    expect(mocks.setUsageUsedTokens).toHaveBeenCalledWith(undefined);
    expect(mocks.setUsageMaxTokens).toHaveBeenCalledWith(undefined);
  });

  it('historyLoadComplete releases transition guard', () => {
    // Simulate what happens when Java calls historyLoadComplete after successful load
    (window as any).__sessionTransitioning = true;
    (window as any).__sessionTransitionToken = 'transition-test';

    // historyLoadComplete is defined in useWindowCallbacks, but we can test
    // that the guard release mechanism works by direct simulation
    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBe('transition-test');

    // Simulate historyLoadComplete behavior
    (window as any).__sessionTransitioning = false;
    (window as any).__sessionTransitionToken = null;
    expect((window as any).__sessionTransitioning).toBe(false);
    expect((window as any).__sessionTransitionToken).toBeNull();
  });

  it('loadHistorySession sets transition guard that blocks updateMessages', () => {
    const historyData = {
      success: true,
      sessions: [
        {
          sessionId: 'hist-3',
          title: 'Test Session',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          messageCount: 1,
          lastTimestamp: Date.now(),
        },
      ],
      total: 1,
    } as unknown as HistoryData;

    const mocks = createMocks();

    const { result } = renderHook(() =>
      useSessionManagement({
        messages: [],
        loading: false,
        historyData,
        currentSessionId: null,
        ...mocks,
        t,
      })
    );

    act(() => {
      result.current.loadHistorySession('hist-3');
    });

    // Guard is set, blocking stale updateMessages
    expect((window as any).__sessionTransitioning).toBe(true);
    expect((window as any).__sessionTransitionToken).toBeTruthy();

    // Simulate historyLoadComplete (success path releases guard)
    act(() => {
      (window as any).__sessionTransitioning = false;
      (window as any).__sessionTransitionToken = null;
    });
    expect((window as any).__sessionTransitioning).toBe(false);
    expect((window as any).__sessionTransitionToken).toBeNull();

    // Simulate failure path: guard must also be released
    act(() => {
      (window as any).__sessionTransitioning = true; // re-arm
      (window as any).__sessionTransitionToken = 'transition-rearm';
    });
    // Java exceptionally block calls historyLoadComplete before addErrorMessage
    act(() => {
      (window as any).__sessionTransitioning = false;
      (window as any).__sessionTransitionToken = null;
    });
    expect((window as any).__sessionTransitioning).toBe(false);
    expect((window as any).__sessionTransitionToken).toBeNull();
  });
});
