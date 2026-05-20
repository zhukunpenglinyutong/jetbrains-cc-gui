import { act, renderHook } from '@testing-library/react';
import { useMessageSender } from './useMessageSender';
import type { UseMessageSenderOptions } from './useMessageSender';

describe('useMessageSender - /context command', () => {
  const t = ((key: string, opts?: any) => opts?.defaultValue ?? key) as any;

  const createOptions = (overrides: Partial<UseMessageSenderOptions> = {}): UseMessageSenderOptions => ({
    t,
    addToast: vi.fn(),
    currentProvider: 'claude',
    selectedModel: 'claude-opus-4-7',
    permissionMode: 'default',
    selectedAgent: null,
    sdkStatusLoaded: true,
    currentSdkInstalled: true,
    currentSessionId: 'source-session',
    currentSessionTitle: '测试消息',
    sentAttachmentsRef: { current: new Map() },
    chatInputRef: { current: null },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
    isStreamingRef: { current: false },
    setMessages: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setStreamingActive: vi.fn(),
    setSettingsInitialTab: vi.fn(),
    setCurrentView: vi.fn(),
    forceCreateNewSession: vi.fn(),
    handleModeSelect: vi.fn(),
    longContextEnabled: false,
    openContextUsageDialog: vi.fn(),
    closeContextUsageDialog: vi.fn().mockReturnValue(true),
    ...overrides,
  });

  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('sends get_context_usage with base model when longContext is disabled', () => {
    const opts = createOptions({
      selectedModel: 'claude-opus-4-7',
      longContextEnabled: false,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    expect(call).toMatch(/^get_context_usage:/);

    const payload = JSON.parse(call.substring('get_context_usage:'.length));
    expect(payload.model).toBe('claude-opus-4-7');
    expect(payload.requestId).toBeTruthy();
  });

  it('sends get_context_usage with [1m] suffix when longContext is enabled', () => {
    const opts = createOptions({
      selectedModel: 'claude-opus-4-7',
      longContextEnabled: true,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(call.substring('get_context_usage:'.length));
    expect(payload.model).toBe('claude-opus-4-7[1m]');
  });

  it('opens dialog with loading state before sending bridge event', () => {
    const openContextUsageDialog = vi.fn();
    const opts = createOptions({ openContextUsageDialog });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(openContextUsageDialog).toHaveBeenCalledTimes(1);
    expect(openContextUsageDialog).toHaveBeenCalledWith(
      expect.any(String),
      true, // loading = true
    );
    // Dialog opened BEFORE bridge event sent
    expect(openContextUsageDialog.mock.invocationCallOrder[0]).toBeLessThan(
      (window.sendToJava as any).mock.invocationCallOrder[0],
    );
  });

  it('shows warning toast and does not send bridge event for Codex provider', () => {
    const addToast = vi.fn();
    const opts = createOptions({
      currentProvider: 'codex',
      addToast,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(window.sendToJava).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('Claude'),
      'warning',
    );
  });

  it('closes dialog with error toast when bridge is unavailable', () => {
    // Don't set window.sendToJava → bridge unavailable
    delete (window as any).sendToJava;

    const addToast = vi.fn();
    const closeContextUsageDialog = vi.fn().mockReturnValue(true);
    const opts = createOptions({ addToast, closeContextUsageDialog });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(closeContextUsageDialog).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      expect.any(String),
      'error',
    );
  });

  it('fires fork_session event with the current session id when /fork is typed alone', () => {
    const opts = createOptions();

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/fork');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    expect(call).toMatch(/^fork_session:/);

    const payload = JSON.parse(call.substring('fork_session:'.length));
    expect(payload.sourceSessionId).toBe('source-session');
    expect(payload.sourceTitle).toBe('测试消息');
  });

  it('omits the placeholder new-session title from fork_session payload', () => {
    const opts = createOptions({ currentSessionTitle: 'common.newSession' });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/fork');
    });

    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(call.substring('fork_session:'.length));
    expect(payload.sourceSessionId).toBe('source-session');
    expect(payload.sourceTitle).toBeUndefined();
  });

  it('does not fire send_message for /fork because fork is a tab-opening action', () => {
    // Regression guard: in the old design /fork piggy-backed on send_message
    // with forkSession=true, which made the source tab spit out a fake user
    // message. The new design must never enqueue a normal chat message.
    const opts = createOptions();
    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/fork');
    });

    const calls = (window.sendToJava as any).mock.calls.map((call: string[]) => call[0]);
    const sendMessageCall = calls.find((c: string) => c.startsWith('send_message:'));
    expect(sendMessageCall).toBeUndefined();
  });

  it('still fires fork_session when /fork has trailing text and surfaces an info toast', () => {
    const addToast = vi.fn();
    const opts = createOptions({ addToast });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      // Legacy users may type "/fork explore alt" expecting the old prompt-required
      // flow. The trailing text must be ignored (not sent to Claude) but the user
      // should be told once so they know to retype it in the new tab.
      result.current.handleSubmit('/fork explore alternative');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    expect(call).toMatch(/^fork_session:/);

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('treats /fork followed only by whitespace as the no-trailing-text case', () => {
    const addToast = vi.fn();
    const opts = createOptions({ addToast });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      // handleSubmit already trims the input before dispatching, so trailing
      // whitespace must not pop the "trailing text ignored" info toast.
      result.current.handleSubmit('/fork   ');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    expect(call).toMatch(/^fork_session:/);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('accepts uppercase /FORK case-insensitively', () => {
    const opts = createOptions();

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/FORK');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    expect(call).toMatch(/^fork_session:/);
  });

  it('executeMessage still treats /fork as a local action when replayed from the queue', () => {
    const opts = createOptions();

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.executeMessage('/fork');
    });

    const calls = (window.sendToJava as any).mock.calls.map((call: string[]) => call[0]);
    expect(calls.some((call: string) => call.startsWith('fork_session:'))).toBe(true);
    expect(calls.some((call: string) => call.startsWith('send_message:'))).toBe(false);
  });

  it('warns and does not fire fork_session without an existing Claude session', () => {
    const addToast = vi.fn();
    const opts = createOptions({ currentSessionId: null, addToast });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/fork');
    });

    expect(window.sendToJava).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(expect.any(String), 'warning');
  });

  it('warns and does not fire fork_session when Codex provider is active', () => {
    const addToast = vi.fn();
    const opts = createOptions({ currentProvider: 'codex', addToast });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/fork');
    });

    expect(window.sendToJava).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Claude'), 'warning');
  });

  it('shows an error toast when the bridge is unavailable during /fork', () => {
    // Drop the bridge so sendBridgeEvent returns false. The user must be told
    // something went wrong instead of being left with a silent no-op tab.
    delete (window as any).sendToJava;

    const addToast = vi.fn();
    const opts = createOptions({ addToast });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/fork');
    });

    expect(addToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});
