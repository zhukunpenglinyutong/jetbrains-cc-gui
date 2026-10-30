import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useAppChatController } from './useAppChatController';
import { useModelProviderState } from './hooks/useModelProviderState';
import { useSubmitHandler } from './components/ChatInputBox/hooks/useSubmitHandler';
import { UIStateProvider, useUIState } from './contexts/UIStateContext';
import { SessionProvider } from './contexts/SessionContext';
import { MessagesProvider } from './contexts/MessagesContext';
import { TaskEventProvider } from './contexts/SubagentContext';
import { DialogProvider } from './contexts/DialogContext';
import { updateCodexReasoningCapabilities } from './utils/codexReasoningCapabilities';

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

function useController() {
  const model = useModelProviderState({ addToast: vi.fn(), t });
  return useAppChatController({
    model: { ...model, currentProvider: 'codex', selectedModel: 'native-model', reasoningEffort: 'ultra',
      currentSdkInstalled: true, sdkStatusLoading: false },
    applyHistoryModel: vi.fn(), setPermissionDialogTimeoutSeconds: vi.fn(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  window.sendToJava = vi.fn();
  updateCodexReasoningCapabilities([{ id: 'native-model', supportedReasoningEfforts: ['high', 'ultra'] }]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

it('queues a cleared submission with attachments if Ultra capabilities invalidate before deferred dispatch', () => {
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
  // The deferred callback still holds the controller render before invalidation.
  act(() => updateCodexReasoningCapabilities([], true));
  act(() => vi.advanceTimersByTime(10));
  expect(result.current.controller.messageQueue).toHaveLength(1);
  expect(result.current.controller.messageQueue[0]).toMatchObject({ content: 'preserve deferred draft', attachments: [attachment] });
  expect(vi.mocked(window.sendToJava!).mock.calls.some(([line]) => line.startsWith('send_message'))).toBe(false);

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
