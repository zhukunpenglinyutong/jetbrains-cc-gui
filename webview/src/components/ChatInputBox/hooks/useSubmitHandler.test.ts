import { renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { useSubmitHandler } from './useSubmitHandler.js';
import { updateCodexReasoningCapabilities } from '../../../utils/codexReasoningCapabilities';

beforeEach(() => updateCodexReasoningCapabilities([], true));

it.each(['/compact', '/review', '/diff', '/approvals'])('dispatches Codex control %s while CLI discovery is pending', (command) => {
  vi.useFakeTimers();
  try {
    const onSubmit = vi.fn();
    const addToast = vi.fn();
    const close = vi.fn();
    const { result } = renderHook(() => useSubmitHandler({
      getTextContent: () => command, invalidateCache: vi.fn(), attachments: [],
      sdkStatusLoading: true, sdkInstalled: false, currentProvider: 'codex', clearInput: vi.fn(),
      externalAttachments: undefined, setInternalAttachments: vi.fn(),
      fileCompletion: { close }, commandCompletion: { close }, agentCompletion: { close },
      promptCompletion: { close }, dollarCommandCompletion: { close }, recordInputHistory: vi.fn(),
      onSubmit, addToast, t: (key) => key,
    }));
    result.current();
    vi.runAllTimers();
    expect(onSubmit).toHaveBeenCalledWith(command, undefined);
    expect(addToast).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

function createAttachment(id: string): Attachment {
  return { id, fileName: `${id}.txt`, mediaType: 'text/plain', data: 'ZGF0YQ==' };
}

describe('useSubmitHandler', () => {
  it('preserves the text and attachment draft while restored Ultra awaits native capabilities', () => {
    vi.useFakeTimers();
    try {
      const clearInput = vi.fn();
      const setInternalAttachments = vi.fn();
      const clearAttachmentsDraft = vi.fn();
      const invalidateImagePastes = vi.fn();
      const recordInputHistory = vi.fn();
      const onSubmit = vi.fn();
      const addToast = vi.fn();
      const close = vi.fn();
      const attachments = [createAttachment('a1')];
      const { result } = renderHook(() => useSubmitHandler({
        getTextContent: () => 'keep this draft', invalidateCache: vi.fn(), attachments,
        sdkStatusLoading: false, sdkInstalled: true, currentProvider: 'codex',
        selectedModel: 'native-model', reasoningEffort: 'ultra',
        clearInput, externalAttachments: undefined, setInternalAttachments,
        clearAttachmentsDraft, invalidateImagePastes, recordInputHistory, onSubmit, addToast,
        fileCompletion: { close }, commandCompletion: { close }, agentCompletion: { close },
        promptCompletion: { close }, dollarCommandCompletion: { close }, t: key => key,
      }));
      result.current();
      vi.runAllTimers();
      expect(addToast).toHaveBeenCalledWith('chat.codexUltraCapabilitiesLoading', 'info');
      for (const mutation of [clearInput, setInternalAttachments, clearAttachmentsDraft, invalidateImagePastes, recordInputHistory, close, onSubmit]) {
        expect(mutation).not.toHaveBeenCalled();
      }
      updateCodexReasoningCapabilities([{ id: 'native-model', supportedReasoningEfforts: ['high', 'ultra'] }]);
      result.current();
      vi.runAllTimers();
      expect(onSubmit).toHaveBeenCalledWith('keep this draft', attachments);
    } finally { vi.useRealTimers(); }
  });

  it.each(['/new', '/resume', '/plan', '/compact', '/review', '/context'])('does not block local/native control %s during Ultra lookup', command => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      const addToast = vi.fn();
      const close = vi.fn();
      const { result } = renderHook(() => useSubmitHandler({
        getTextContent: () => command, invalidateCache: vi.fn(), attachments: [],
        sdkStatusLoading: false, sdkInstalled: true, currentProvider: 'codex',
        selectedModel: 'native-model', reasoningEffort: 'ultra', clearInput: vi.fn(),
        externalAttachments: undefined, setInternalAttachments: vi.fn(),
        fileCompletion: { close }, commandCompletion: { close }, agentCompletion: { close },
        promptCompletion: { close }, dollarCommandCompletion: { close }, recordInputHistory: vi.fn(),
        onSubmit, addToast, t: key => key,
      }));
      result.current();
      vi.runAllTimers();
      expect(onSubmit).toHaveBeenCalledWith(command, undefined);
      expect(addToast).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('does nothing when input is empty and no attachments', () => {
    const clearInput = vi.fn();
    const close = vi.fn();
    const onSubmit = vi.fn();
    const recordInputHistory = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => '',
        invalidateCache: vi.fn(),
        attachments: [],
        sdkStatusLoading: false,
        sdkInstalled: true,
        currentProvider: 'claude',
        clearInput,
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory,
        onSubmit,
        t: (key) => key,
      })
    );

    result.current();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
    expect(recordInputHistory).not.toHaveBeenCalled();
  });

  it('blocks submit when SDK status is loading', () => {
    const addToast = vi.fn();
    const clearInput = vi.fn();
    const close = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        sdkStatusLoading: true,
        sdkInstalled: false,
        currentProvider: 'claude',
        clearInput,
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory: vi.fn(),
        onSubmit: vi.fn(),
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    expect(addToast).toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
  });

  it('sends while the shared SDK query is still loading when this provider is already installed', () => {
    vi.useFakeTimers();
    const addToast = vi.fn();
    const onSubmit = vi.fn();
    const close = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        sdkStatusLoading: true,
        sdkInstalled: true,
        currentProvider: 'grok',
        clearInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory: vi.fn(),
        onSubmit,
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    vi.advanceTimersByTime(20);
    expect(addToast).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('hello', undefined);
    vi.useRealTimers();
  });

  it('prompts install when SDK is missing', () => {
    const addToast = vi.fn();
    const onInstallSdk = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        sdkStatusLoading: false,
        sdkInstalled: false,
        currentProvider: 'codex',
        clearInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close: vi.fn() },
        commandCompletion: { close: vi.fn() },
        agentCompletion: { close: vi.fn() },
        promptCompletion: { close: vi.fn() },
        dollarCommandCompletion: { close: vi.fn() },
        recordInputHistory: vi.fn(),
        onSubmit: vi.fn(),
        onInstallSdk,
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    expect(addToast).toHaveBeenCalled();
    expect(onInstallSdk).toHaveBeenCalled();
  });

  it.each(['prompt', ''])('preserves the %s draft while image attachments are pending', (content) => {
    const clearInput = vi.fn();
    const setInternalAttachments = vi.fn();
    const invalidateImagePastes = vi.fn();
    const addToast = vi.fn();
    const close = vi.fn();
    const onSubmit = vi.fn();
    const recordInputHistory = vi.fn();
    const { result } = renderHook(() => useSubmitHandler({
      getTextContent: () => content,
      invalidateCache: vi.fn(), attachments: [], sdkStatusLoading: false, sdkInstalled: true,
      currentProvider: 'claude', clearInput, externalAttachments: undefined,
      setInternalAttachments, hasPendingImagePastes: () => true, invalidateImagePastes,
      fileCompletion: { close }, commandCompletion: { close }, agentCompletion: { close },
      promptCompletion: { close }, dollarCommandCompletion: { close },
      recordInputHistory, onSubmit, addToast, t: (key) => key,
    }));

    result.current();

    expect(addToast).toHaveBeenCalledWith('chat.pasteImagePreparing', 'info');
    expect(clearInput).not.toHaveBeenCalled();
    expect(setInternalAttachments).not.toHaveBeenCalled();
    expect(invalidateImagePastes).not.toHaveBeenCalled();
    expect(recordInputHistory).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits content, closes completions, records history, and clears input', () => {
    vi.useFakeTimers();
    const clearInput = vi.fn();
    const recordInputHistory = vi.fn();
    const close = vi.fn();
    const onSubmit = vi.fn();
    const invalidateCache = vi.fn();
    const invalidateImagePastes = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache,
        attachments: [createAttachment('a1')],
        hasPendingImagePastes: () => false,
        invalidateImagePastes,
        sdkStatusLoading: false,
        sdkInstalled: true,
        currentProvider: 'claude',
        clearInput,
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory,
        onSubmit,
        t: (key) => key,
      })
    );

    result.current();
    expect(invalidateCache).toHaveBeenCalled();
    expect(invalidateImagePastes).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(5);
    expect(recordInputHistory).toHaveBeenCalledWith('hello');
    expect(clearInput).toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello', [createAttachment('a1')]);
    vi.useRealTimers();
  });
});
