import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useAppChatController } from './useAppChatController';
import { useModelProviderState } from './hooks/useModelProviderState';
import { useSubmitHandler } from './components/ChatInputBox/hooks/useSubmitHandler';
import { UIStateProvider, useUIState } from './contexts/UIStateContext';
import { SessionProvider, useSession } from './contexts/SessionContext';
import { MessagesProvider, useMessages } from './contexts/MessagesContext';
import { TaskEventProvider } from './contexts/SubagentContext';
import { DialogProvider } from './contexts/DialogContext';
import { updateCodexReasoningCapabilities } from './utils/codexReasoningCapabilities';
import { finishSessionTransition, getSessionTransitionPending, getSessionTransitionToken } from './utils/sessionTransitionState';
import { clearPendingStreamStart } from './utils/streamLifecycle';

const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as TFunction;
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

function Providers({ children }: { children: ReactNode }) {
  return <UIStateProvider><SessionProvider><MessagesProvider><TaskEventProvider><DialogProvider>
    {children}
  </DialogProvider></TaskEventProvider></MessagesProvider></SessionProvider></UIStateProvider>;
}

function useController(provider: 'claude' | 'codex' = 'codex') {
  const model = useModelProviderState({ addToast: vi.fn(), t });
  return useAppChatController({
    model: { ...model, currentProvider: provider, selectedModel: provider === 'codex' ? 'native-model' : 'claude-opus-5',
      reasoningEffort: provider === 'codex' ? 'ultra' : 'high',
      currentSdkInstalled: true, sdkStatusLoading: false },
    applyHistoryModel: vi.fn(), setPermissionDialogTimeoutSeconds: vi.fn(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  finishSessionTransition();
  clearPendingStreamStart();
  window.__sessionTransitioning = false;
  window.__sessionTransitionToken = undefined;
  window.sendToJava = vi.fn();
  updateCodexReasoningCapabilities([{ id: 'native-model', supportedReasoningEfforts: ['high', 'ultra'] }]);
});

function lastRequest(event: string): Record<string, string> {
  const call = vi.mocked(window.sendToJava!).mock.calls.filter(([line]) => line.startsWith(`${event}:`)).at(-1);
  expect(call).toBeDefined();
  return JSON.parse(call![0].slice(event.length + 1));
}

function sentTurns(): string[] {
  return vi.mocked(window.sendToJava!).mock.calls.map(([line]) => line).filter(line => line.startsWith('send_message'));
}

function renderSessionController(provider: 'claude' | 'codex' = 'claude') {
  const hook = renderHook(() => ({ controller: useController(provider), session: useSession(), messages: useMessages(), ui: useUIState() }), { wrapper: Providers });
  act(() => {
    window.setSessionId?.('old-session');
    hook.result.current.messages.setMessages([{ type: 'user', content: 'old conversation' }]);
  });
  return hook;
}

describe('session lifecycle through the registered bridge callbacks', () => {
  const attachment = { id: 'queued-file', fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' };

  it('keeps the old conversation and attached queue after failed cleanup, then resumes one send', () => {
    const { result } = renderSessionController();
    act(() => { window.showLoading?.('true'); window.onStreamStart?.(); });
    act(() => result.current.controller.handleSubmit('queued after this turn', [attachment]));
    const queued = result.current.controller.messageQueue[0];
    act(() => result.current.controller.handleSubmit('/new'));
    const token = lastRequest('create_new_session').transitionToken;
    act(() => { window.onStreamEnd?.(); window.showLoading?.('false'); });
    expect(result.current.messages.streamingActive).toBe(false);
    expect(result.current.messages.loading).toBe(false);
    expect(result.current.controller.messageQueue).toEqual([queued]);
    expect(sentTurns()).toHaveLength(0);
    act(() => window.sessionTransitionFailed?.('Cleanup failed', token));
    expect(result.current.session.currentSessionId).toBe('old-session');
    expect(result.current.messages.messages[0].content).toBe('old conversation');
    expect(result.current.controller.messageQueue).toHaveLength(0);
    expect(sentTurns()).toHaveLength(1);
    expect(JSON.parse(sentTurns()[0].split(/:(.*)/s)[1])).toMatchObject({ text: 'queued after this turn', attachments: [{ fileName: 'notes.txt' }] });
    expect(result.current.ui.toasts.some(toast => toast.message === 'Cleanup failed')).toBe(true);
  });

  it('drops the outgoing queue on acceptance but sends a message typed during the switch to the new session', () => {
    const { result } = renderSessionController();
    act(() => { window.showLoading?.('true'); window.onStreamStart?.(); });
    act(() => result.current.controller.handleSubmit('typed for the old session'));
    act(() => result.current.controller.handleSubmit('/new'));
    const token = lastRequest('create_new_session').transitionToken;
    act(() => { window.onStreamEnd?.(); window.showLoading?.('false'); });
    act(() => result.current.controller.handleSubmit('typed after clicking new'));
    expect(result.current.controller.messageQueue).toHaveLength(2);
    act(() => { window.clearMessages?.(undefined, token); window.historyLoadComplete?.(0, token); });
    expect(getSessionTransitionPending()).toBe(false);
    expect(sentTurns()).toHaveLength(1);
    expect(JSON.parse(sentTurns()[0].split(/:(.*)/s)[1])).toMatchObject({ text: 'typed after clicking new' });
  });

  it('keeps a timed-out transaction pending and accepts its late clear after an early completion', () => {
    const { result } = renderSessionController();
    act(() => result.current.controller.handleSubmit('/new'));
    const token = lastRequest('create_new_session').transitionToken;
    act(() => vi.advanceTimersByTime(15_001));
    expect(getSessionTransitionPending()).toBe(true);
    expect(result.current.messages.messages[0].content).toBe('old conversation');
    act(() => window.historyLoadComplete?.(0, token));
    expect(getSessionTransitionPending()).toBe(true);
    act(() => window.clearMessages?.(undefined, token));
    expect(getSessionTransitionPending()).toBe(false);
    expect(result.current.session.currentSessionId).toBeNull();
    expect(result.current.messages.messages).toEqual([]);
  });

  it('rejects retired callbacks before and after a replacement, and only clear accepts the target identity', () => {
    const { result } = renderSessionController();
    act(() => result.current.controller.handleSubmit('/new'));
    const tokenA = lastRequest('create_new_session').transitionToken;
    act(() => vi.advanceTimersByTime(15_001));
    act(() => result.current.controller.loadHistorySession('session-b', 'claude'));
    const tokenB = lastRequest('load_session').transitionToken;
    expect(tokenB).not.toBe(tokenA);
    act(() => {
      window.sessionTransitionStarted?.('', 'A', tokenA);
      window.clearMessages?.(undefined, tokenA);
      window.setSessionId?.('session-a', tokenA);
      window.historyLoadComplete?.(0, tokenA);
      window.sessionTransitionFailed?.('old error', tokenA);
      window.setSessionId?.('session-b', tokenB);
      window.historyLoadComplete?.(0, tokenB);
    });
    expect(result.current.session.currentSessionId).toBe('old-session');
    expect(result.current.messages.messages[0].content).toBe('old conversation');
    expect(getSessionTransitionPending()).toBe(true);
    act(() => window.clearMessages?.(undefined, tokenB));
    expect(result.current.session.currentSessionId).toBe('session-b');
    expect(getSessionTransitionPending()).toBe(false);
    act(() => result.current.messages.setMessages([{ type: 'user', content: 'B stays' }]));
    act(() => {
      window.clearMessages?.(undefined, tokenA);
      window.clearMessages?.(undefined, tokenB);
      window.setSessionId?.('session-a', tokenA);
      window.sessionTransitionStarted?.('', 'A', tokenA);
    });
    expect(result.current.session.currentSessionId).toBe('session-b');
    expect(result.current.messages.messages[0].content).toBe('B stays');
    expect(result.current.ui.toasts.some(toast => toast.message === 'old error')).toBe(false);
  });

  it('orders unseen IDE starts around local acknowledgement and adopts a genuinely newer Template', () => {
    const { result } = renderSessionController();
    act(() => result.current.controller.handleSubmit('/new'));
    const localToken = lastRequest('create_new_session').transitionToken;
    act(() => window.sessionTransitionStarted?.('late-a', 'old IDE action', 'backend:unseen-a'));
    expect(getSessionTransitionToken()).toBe(localToken);
    act(() => window.sessionTransitionStarted?.('', '', localToken));
    act(() => window.sessionTransitionStarted?.('', 'Template', 'backend:new-template'));
    expect(getSessionTransitionToken()).toBe('backend:new-template');
    act(() => {
      window.clearMessages?.(undefined, localToken);
      window.sessionTransitionStarted?.('late-a', 'old IDE action', 'backend:unseen-a');
      window.clearMessages?.(undefined, 'backend:new-template');
      window.historyLoadComplete?.(0, 'backend:new-template');
    });
    expect(result.current.session.customSessionTitle).toBe('Template');
    expect(getSessionTransitionPending()).toBe(false);
    act(() => window.sessionTransitionStarted?.('', 'Template', 'backend:new-template'));
    expect(getSessionTransitionPending()).toBe(false);
  });

  it('reselects the old session after timeout as a scoped replacement instead of an unscoped soft reload', () => {
    const { result } = renderSessionController();
    act(() => result.current.controller.handleSubmit('/new'));
    const tokenA = lastRequest('create_new_session').transitionToken;
    act(() => result.current.controller.loadHistorySession('old-session', 'claude'));
    expect(vi.mocked(window.sendToJava!).mock.calls.some(([line]) => line.startsWith('load_session:'))).toBe(false);
    act(() => vi.advanceTimersByTime(15_001));
    act(() => result.current.controller.loadHistorySession('old-session', 'claude'));
    expect(lastRequest('load_session')).toMatchObject({ sessionId: 'old-session', provider: 'claude' });
    expect(lastRequest('load_session').transitionToken).not.toBe(tokenA);
    expect(lastRequest('load_session').transitionToken).toBeTruthy();
  });

  it('explains a refused session request while another switch is still starting', () => {
    const { result } = renderSessionController();
    act(() => result.current.controller.handleSubmit('/new'));
    act(() => result.current.controller.loadHistorySession('another-session'));
    expect(vi.mocked(window.sendToJava!).mock.calls.some(([line]) => line.startsWith('load_session:'))).toBe(false);
    expect(result.current.ui.toasts.some(toast => toast.message.includes('already in progress'))).toBe(true);
  });

  it('lets a new session supersede a current-session deletion that never reports, keeping the queue paused', () => {
    const { result } = renderSessionController();
    act(() => result.current.controller.deleteHistorySession('old-session'));
    const heldToken = getSessionTransitionToken();
    act(() => result.current.controller.handleSubmit('typed while deleting'));
    act(() => result.current.controller.handleSubmit('/new'));
    expect(vi.mocked(window.sendToJava!).mock.calls.some(([line]) => line.startsWith('create_new_session:'))).toBe(false);
    act(() => vi.advanceTimersByTime(15_001));
    expect(sentTurns()).toHaveLength(0);
    act(() => result.current.controller.handleSubmit('/new'));
    expect(lastRequest('create_new_session').transitionToken).not.toBe(heldToken);
    expect(result.current.controller.messageQueue).toHaveLength(1);
  });

  it.each([true, false])('holds current-Claude deletion through its real outcome (success=%s)', success => {
    const { result } = renderSessionController();
    act(() => window.showLoading?.('true'));
    act(() => result.current.controller.handleSubmit('draft during deletion', [attachment]));
    act(() => result.current.controller.deleteHistorySession('old-session'));
    const deletion = lastRequest('delete_session');
    const heldToken = getSessionTransitionToken();
    act(() => { window.showLoading?.('false'); vi.advanceTimersByTime(30_001); });
    expect(getSessionTransitionPending()).toBe(true);
    expect(result.current.controller.messageQueue).toHaveLength(1);
    expect(sentTurns()).toHaveLength(0);
    act(() => window.onHistoryDeleteResult?.(JSON.stringify({ requestId: deletion.requestId, success,
      deletedSessionIds: success ? ['old-session'] : [], errorCode: success ? undefined : 'DELETE_FAILED' })));
    if (success) {
      const token = lastRequest('create_new_session').transitionToken;
      expect(token).toBe(heldToken);
      expect(result.current.controller.messageQueue).toHaveLength(1);
      expect(sentTurns()).toHaveLength(0);
      act(() => { window.clearMessages?.(undefined, token); window.historyLoadComplete?.(0, token); });
      expect(result.current.controller.messageQueue).toHaveLength(0);
      expect(sentTurns()).toHaveLength(0);
      expect(result.current.session.currentSessionId).toBeNull();
    } else {
      expect(getSessionTransitionPending()).toBe(false);
      expect(result.current.session.currentSessionId).toBe('old-session');
      expect(sentTurns()).toHaveLength(1);
    }
  });

  it('retains a first SDK identity received during cleanup when the transition fails', () => {
    const { result } = renderSessionController();
    act(() => window.setSessionId?.(''));
    act(() => result.current.controller.handleSubmit('/new'));
    const token = lastRequest('create_new_session').transitionToken;
    act(() => window.setSessionId?.('real-first-sdk-session'));
    expect(getSessionTransitionPending()).toBe(true);
    act(() => window.sessionTransitionFailed?.('Cleanup failed', token));
    expect(result.current.session.currentSessionId).toBe('real-first-sdk-session');
  });

  it('changes provider, model and draft only after cleanup acceptance, preserving them on failure', () => {
    const { result } = renderSessionController();
    const clear = vi.fn();
    result.current.controller.chatInputRef.current = {
      clear, getValue: () => 'draft to preserve', setValue: vi.fn(), focus: vi.fn(), hasContent: () => true,
      getFileTags: () => [], getAttachments: () => [], setAttachments: () => true,
      canApplyAttachments: () => true, hasPendingImagePastes: () => false,
    };
    vi.mocked(window.sendToJava!).mockClear();
    act(() => result.current.controller.wrappedHandleProviderSelect('codex'));
    const failed = lastRequest('create_new_session');
    expect(failed.provider).toBe('codex');
    expect(clear).not.toHaveBeenCalled();
    const changes = () => vi.mocked(window.sendToJava!).mock.calls.map(([line]) => line)
      .filter(line => /^(set_provider|set_model|set_mode):/.test(line));
    expect(changes()).toEqual([]);
    act(() => window.sessionTransitionFailed?.('Could not retire old runtime', failed.transitionToken));
    expect(result.current.session.currentSessionId).toBe('old-session');
    expect(clear).not.toHaveBeenCalled();
    expect(changes()).toEqual([]);
    act(() => result.current.controller.wrappedHandleProviderSelect('codex'));
    const accepted = lastRequest('create_new_session');
    act(() => window.clearMessages?.(undefined, failed.transitionToken));
    expect(changes()).toEqual([]);
    act(() => window.clearMessages?.(undefined, accepted.transitionToken));
    expect(clear).toHaveBeenCalledOnce();
    expect(changes()).toContain('set_provider:codex');
    expect(changes().some(line => line.startsWith('set_model:'))).toBe(true);
    expect(changes().some(line => line.startsWith('set_mode:'))).toBe(true);
    expect(result.current.session.currentSessionId).toBeNull();
    act(() => window.historyLoadComplete?.(0, accepted.transitionToken));
  });

  it('rejects stale Codex pages when a retry targets the same session', () => {
    const { result } = renderSessionController('codex');
    act(() => result.current.controller.loadHistorySession('old-session', 'codex'));
    const tokenA = lastRequest('load_session').transitionToken;
    act(() => window.clearMessages?.(undefined, tokenA));
    const page = (pageId: string, transitionToken: string) => ({ pageId, transitionToken,
      sessionId: 'old-session', mode: 'replace', fromTurn: 0, toTurn: 1, totalTurns: 1, hasMore: false, loadedMessageCount: 1 });
    act(() => {
      window.beginCodexHistoryPage?.(JSON.stringify(page('page-a', tokenA)));
      window.appendCodexHistoryPageBatch?.('page-a', JSON.stringify([{ type: 'user', content: 'stale page A' }]));
      vi.advanceTimersByTime(15_001);
    });
    act(() => result.current.controller.loadHistorySession('old-session', 'codex'));
    const tokenB = lastRequest('load_session').transitionToken;
    act(() => {
      window.completeCodexHistoryPage?.(JSON.stringify(page('page-a', tokenA)));
      window.beginCodexHistoryPage?.(JSON.stringify(page('late-page-a', tokenA)));
      window.appendCodexHistoryPageBatch?.('late-page-a', JSON.stringify([{ type: 'user', content: 'stale late A' }]));
      window.completeCodexHistoryPage?.(JSON.stringify(page('late-page-a', tokenA)));
    });
    expect(result.current.messages.messages).toEqual([]);
    act(() => {
      window.clearMessages?.(undefined, tokenB);
      window.beginCodexHistoryPage?.(JSON.stringify(page('page-b', tokenB)));
      window.appendCodexHistoryPageBatch?.('page-b', JSON.stringify([{ type: 'user', content: 'current page B' }]));
      window.completeCodexHistoryPage?.(JSON.stringify(page('page-b', tokenB)));
      window.historyLoadComplete?.('', tokenB);
    });
    expect(result.current.messages.messages.map(message => message.content)).toEqual(['current page B']);
  });

  it('accepts a canonical Codex thread identity and page only after its filename-alias restore is accepted', () => {
    const { result } = renderSessionController('codex');
    act(() => result.current.controller.loadHistorySession('rollout-filename-alias', 'codex'));
    const token = lastRequest('load_session').transitionToken;
    act(() => window.setSessionId?.('canonical-thread-id', token));
    expect(result.current.session.currentSessionId).toBe('old-session');
    const page = { pageId: 'canonical-page', transitionToken: token, sessionId: 'canonical-thread-id',
      mode: 'replace', fromTurn: 0, toTurn: 1, totalTurns: 1, hasMore: false, loadedMessageCount: 1 };
    act(() => {
      window.clearMessages?.(undefined, token);
      window.setSessionId?.('canonical-thread-id', token);
      window.beginCodexHistoryPage?.(JSON.stringify(page));
      window.appendCodexHistoryPageBatch?.('canonical-page', JSON.stringify([{ type: 'user', content: 'restored canonical history' }]));
      window.completeCodexHistoryPage?.(JSON.stringify(page));
      window.historyLoadComplete?.('', token);
    });
    expect(result.current.session.currentSessionId).toBe('canonical-thread-id');
    expect(result.current.messages.messages.map(message => message.content)).toEqual(['restored canonical history']);
    expect(getSessionTransitionPending()).toBe(false);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

it.each(['catalog invalidation', 'bridge refusal'])('queues a cleared submission with attachments after %s during deferred dispatch', failure => {
  const attachment = { id: 'draft-file', fileName: 'context.txt', mediaType: 'text/plain', data: 'aGk=' };
  const clearInput = vi.fn();
  const close = vi.fn();
  const { result } = renderHook(() => {
    const controller = useController();
    const submit = useSubmitHandler({
      getTextContent: () => 'preserve deferred draft', invalidateCache: vi.fn(), attachments: [attachment],
      sdkStatusLoading: false, sdkInstalled: true, currentProvider: 'codex',
      selectedModel: 'native-model', reasoningEffort: 'ultra', clearInput,
      externalAttachments: undefined, setInternalAttachments: vi.fn(),
      fileCompletion: { close }, commandCompletion: { close }, agentCompletion: { close },
      promptCompletion: { close }, dollarCommandCompletion: { close }, recordInputHistory: vi.fn(),
      onSubmit: controller.handleSubmit, t,
    });
    return { controller, submit };
  }, { wrapper: Providers });

  act(() => result.current.submit());
  expect(clearInput).toHaveBeenCalledOnce();
  // The deferred callback still holds the controller render before readiness changes.
  if (failure === 'catalog invalidation') act(() => updateCodexReasoningCapabilities([], true));
  else window.sendToJava = vi.fn(line => { if (line.startsWith('send_message')) throw new Error('handoff refused'); });
  act(() => vi.advanceTimersByTime(10));
  expect(result.current.controller.messageQueue).toHaveLength(1);
  expect(result.current.controller.messageQueue[0]).toMatchObject({ content: 'preserve deferred draft', attachments: [attachment] });
  expect(result.current.controller.mergedMessages.some(message => message.isOptimistic)).toBe(false);
  if (failure === 'catalog invalidation') expect(sentTurns()).toHaveLength(0);
  else window.sendToJava = vi.fn();

  act(() => updateCodexReasoningCapabilities([{ id: 'native-model', supportedReasoningEfforts: ['high', 'ultra'] }]));
  expect(result.current.controller.messageQueue).toHaveLength(0);
  const sent = vi.mocked(window.sendToJava!).mock.calls.find(([line]) => line.startsWith('send_message_with_attachments:'));
  expect(sent).toBeDefined();
  expect(JSON.parse(sent![0].slice('send_message_with_attachments:'.length))).toMatchObject({
    text: 'preserve deferred draft', reasoningEffort: 'ultra',
    attachments: [{ fileName: 'context.txt', mediaType: 'text/plain', data: 'aGk=' }],
  });
});

it.each(['/plan', '/compact', '/review', '/plugins', '/context', '/diff', '/approvals'])('keeps %s outside a capability-only queue pause', command => {
  updateCodexReasoningCapabilities([], true);
  const { result } = renderHook(() => ({ controller: useController(), ui: useUIState() }), { wrapper: Providers });
  act(() => result.current.controller.handleSubmit(command));
  expect(result.current.controller.messageQueue).toHaveLength(0);
  const bridgeMessages = vi.mocked(window.sendToJava!).mock.calls.map(([line]) => line);
  const commandEvents: Record<string, string> = { '/compact': 'codex_compact:', '/review': 'codex_review:', '/diff': 'codex_read_workspace_diff:' };
  const expectedEvent = commandEvents[command];
  if (expectedEvent) expect(bridgeMessages.some(line => line.startsWith(expectedEvent))).toBe(true);
  if (command === '/approvals') expect(result.current.ui.currentView).toBe('settings');
  if (command === '/plugins') expect(result.current.controller.mergedMessages).toHaveLength(2);
  if (command === '/plan' || command === '/context') expect(result.current.ui.toasts).toHaveLength(1);
});
