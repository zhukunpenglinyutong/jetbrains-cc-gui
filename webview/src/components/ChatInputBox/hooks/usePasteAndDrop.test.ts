import { useCallback, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { usePasteAndDrop } from './usePasteAndDrop.js';
import { useResetAttachmentsOnSessionChange } from './useResetAttachmentsOnSessionChange.js';
import { useSubmitHandler } from './useSubmitHandler.js';
import { BRIDGE_READY_EVENT } from '../../../utils/bridgeStartup.js';

const { fingerprint } = vi.hoisted(() => ({ fingerprint: vi.fn() }));

vi.mock('../utils/imagePasteDedupe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/imagePasteDedupe.js')>();
  return {
    ...actual,
    createImagePasteDedupe: () => actual.createImagePasteDedupe(undefined, fingerprint),
  };
});

function createEditable(): HTMLDivElement {
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  document.body.appendChild(editable);
  return editable;
}

function placeCaretAtEnd(editable: HTMLDivElement): void {
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function createPasteEvent(text: string): React.ClipboardEvent {
  return {
    clipboardData: {
      items: [{ kind: 'string', type: 'text/plain' }],
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent;
}

function setupPasteHook(
  editable: HTMLDivElement,
  setInternalAttachments: React.Dispatch<React.SetStateAction<Attachment[]>> =
    vi.fn() as unknown as React.Dispatch<React.SetStateAction<Attachment[]>>
) {
  const pathMappingRef = { current: new Map<string, string>() };
  const renderFileTags = vi.fn();
  const hook = renderHook(({ currentSessionId }) => usePasteAndDrop({
    currentSessionId,
    editableRef: { current: editable },
    pathMappingRef,
    getTextContent: () => editable.textContent ?? '',
    adjustHeight: vi.fn(),
    renderFileTags,
    setHasContent: vi.fn(),
    setInternalAttachments,
    onInput: vi.fn(),
    closeAllCompletions: vi.fn(),
    handleInput: vi.fn(),
    flushInput: vi.fn(),
  }), { initialProps: { currentSessionId: 'session-a' } });

  return { ...hook, pathMappingRef, renderFileTags, setInternalAttachments };
}

describe('usePasteAndDrop file references', () => {
  beforeEach(() => {
    // happy-dom does not implement the deprecated command used by the
    // production helper; returning false exercises its Range fallback.
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    Reflect.deleteProperty(document, 'execCommand');
    delete window.getClipboardFilePath;
  });

  it('registers and normalizes multiple explicit paths with spaces', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);

    result.current.handlePaste(createPasteEvent(
      '@C:\\Program Files\\demo\\view file.xml @/workspace/src/index.vue'
    ));

    expect(editable.textContent).toBe(
      '@C:\\Program Files\\demo\\view file.xml @/workspace/src/index.vue '
    );
    expect(pathMappingRef.current.get('view file.xml'))
      .toBe('C:\\Program Files\\demo\\view file.xml');
    expect(pathMappingRef.current.get('/workspace/src/index.vue'))
      .toBe('/workspace/src/index.vue');
  });

  it('keeps mixed ordinary text unchanged and does not register its @ text', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);
    const mixedText = 'const email = "user@example.com"; @/workspace/src/index.vue';

    result.current.handlePaste(createPasteEvent(mixedText));

    expect(editable.textContent).toBe(mixedText);
    expect(pathMappingRef.current.size).toBe(0);
  });

  it('keeps trailing prose after an absolute-looking reference unchanged', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);
    const mixedText = '@C:\\workspace\\view.xml please review';

    result.current.handlePaste(createPasteEvent(mixedText));

    expect(editable.textContent).toBe(mixedText);
    expect(pathMappingRef.current.size).toBe(0);
  });

  it('registers a pasted line reference with a spaced path', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);

    result.current.handlePaste(createPasteEvent(
      '@C:\\Program Files\\src\\Main.java#L10-12'
    ));

    expect(editable.textContent).toBe('@C:\\Program Files\\src\\Main.java#L10-12 ');
    expect(pathMappingRef.current.get('C:\\Program Files\\src\\Main.java#L10-12'))
      .toBe('C:\\Program Files\\src\\Main.java');
  });

  it('registers a real clipboard file returned by the Java bridge', async () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);
    window.getClipboardFilePath = vi.fn().mockResolvedValue(
      'C:\\Program Files\\demo\\view file.xml'
    );
    const event = {
      clipboardData: {
        items: [{ kind: 'file', type: 'application/xml' }],
        getData: () => '',
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => {
      result.current.handlePaste(event);
      await Promise.resolve();
    });

    expect(editable.textContent).toBe('@C:\\Program Files\\demo\\view file.xml ');
    expect(pathMappingRef.current.get('view file.xml'))
      .toBe('C:\\Program Files\\demo\\view file.xml');
  });
});

/** Collects the attachment state the hook writes, mirroring the real setter. */
function createAttachmentStore() {
  let attachments: Attachment[] = [];
  const setInternalAttachments = vi.fn((updater: unknown) => {
    attachments = typeof updater === 'function'
      ? (updater as (prev: Attachment[]) => Attachment[])(attachments)
      : (updater as Attachment[]);
  });

  return {
    getAttachments: () => attachments,
    setInternalAttachments:
      setInternalAttachments as unknown as React.Dispatch<React.SetStateAction<Attachment[]>>,
  };
}

/** Replaces happy-dom's asynchronous FileReader with a synchronous one. */
function stubSynchronousFileReader(): () => void {
  const originalFileReader = globalThis.FileReader;

  class MockFileReader {
    public result: string | null = 'data:image/png;base64,c2hvdA==';
    public onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

    readAsDataURL(this: FileReader): void {
      this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    }
  }

  // @ts-expect-error test override
  globalThis.FileReader = MockFileReader;

  return () => {
    globalThis.FileReader = originalFileReader;
  };
}

function createImagePasteEvent(file: File): React.ClipboardEvent {
  return {
    clipboardData: {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
      getData: () => '',
    },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent;
}

function stubDeferredFileReader() {
  let reader!: DeferredFileReader;
  class DeferredFileReader {
    result = 'data:image/png;base64,c2hvdA==';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    readAsDataURL() { reader = this; }
  }
  vi.stubGlobal('FileReader', DeferredFileReader);
  return {
    finish: () => reader.onload?.(),
    fail: () => reader.onerror?.(),
    abort: () => reader.onabort?.(),
  };
}

/** Exercises paste, session reset and submit against real React attachment state. */
function setupDraftHook(editable: HTMLDivElement) {
  const onSubmit = vi.fn<(content: string, attachments?: Attachment[]) => void>();
  const addToast = vi.fn();
  const clearInput = vi.fn(() => { editable.textContent = ''; });
  const clearAttachmentsDraft = vi.fn();
  const hook = renderHook(({ currentSessionId }) => {
    const [attachments, setInternalAttachments] = useState<Attachment[]>([]);
    const clearInternalAttachments = useCallback(() => {
      setInternalAttachments([]);
      clearAttachmentsDraft();
    }, []);
    useResetAttachmentsOnSessionChange({ currentSessionId, isControlled: false, clearInternalAttachments });
    const paste = usePasteAndDrop({
      currentSessionId,
      editableRef: { current: editable },
      pathMappingRef: { current: new Map<string, string>() },
      getTextContent: () => editable.textContent ?? '',
      adjustHeight: vi.fn(), renderFileTags: vi.fn(), setHasContent: vi.fn(),
      setInternalAttachments, closeAllCompletions: vi.fn(), handleInput: vi.fn(), flushInput: vi.fn(),
    });
    const completion = { close: vi.fn() };
    const submit = useSubmitHandler({
      getTextContent: () => editable.textContent ?? '',
      invalidateCache: vi.fn(), attachments, sdkStatusLoading: false, sdkInstalled: true,
      currentProvider: 'claude', clearInput, externalAttachments: undefined,
      setInternalAttachments, clearAttachmentsDraft,
      hasPendingImagePastes: paste.hasPendingImagePastes,
      invalidateImagePastes: paste.invalidateImagePastes,
      fileCompletion: completion, commandCompletion: completion, agentCompletion: completion,
      promptCompletion: completion, dollarCommandCompletion: completion,
      recordInputHistory: vi.fn(), onSubmit, addToast, t: (key) => key,
    });
    return { ...paste, attachments, submit };
  }, { initialProps: { currentSessionId: 'session-a' } });
  return { ...hook, onSubmit, addToast, clearInput, clearAttachmentsDraft };
}

describe('usePasteAndDrop clipboard images', () => {
  let restoreFileReader: () => void;

  beforeEach(() => {
    restoreFileReader = stubSynchronousFileReader();
    fingerprint.mockImplementation(async ({ data }: { data: string }) =>
      data === 'REENCODED' ? 'c2hvdA==' : data
    );
  });

  afterEach(() => {
    restoreFileReader();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fingerprint.mockReset();
    delete window.sendToJava;
    document.body.innerHTML = '';
  });

  function dispatchJavaPasteImage(base64: string | null, requestId?: string) {
    window.dispatchEvent(new CustomEvent('java-paste-image', {
      detail: { base64, mediaType: 'image/png', requestId },
    }));
  }

  function requestNativeImage(result: ReturnType<typeof setupDraftHook>['result']): string {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    act(() => result.current.handlePaste({
      clipboardData: { items: [], getData: () => '' },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent));
    const message = sendToJava.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/^paste_image:.+/);
    return message.slice('paste_image:'.length);
  }

  it('keeps native clipboard encoding in the submit guard before Java replies', async () => {
    vi.useFakeTimers();
    const editable = createEditable();
    editable.textContent = 'prompt';
    const { result, onSubmit, clearInput } = setupDraftHook(editable);
    const requestId = requestNativeImage(result);
    expect(result.current.hasPendingImagePastes()).toBe(true);
    act(() => result.current.submit());
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
    await act(async () => dispatchJavaPasteImage('c2hvdA==', requestId));
    expect(result.current.isPreparingImages).toBe(false);
    act(() => result.current.submit());
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit.mock.calls[0][1]?.map(({ data }) => data)).toEqual(['c2hvdA==']);
    delete window.sendToJava;
  });

  it('rejects a native reply that arrives after switching sessions and leaves new work pending', async () => {
    const editable = createEditable();
    const { result, rerender } = setupDraftHook(editable);
    const oldRequest = requestNativeImage(result);
    rerender({ currentSessionId: 'session-b' });
    const newRequest = requestNativeImage(result);
    await act(async () => dispatchJavaPasteImage('OLD', oldRequest));
    expect(result.current.attachments).toEqual([]);
    expect(result.current.hasPendingImagePastes()).toBe(true);
    await act(async () => dispatchJavaPasteImage('NEW', newRequest));
    expect(result.current.attachments.map(({ data }) => data)).toEqual(['NEW']);
    expect(result.current.hasPendingImagePastes()).toBe(false);
    delete window.sendToJava;
  });

  it('releases readiness when Java reports that the clipboard has no image', async () => {
    const editable = createEditable();
    const { result } = setupDraftHook(editable);
    const requestId = requestNativeImage(result);
    await act(async () => dispatchJavaPasteImage(null, requestId));
    expect(result.current.hasPendingImagePastes()).toBe(false);
    expect(result.current.attachments).toEqual([]);
    delete window.sendToJava;
  });

  it('forgets a timed-out native request and rejects its late reply', async () => {
    vi.useFakeTimers();
    const editable = createEditable();
    const { result } = setupDraftHook(editable);
    const requestId = requestNativeImage(result);
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(result.current.hasPendingImagePastes()).toBe(false);
    await act(async () => dispatchJavaPasteImage('LATE', requestId));
    expect(result.current.attachments).toEqual([]);
    delete window.sendToJava;
  });

  it('preserves paste order and the first encoding when FileReader finishes after the Java echo', async () => {
    const reader = stubDeferredFileReader();
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);
    act(() => result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' }))));
    await act(async () => dispatchJavaPasteImage('REENCODED'));
    expect(store.getAttachments()).toEqual([]);
    await act(async () => reader.finish());
    expect(store.getAttachments().map(({ data }) => data)).toEqual(['c2hvdA==']);
  });

  it('keeps the original replay window when FileReader finishes after it expires', async () => {
    vi.useFakeTimers();
    const reader = stubDeferredFileReader();
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);
    act(() => result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' }))));
    await act(() => vi.advanceTimersByTimeAsync(1100));
    await act(async () => dispatchJavaPasteImage('REENCODED'));
    await act(async () => reader.finish());
    expect(store.getAttachments().map(({ data }) => data)).toEqual(['c2hvdA==', 'REENCODED']);
  });

  it('claims a native action request synchronously before Java reads the clipboard', async () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    const { result } = setupDraftHook(createEditable());
    act(() => window.dispatchEvent(new CustomEvent('java-request-paste-image')));
    expect(result.current.hasPendingImagePastes()).toBe(true);
    const requestId = (sendToJava.mock.calls.find(([message]) => message.startsWith('paste_image:'))![0] as string)
      .slice('paste_image:'.length);
    await act(async () => dispatchJavaPasteImage('c2hvdA==', requestId));
    expect(result.current.attachments).toHaveLength(1);
  });

  it('attaches a single image when the Java bridge echoes the webview paste', async () => {
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);

    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    expect(store.getAttachments()).toHaveLength(1);

    await act(async () => {
      dispatchJavaPasteImage(store.getAttachments()[0].data);
    });

    expect(store.getAttachments()).toHaveLength(1);
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it('claims the captured native image without asking Java to read the clipboard again', async () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    const { result } = setupDraftHook(createEditable());
    const scopeId = sendToJava.mock.calls.find(([message]) => message.startsWith('paste_image_scope:'))![0]
      .slice('paste_image_scope:'.length);
    act(() => window.dispatchEvent(new CustomEvent('java-request-paste-image', {
      detail: { snapshotId: 'captured-image-a', scopeId },
    })));
    const request = JSON.parse(sendToJava.mock.calls.find(([message]) => message.startsWith('paste_image:'))![0]
      .slice('paste_image:'.length));
    expect(request.snapshotId).toBe('captured-image-a');
    expect(request.scopeId).toBe(scopeId);
    expect(result.current.hasPendingImagePastes()).toBe(true);
    await act(async () => dispatchJavaPasteImage('IMAGE_A', request.requestId));
    expect(result.current.attachments.map(({ data }) => data)).toEqual(['IMAGE_A']);
  });

  it.each(['session change', 'draft replacement'])(
    'rejects the first offer of an old native snapshot after %s',
    async (boundary) => {
      const sendToJava = vi.fn();
      window.sendToJava = sendToJava;
      const { result, rerender } = setupDraftHook(createEditable());
      const scopeMessage = sendToJava.mock.calls.find(([message]) => message.startsWith('paste_image_scope:'))?.[0];
      expect(scopeMessage).toBeTruthy();
      const scopeId = scopeMessage.slice('paste_image_scope:'.length);
      if (boundary === 'session change') rerender({ currentSessionId: 'session-b' });
      else act(() => result.current.invalidateImagePastes());
      act(() => window.dispatchEvent(new CustomEvent('java-request-paste-image', {
        detail: { snapshotId: 'old-snapshot', scopeId },
      })));
      const claimMessage = sendToJava.mock.calls.find(([message]) => message.startsWith('paste_image:'))?.[0];
      if (claimMessage) {
        const claim = JSON.parse(claimMessage.slice('paste_image:'.length));
        await act(async () => dispatchJavaPasteImage('OLD', claim.requestId));
      }
      expect(result.current.attachments).toEqual([]);
      expect(result.current.hasPendingImagePastes()).toBe(false);
      expect(claimMessage).toBeUndefined();
    },
  );

  it('keeps submission protected until prepared attachments commit to React', async () => {
    vi.useFakeTimers();
    const editable = createEditable();
    editable.textContent = 'prompt';
    const { result, onSubmit, clearInput } = setupDraftHook(editable);
    const requestId = requestNativeImage(result);
    await act(async () => {
      dispatchJavaPasteImage('IMAGE', requestId);
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(result.current.attachments).toEqual([]);
      result.current.submit();
    });
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
    expect(result.current.hasPendingImagePastes()).toBe(false);
    act(() => result.current.submit());
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('prompt', expect.arrayContaining([
      expect.objectContaining({ data: 'IMAGE' }),
    ]));
  });

  it('publishes only the current draft when Java becomes available after mount', async () => {
    const { result } = setupDraftHook(createEditable());
    act(() => result.current.invalidateImagePastes());
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    act(() => window.dispatchEvent(new Event(BRIDGE_READY_EVENT)));
    const scopeMessage = sendToJava.mock.calls.find(([message]) => message.startsWith('paste_image_scope:'))?.[0];
    expect(scopeMessage).toBeTruthy();
    act(() => window.dispatchEvent(new CustomEvent('java-request-paste-image', {
      detail: { snapshotId: 'captured-after-startup', scopeId: scopeMessage.slice('paste_image_scope:'.length) },
    })));
    const claim = JSON.parse(sendToJava.mock.calls.find(([message]) => message.startsWith('paste_image:'))![0]
      .slice('paste_image:'.length));
    await act(async () => dispatchJavaPasteImage('CURRENT', claim.requestId));
    expect(result.current.attachments.map(({ data }) => data)).toEqual(['CURRENT']);
  });

  it('collapses two identical Java deliveries into one attachment', async () => {
    const editable = createEditable();
    const store = createAttachmentStore();
    setupPasteHook(editable, store.setInternalAttachments);

    await act(async () => {
      dispatchJavaPasteImage('c2hvdA==');
      dispatchJavaPasteImage('c2hvdA==');
    });

    expect(store.getAttachments()).toHaveLength(1);
  });

  it('keeps a different Java image pasted 500ms after a DOM image', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);

    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    vi.mocked(Date.now).mockReturnValue(now + 500);
    await act(async () => {
      dispatchJavaPasteImage('DIFFERENT');
    });

    expect(store.getAttachments().map(({ data }) => data)).toEqual(['c2hvdA==', 'DIFFERENT']);
  });

  it('keeps a different DOM image pasted 500ms after a Java image', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);

    await act(async () => {
      dispatchJavaPasteImage('DIFFERENT');
    });
    vi.mocked(Date.now).mockReturnValue(now + 500);
    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });

    expect(store.getAttachments().map(({ data }) => data)).toEqual(['DIFFERENT', 'c2hvdA==']);
  });

  it('collapses re-encoded Java echoes without changing the original attachment', async () => {
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);

    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
      dispatchJavaPasteImage('REENCODED');
      dispatchJavaPasteImage('REENCODED');
    });

    expect(store.getAttachments().map(({ data }) => data)).toEqual(['c2hvdA==']);
  });

  it('collapses a DOM echo when the re-encoded Java image arrived first', async () => {
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);

    await act(async () => {
      dispatchJavaPasteImage('REENCODED');
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });

    expect(store.getAttachments().map(({ data }) => data)).toEqual(['REENCODED']);
  });

  it('keeps different images when pixel decoding fails', async () => {
    fingerprint.mockRejectedValue(new Error('unsupported format'));
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);

    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
      dispatchJavaPasteImage('DIFFERENT');
    });

    expect(store.getAttachments()).toHaveLength(2);
  });

  it('rejects a pending decoded image after the mounted input switches sessions', async () => {
    let resolveFingerprint!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { resolveFingerprint = resolve; });
    fingerprint.mockImplementation(({ data }: { data: string }) =>
      data === 'DIFFERENT' ? pending : Promise.resolve('original')
    );
    const editable = createEditable();
    const { result, rerender } = setupDraftHook(editable);
    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    await act(async () => dispatchJavaPasteImage('DIFFERENT'));
    expect(result.current.isPreparingImages).toBe(true);

    rerender({ currentSessionId: 'session-b' });
    expect(result.current.attachments).toEqual([]);
    expect(result.current.isPreparingImages).toBe(false);
    await act(async () => resolveFingerprint('different-pixels'));
    expect(result.current.attachments).toEqual([]);
  });

  it('captures session ownership before a delayed FileReader starts', async () => {
    const reader = stubDeferredFileReader();
    const editable = createEditable();
    const { result, rerender } = setupDraftHook(editable);
    act(() => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    expect(result.current.hasPendingImagePastes()).toBe(true);
    rerender({ currentSessionId: 'session-b' });
    await act(async () => reader.finish());
    expect(result.current.attachments).toEqual([]);
    expect(result.current.isPreparingImages).toBe(false);
  });

  it('keeps the draft intact until pending comparisons finish and sends both images on retry', async () => {
    vi.useFakeTimers();
    let resolveFingerprint!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { resolveFingerprint = resolve; });
    fingerprint.mockImplementation(({ data }: { data: string }) =>
      data === 'DIFFERENT' ? pending : Promise.resolve('original')
    );
    const editable = createEditable();
    editable.textContent = 'prompt';
    const { result, onSubmit, addToast, clearInput } = setupDraftHook(editable);
    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    await act(async () => dispatchJavaPasteImage('DIFFERENT'));
    act(() => result.current.submit());
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(addToast).toHaveBeenCalledWith('common.loading', 'info');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
    expect(editable.textContent).toBe('prompt');
    expect(result.current.attachments).toHaveLength(1);

    await act(async () => resolveFingerprint('different-pixels'));
    expect(result.current.isPreparingImages).toBe(false);
    act(() => result.current.submit());
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('prompt');
    expect(onSubmit.mock.calls[0][1]?.map(({ data }) => data)).toEqual(['c2hvdA==', 'DIFFERENT']);
    expect(result.current.attachments).toEqual([]);

    // A new draft can immediately paste the same image without inheriting the old replay window.
    await act(async () => dispatchJavaPasteImage('c2hvdA=='));
    expect(result.current.attachments).toHaveLength(1);
  });

  it('blocks a submit before React publishes the pending FileReader state', async () => {
    vi.useFakeTimers();
    const reader = stubDeferredFileReader();
    const editable = createEditable();
    editable.textContent = 'prompt';
    const { result, onSubmit, clearInput } = setupDraftHook(editable);
    act(() => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
      result.current.submit();
    });
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
    await act(async () => reader.finish());
    act(() => result.current.submit());
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(onSubmit.mock.calls[0][1]).toHaveLength(1);
    expect(result.current.attachments).toEqual([]);
  });

  it('invalidates a replaced draft and its replay history without letting old work refill it', async () => {
    let resolveFingerprint!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { resolveFingerprint = resolve; });
    fingerprint.mockImplementation(({ data }: { data: string }) =>
      data === 'DIFFERENT' ? pending : Promise.resolve('original')
    );
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result } = setupPasteHook(editable, store.setInternalAttachments);
    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    await act(async () => dispatchJavaPasteImage('DIFFERENT'));
    act(() => {
      result.current.invalidateImagePastes();
      store.setInternalAttachments([]);
    });
    await act(async () => resolveFingerprint('different-pixels'));
    expect(store.getAttachments()).toEqual([]);
    expect(result.current.hasPendingImagePastes()).toBe(false);
    await act(async () => dispatchJavaPasteImage('c2hvdA=='));
    expect(store.getAttachments()).toHaveLength(1);
  });

  it('does not let an old decoder clear the next session\'s pending image state', async () => {
    let resolveFingerprint!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { resolveFingerprint = resolve; });
    fingerprint.mockImplementation(({ data }: { data: string }) =>
      data === 'DIFFERENT' ? pending : Promise.resolve('original')
    );
    const editable = createEditable();
    const { result, rerender } = setupDraftHook(editable);
    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    await act(async () => dispatchJavaPasteImage('DIFFERENT'));
    rerender({ currentSessionId: 'session-b' });
    const reader = stubDeferredFileReader();
    act(() => {
      result.current.handlePaste(createImagePasteEvent(new File(['next'], 'next.png', { type: 'image/png' })));
    });
    await act(async () => resolveFingerprint('different-pixels'));
    expect(result.current.isPreparingImages).toBe(true);
    expect(result.current.hasPendingImagePastes()).toBe(true);
    expect(result.current.attachments).toEqual([]);
    await act(async () => reader.finish());
    expect(result.current.isPreparingImages).toBe(false);
    expect(result.current.attachments).toHaveLength(1);
  });

  it.each(['fail', 'abort'] as const)('releases pending submission protection when FileReader reports %s', async (outcome) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reader = stubDeferredFileReader();
    const editable = createEditable();
    const { result } = setupDraftHook(editable);
    act(() => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    await act(async () => reader[outcome]());
    expect(result.current.hasPendingImagePastes()).toBe(false);
    expect(result.current.isPreparingImages).toBe(false);
    expect(result.current.attachments).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps intentional identical image drops instead of treating them as clipboard echoes', async () => {
    const editable = createEditable();
    const { result } = setupDraftHook(editable);
    const file = new File(['shot'], 'shot.png', { type: 'image/png' });
    await act(async () => result.current.handleDrop({
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
      dataTransfer: { getData: () => '', files: [file, file] },
    } as unknown as React.DragEvent));
    expect(result.current.attachments).toHaveLength(2);
    expect(result.current.isPreparingImages).toBe(false);
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it.each(['c2hvdA==', 'REENCODED'])('keeps deliberate DOM A/B/A after a %s Java echo', async (echo) => {
    vi.stubGlobal('FileReader', class {
      result = '';
      onload: (() => void) | null = null;
      readAsDataURL(file: File) {
        this.result = `data:image/png;base64,${file.name === 'a.png' ? 'c2hvdA==' : 'DIFFERENT'}`;
        this.onload?.();
      }
    });
    const editable = createEditable();
    const { result } = setupDraftHook(editable);
    const paste = (name: string) => result.current.handlePaste(
      createImagePasteEvent(new File(['image'], name, { type: 'image/png' }))
    );
    await act(async () => paste('a.png'));
    await act(async () => dispatchJavaPasteImage(echo));
    await act(async () => paste('b.png'));
    await act(async () => paste('a.png'));
    expect(result.current.attachments.map(({ data }) => data)).toEqual(['c2hvdA==', 'DIFFERENT', 'c2hvdA==']);
  });

  it('does not append a decoded image after the input box unmounts', async () => {
    let resolveFingerprint!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { resolveFingerprint = resolve; });
    fingerprint.mockImplementation(({ data }: { data: string }) =>
      data === 'DIFFERENT' ? pending : Promise.resolve('original')
    );
    const editable = createEditable();
    const store = createAttachmentStore();
    const { result, unmount } = setupPasteHook(editable, store.setInternalAttachments);

    await act(async () => {
      result.current.handlePaste(createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' })));
    });
    await act(async () => {
      dispatchJavaPasteImage('DIFFERENT');
    });
    unmount();
    await act(async () => {
      resolveFingerprint('different-pixels');
    });

    expect(store.getAttachments().map(({ data }) => data)).toEqual(['c2hvdA==']);
  });
});
