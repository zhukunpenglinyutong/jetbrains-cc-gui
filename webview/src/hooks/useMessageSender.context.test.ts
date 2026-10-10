import { act, renderHook } from '@testing-library/react';
import { useMessageSender } from './useMessageSender';
import type { UseMessageSenderOptions } from './useMessageSender';

describe('useMessageSender - /context command', () => {
  const t = ((key: string, opts?: any) => opts?.defaultValue ?? key) as any;

  const createOptions = (overrides: Partial<UseMessageSenderOptions> = {}): UseMessageSenderOptions => ({
    t,
    addToast: vi.fn(),
    currentProvider: 'claude',
    selectedModel: 'claude-opus-4-8',
    permissionMode: 'default',
    reasoningEffort: 'high',
    codexFastMode: 'normal',
    codexNativeAutoReviewAvailable: true,
    selectedAgent: null,
    sdkStatusLoading: false,
    currentSdkInstalled: true,
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
    startCodexCompaction: vi.fn(),
    ...overrides,
  });

  const getBridgePayload = (eventName: string) => {
    const calls = (window.sendToJava as any).mock.calls.map((call: [string]) => call[0]);
    const prefix = `${eventName}:`;
    const sendCall = calls.find((call: string) => call.startsWith(prefix));
    expect(sendCall).toBeTruthy();
    return JSON.parse(sendCall!.substring(prefix.length));
  };

  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it.each([false, true])('ends a refused Codex message dispatch without sending a text fallback (attachments: %s)', withAttachments => {
    const opts = createOptions({ currentProvider: 'codex', selectedModel: 'gpt-5.5' });
    window.sendToJava = vi.fn(message => {
      if (message.startsWith('send_message')) throw new Error('fixture bridge unavailable');
    });
    const { result } = renderHook(() => useMessageSender(opts));
    act(() => result.current.handleSubmit('keep this submission', withAttachments
      ? [{ id: 'attachment', fileName: 'image.png', mediaType: 'image/png', data: 'synthetic-image' }] : undefined));
    expect(opts.setLoading).toHaveBeenLastCalledWith(false);
    expect(opts.setLoadingStartTime).toHaveBeenLastCalledWith(null);
    expect(opts.setStreamingActive).toHaveBeenLastCalledWith(false);
    expect(opts.addToast).toHaveBeenCalledWith(expect.any(String), 'error');
    const attempted = vi.mocked(window.sendToJava!).mock.calls.map(([message]) => message)
      .filter(message => message.startsWith('send_message'));
    expect(attempted).toHaveLength(1);
    expect(attempted[0]).toMatch(withAttachments ? /^send_message_with_attachments:/ : /^send_message:/);
  });

  it('sends get_context_usage with base model when longContext is disabled', () => {
    const opts = createOptions({
      selectedModel: 'claude-opus-4-8',
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
    expect(payload.model).toBe('claude-opus-4-8');
    expect(payload.requestId).toBeTruthy();
  });

  it('sends get_context_usage with [1m] suffix when longContext is enabled', () => {
    const opts = createOptions({
      selectedModel: 'claude-opus-4-8',
      longContextEnabled: true,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('/context');
    });

    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    const call = (window.sendToJava as any).mock.calls[0][0] as string;
    const payload = JSON.parse(call.substring('get_context_usage:'.length));
    expect(payload.model).toBe('claude-opus-4-8[1m]');
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

  it.each([
    { supported: false, withAttachment: false },
    { supported: false, withAttachment: true },
    { supported: true, withAttachment: false },
    { supported: true, withAttachment: true },
  ])('preserves Codex native auto mode ($supported, attachment: $withAttachment)', ({ supported, withAttachment }) => {
    const opts = createOptions({
      currentProvider: 'codex',
      permissionMode: 'auto',
      codexNativeAutoReviewAvailable: supported,
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello', withAttachment ? [{
        id: 'att-1', fileName: 'note.txt', mediaType: 'text/plain', data: 'aGVsbG8=',
      }] : undefined);
    });

    const event = withAttachment ? 'send_message_with_attachments' : 'send_message';
    expect(getBridgePayload(event).permissionMode).toBe('auto');
  });

  it('switches Codex to plan and sends a body after the command prefix exactly once', () => {
    const handleModeSelect = vi.fn();
    const opts = createOptions({ currentProvider: 'codex', handleModeSelect });
    const { result } = renderHook(() => useMessageSender(opts));

    act(() => { result.current.handleSubmit('/plan inspect the workspace'); });

    expect(handleModeSelect).toHaveBeenCalledWith('plan');
    expect(getBridgePayload('send_message').text).toBe('inspect the workspace');
    expect(getBridgePayload('send_message').permissionMode).toBe('plan');
    expect(getBridgePayload('send_message').codexSettings.collaborationMode).toBe('plan');
    expect((window.sendToJava as any).mock.calls.filter((call: [string]) => call[0].startsWith('send_message:'))).toHaveLength(1);
  });

  it('freezes native collaboration and policy settings on the submitted turn', () => {
    const opts = createOptions({
      currentProvider: 'codex',
      codexCollaborationMode: 'plan',
      codexApprovalPreset: 'request',
      codexSandboxSelection: 'read-only',
    });
    const { result } = renderHook(() => useMessageSender(opts));

    act(() => { result.current.handleSubmit('inspect only'); });

    expect(getBridgePayload('send_message').codexSettings).toEqual({
      collaborationMode: 'plan',
      approvalPreset: 'request',
      sandboxSelection: 'read-only',
      skills: [],
    });
  });

  it('blocks native auto review when the desired sandbox is full access', () => {
    const addToast = vi.fn();
    const opts = createOptions({
      addToast,
      currentProvider: 'codex',
      codexApprovalPreset: 'auto',
      codexSandboxSelection: 'danger-full-access',
    });
    const { result } = renderHook(() => useMessageSender(opts));

    act(() => { result.current.handleSubmit('unsafe combination'); });

    expect(window.sendToJava).not.toHaveBeenCalledWith(expect.stringContaining('send_message:'));
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('cannot use danger-full-access'), 'warning');
  });

  it('keeps compact waiting while Stop is awaiting the native terminal', () => {
    const opts = createOptions({ currentProvider: 'codex', codexCompactionPending: true });
    const { result } = renderHook(() => useMessageSender(opts));
    act(() => result.current.interruptSession());
    expect(window.sendToJava).toHaveBeenCalledWith('interrupt_session:');
    expect(opts.setLoading).not.toHaveBeenCalled();
    expect(opts.setLoadingStartTime).not.toHaveBeenCalled();
  });

  it.each(['/compact', '/review'])('dispatches %s as a Codex control command', (command) => {
    const opts = createOptions({ currentProvider: 'codex' });
    const { result } = renderHook(() => useMessageSender(opts));

    act(() => { result.current.handleSubmit(command); });

    if (command === '/compact') {
      expect(opts.startCodexCompaction).toHaveBeenCalledOnce();
      expect(opts.addToast).not.toHaveBeenCalled();
    } else {
      expect(window.sendToJava).toHaveBeenCalledWith('codex_review:{}');
    }
    expect((window.sendToJava as any).mock.calls.filter((call: [string]) => call[0].startsWith('send_message:'))).toHaveLength(0);
  });

  it.each(['/review', '/diff'])('reports an unavailable bridge without claiming %s started', (command) => {
    delete window.sendToJava;
    const opts = createOptions({ currentProvider: 'codex' });
    const { result } = renderHook(() => useMessageSender(opts));
    act(() => { result.current.handleSubmit(command); });
    expect(opts.addToast).toHaveBeenCalledExactlyOnceWith('Bridge is not available right now', 'error');
    expect(opts.setLoading).not.toHaveBeenCalled();
    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it.each(['/compact extra', '/review extra'])('rejects %s without sending a native operation', (command) => {
    const opts = createOptions({ currentProvider: 'codex' });
    const { result } = renderHook(() => useMessageSender(opts));

    act(() => { result.current.handleSubmit(command); });

    expect(window.sendToJava).not.toHaveBeenCalledWith(`codex_${command.split(' ')[0].slice(1)}:{}`);
    expect((window.sendToJava as any).mock.calls.filter((call: [string]) => call[0].startsWith('send_message:'))).toHaveLength(0);
  });

  it('turns /init into one native user task without the slash prefix', () => {
    const opts = createOptions({ currentProvider: 'codex' });
    const { result } = renderHook(() => useMessageSender(opts));

    act(() => { result.current.handleSubmit('/init inspect the repository'); });

    expect(getBridgePayload('send_message').text).toContain('AGENTS.md');
    expect(getBridgePayload('send_message').text).toContain('inspect the repository');
    expect((window.sendToJava as any).mock.calls.filter((call: [string]) => call[0].startsWith('send_message:'))).toHaveLength(1);
  });

  it('reuses the optimistic message identity in the backend payload', () => {
    const setMessages = vi.fn();
    const opts = createOptions({ currentProvider: 'codex', setMessages });
    const { result } = renderHook(() => useMessageSender(opts));

    act(() => { result.current.handleSubmit('same prompt'); });

    const payload = getBridgePayload('send_message');
    const optimisticUpdater = setMessages.mock.calls[0][0] as (messages: unknown[]) => Array<Record<string, any>>;
    const optimistic = optimisticUpdater([])[0];
    expect(payload.clientMessageId).toBeTruthy();
    expect(optimistic.raw.clientMessageId).toBe(payload.clientMessageId);
  });

  it('includes explicit Claude high reasoning effort in plain message payload', () => {
    const opts = createOptions({
      currentProvider: 'claude',
      selectedModel: 'claude-opus-4-8',
      reasoningEffort: 'high',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.reasoningEffort).toBe('high');
  });

  it('includes explicit Claude high reasoning effort in attachment message payload', () => {
    const opts = createOptions({
      currentProvider: 'claude',
      selectedModel: 'claude-opus-4-8',
      reasoningEffort: 'high',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello', [{
        id: 'att-1',
        fileName: 'note.txt',
        mediaType: 'text/plain',
        data: 'aGVsbG8=',
      }]);
    });

    const payload = getBridgePayload('send_message_with_attachments');
    expect(payload.reasoningEffort).toBe('high');
  });

  it('omits reasoning effort for Claude models without adaptive thinking support', () => {
    const opts = createOptions({
      currentProvider: 'claude',
      selectedModel: 'claude-haiku-4-5',
      reasoningEffort: 'low',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload).not.toHaveProperty('reasoningEffort');
  });

  it('includes explicit non-default Claude reasoning effort in plain message payload', () => {
    const opts = createOptions({
      reasoningEffort: 'low',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello');
    });

    const payload = getBridgePayload('send_message');
    expect(payload.reasoningEffort).toBe('low');
  });

  it('includes explicit non-default Claude reasoning effort in attachment message payload', () => {
    const opts = createOptions({
      reasoningEffort: 'low',
    });

    const { result } = renderHook(() => useMessageSender(opts));

    act(() => {
      result.current.handleSubmit('hello', [{
        id: 'att-1',
        fileName: 'note.txt',
        mediaType: 'text/plain',
        data: 'aGVsbG8=',
      }]);
    });

    const payload = getBridgePayload('send_message_with_attachments');
    expect(payload.reasoningEffort).toBe('low');
  });
});
