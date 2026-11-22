import { act, cleanup, renderHook } from '@testing-library/react';
import type { ChatInputBoxHandle } from '../types.js';
import { useChatInputTextPipeline } from './useChatInputTextPipeline.js';
import { useChatInputImperativeHandle } from './useChatInputImperativeHandle.js';

function createEditable() {
  const el = document.createElement('div');
  document.body.appendChild(el);

  if (typeof (el as unknown as { innerText?: unknown }).innerText === 'undefined') {
    Object.defineProperty(el, 'innerText', {
      get() {
        return this.textContent ?? '';
      },
      set(value: string) {
        this.textContent = value;
      },
      configurable: true,
    });
  }

  return el as HTMLDivElement;
}

describe('useChatInputImperativeHandle', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('cancels pending input when setValue replaces the text', () => {
    vi.useFakeTimers();
    const editable = createEditable();
    const editableRef = { current: editable };
    const refObj: { current: ChatInputBoxHandle | null } = { current: null };
    const setHasContent = vi.fn();
    const onInput = vi.fn();
    const { result } = renderHook(() => {
      const pipeline = useChatInputTextPipeline({
        editableRef,
        setHasContent,
        onInput,
        currentProvider: 'claude',
      });
      useChatInputImperativeHandle({
        ref: refObj,
        editableRef,
        getTextContent: pipeline.getTextContent,
        invalidateCache: pipeline.invalidateCache,
        cancelPendingInput: pipeline.cancelPendingInput,
        setHasContent,
        adjustHeight: pipeline.adjustHeight,
        focusInput: vi.fn(),
        clearInput: pipeline.clearInput,
        hasContent: false,
        extractFileTags: pipeline.extractFileTags,
        getAttachments: () => [],
        setAttachments: vi.fn(),
      });
      return pipeline;
    });

    act(() => {
      editable.innerText = 'old draft';
      result.current.handleInput();
      refObj.current!.setValue('replacement');
      result.current.flushPendingInput();
    });
    expect(editable.innerText).toBe('replacement');
    expect(onInput).not.toHaveBeenCalled();

    act(() => {
      editable.innerText = 'replacement!';
      result.current.handleInput();
      result.current.flushPendingInput();
    });
    expect(onInput).toHaveBeenCalledExactlyOnceWith('replacement!');
  });

  it('exposes getValue/setValue/hasContent and draft attachment access', () => {
    const editable = createEditable();
    const refObj: { current: ChatInputBoxHandle | null } = { current: null };
    const invalidateCache = vi.fn();
    const setHasContent = vi.fn();
    const adjustHeight = vi.fn();
    const focusInput = vi.fn();
    const clearInput = vi.fn();
    const cancelPendingInput = vi.fn();
    const attachment = { id: 'att-1', fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' };
    let draftAttachments = [attachment];
    const setAttachments = vi.fn((next: typeof draftAttachments): boolean => {
      draftAttachments = next;
      return true;
    });

    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);

    renderHook(() =>
      useChatInputImperativeHandle({
        ref: refObj,
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        invalidateCache,
        cancelPendingInput,
        setHasContent,
        adjustHeight,
        focusInput,
        clearInput,
        hasContent: false,
        extractFileTags: () => [],
        getAttachments: () => draftAttachments,
        setAttachments,
      })
    );

    expect(refObj.current).not.toBeNull();
    refObj.current!.setValue('abc');
    expect(cancelPendingInput).toHaveBeenCalledOnce();
    expect(editable.innerText).toBe('abc');
    expect(setHasContent).toHaveBeenCalledWith(true);
    expect(adjustHeight).toHaveBeenCalled();

    const v = refObj.current!.getValue();
    expect(invalidateCache).toHaveBeenCalled();
    expect(v).toBe('abc');

    expect(refObj.current!.hasContent()).toBe(false);
    refObj.current!.focus();
    expect(focusInput).toHaveBeenCalled();
    refObj.current!.clear();
    expect(clearInput).toHaveBeenCalled();

    expect(refObj.current!.getAttachments()).toEqual([attachment]);
    const replacement = { id: 'att-2', fileName: 'pic.png', mediaType: 'image/png', data: 'aW1n' };
    // The boolean tells the queue-edit restore whether the attachments landed.
    expect(refObj.current!.setAttachments([replacement])).toBe(true);
    expect(setAttachments).toHaveBeenCalledExactlyOnceWith([replacement]);
    expect(refObj.current!.getAttachments()).toEqual([replacement]);
    // Without a paste tracker nothing can be pending.
    expect(refObj.current!.hasPendingImagePastes()).toBe(false);
  });

  it('reports image pastes that have not reached the draft yet', () => {
    const refObj: { current: ChatInputBoxHandle | null } = { current: null };
    let pending = true;

    renderHook(() =>
      useChatInputImperativeHandle({
        ref: refObj,
        editableRef: { current: createEditable() },
        getTextContent: () => '',
        invalidateCache: vi.fn(),
        cancelPendingInput: vi.fn(),
        setHasContent: vi.fn(),
        adjustHeight: vi.fn(),
        focusInput: vi.fn(),
        clearInput: vi.fn(),
        hasContent: false,
        extractFileTags: () => [],
        getAttachments: () => [],
        setAttachments: vi.fn(),
        hasPendingImagePastes: () => pending,
      })
    );

    expect(refObj.current!.hasPendingImagePastes()).toBe(true);
    pending = false;
    expect(refObj.current!.hasPendingImagePastes()).toBe(false);
  });

  it('renders the rich references after setValue replaced the text', () => {
    const editable = createEditable();
    const refObj: { current: ChatInputBoxHandle | null } = { current: null };
    const renderTags = vi.fn();

    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);

    renderHook(() =>
      useChatInputImperativeHandle({
        ref: refObj,
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        invalidateCache: vi.fn(),
        cancelPendingInput: vi.fn(),
        setHasContent: vi.fn(),
        adjustHeight: vi.fn(),
        focusInput: vi.fn(),
        clearInput: vi.fn(),
        hasContent: false,
        extractFileTags: () => [],
        getAttachments: () => [],
        setAttachments: vi.fn(),
        renderTags,
      })
    );

    refObj.current!.setValue('@D:/code/demo.ts#L3 what is this');

    // The text itself is written as plain text, so the tag rendering has to
    // run afterwards to turn the @reference back into a rendered chip.
    expect(editable.innerText).toBe('@D:/code/demo.ts#L3 what is this');
    expect(renderTags).toHaveBeenCalledOnce();
  });
});

