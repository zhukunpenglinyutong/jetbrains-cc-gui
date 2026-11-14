import { useCallback, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useChatInputTextPipeline } from './useChatInputTextPipeline.js';
import { useControlledValueSync } from './useControlledValueSync.js';

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

describe('useControlledValueSync', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('syncs external value into DOM when changed', () => {
    const editable = createEditable();
    const setHasContent = vi.fn();
    const adjustHeight = vi.fn();
    const invalidateCache = vi.fn();
    const isComposingRef = { current: false };

    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);

    const { rerender } = renderHook(
      ({ value }: { value: string | undefined }) => {
        useControlledValueSync({
          value,
          editableRef: { current: editable },
          isComposingRef,
          getTextContent: () => editable.innerText,
          setHasContent,
          adjustHeight,
          invalidateCache,
          cancelPendingInput: vi.fn(),
        });
      },
      { initialProps: { value: undefined as string | undefined } }
    );

    rerender({ value: 'hello' });
    expect(editable.innerText).toBe('hello');
    expect(setHasContent).toHaveBeenCalledWith(true);
    expect(adjustHeight).toHaveBeenCalled();
  });

  it('renders the rich references after replacing the draft externally', () => {
    const editable = createEditable();
    const renderTags = vi.fn();

    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);

    const { rerender } = renderHook(
      ({ value }: { value: string | undefined }) => {
        useControlledValueSync({
          value,
          editableRef: { current: editable },
          isComposingRef: { current: false },
          getTextContent: () => editable.innerText,
          setHasContent: vi.fn(),
          adjustHeight: vi.fn(),
          invalidateCache: vi.fn(),
          cancelPendingInput: vi.fn(),
          renderTags,
        });
      },
      { initialProps: { value: undefined as string | undefined } }
    );

    rerender({ value: '@D:/demo.ts#L3 what is this' });

    // The external value is written as plain text, so the chip rendering has to
    // run afterwards or the draft keeps showing the raw @path.
    expect(editable.innerText).toBe('@D:/demo.ts#L3 what is this');
    expect(renderTags).toHaveBeenCalledOnce();
  });

  it('does not sync while composing', () => {
    const editable = createEditable();
    editable.innerText = 'old';
    const setHasContent = vi.fn();
    const adjustHeight = vi.fn();
    const invalidateCache = vi.fn();
    const isComposingRef = { current: true };

    renderHook(() =>
      useControlledValueSync({
        value: 'new',
        editableRef: { current: editable },
        isComposingRef,
        getTextContent: () => editable.innerText,
        setHasContent,
        adjustHeight,
        invalidateCache,
        cancelPendingInput: vi.fn(),
      })
    );

    expect(editable.innerText).toBe('old');
  });

  it('does not sync while editable element has focus', () => {
    const editable = createEditable();
    editable.setAttribute('contenteditable', 'true');
    editable.innerText = 'typing in progress';
    editable.focus();
    const setHasContent = vi.fn();
    const adjustHeight = vi.fn();
    const invalidateCache = vi.fn();
    const isComposingRef = { current: false };

    renderHook(() =>
      useControlledValueSync({
        value: 'stale value from parent',
        editableRef: { current: editable },
        isComposingRef,
        getTextContent: () => editable.innerText,
        setHasContent,
        adjustHeight,
        invalidateCache,
        cancelPendingInput: vi.fn(),
      })
    );

    // Should NOT overwrite — DOM is source of truth while user is typing
    expect(editable.innerText).toBe('typing in progress');
    expect(setHasContent).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'keeps an external replacement when an older input callback is pending (callback changes: %s)',
    (replaceCallback) => {
      vi.useFakeTimers();
      const editable = createEditable();
      const editableRef = { current: editable };
      const setHasContent = vi.fn();
      const onInput = vi.fn();
      const { result } = renderHook(() => {
        const [value, setValue] = useState('');
        const [callbackVersion, setCallbackVersion] = useState(0);
        const handleInput = useCallback((text: string) => {
          onInput(callbackVersion, text);
          setValue(text);
        }, [callbackVersion]);
        const pipeline = useChatInputTextPipeline({
          editableRef,
          setHasContent,
          onInput: handleInput,
          currentProvider: 'claude',
        });
        useControlledValueSync({
          value,
          editableRef,
          isComposingRef: pipeline.isComposingRef,
          getTextContent: pipeline.getTextContent,
          setHasContent,
          adjustHeight: pipeline.adjustHeight,
          invalidateCache: pipeline.invalidateCache,
          cancelPendingInput: pipeline.cancelPendingInput,
        });
        return { ...pipeline, value, setValue, setCallbackVersion };
      });

      act(() => {
        editable.innerText = 'old draft';
        result.current.handleInput();
      });
      act(() => {
        result.current.setValue('replacement');
        if (replaceCallback) result.current.setCallbackVersion(1);
      });
      expect(editable.innerText).toBe('replacement');

      act(() => vi.advanceTimersByTime(100));
      expect(onInput).not.toHaveBeenCalled();
      expect(result.current.value).toBe('replacement');
      expect(editable.innerText).toBe('replacement');

      act(() => {
        editable.innerText = 'replacement!';
        result.current.handleInput();
        result.current.flushPendingInput();
      });
      expect(result.current.value).toBe('replacement!');
      expect(onInput).toHaveBeenCalledExactlyOnceWith(replaceCallback ? 1 : 0, 'replacement!');
    }
  );

  it('keeps pending input when only the parent callback changes', () => {
    vi.useFakeTimers();
    const editable = createEditable();
    const editableRef = { current: editable };
    const setHasContent = vi.fn();
    const previousOnInput = vi.fn();
    const nextOnInput = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ onInput }) => useChatInputTextPipeline({
        editableRef,
        setHasContent,
        onInput,
        currentProvider: 'claude',
      }),
      { initialProps: { onInput: previousOnInput } }
    );

    act(() => {
      editable.innerText = 'pending draft';
      result.current.handleInput();
    });
    rerender({ onInput: nextOnInput });
    act(() => vi.advanceTimersByTime(100));
    expect(previousOnInput).not.toHaveBeenCalled();
    expect(nextOnInput).toHaveBeenCalledExactlyOnceWith('pending draft');

    act(() => {
      editable.innerText = 'preserve on unmount';
      result.current.handleInput();
    });
    unmount();
    expect(nextOnInput).toHaveBeenLastCalledWith('preserve on unmount');
    act(() => vi.advanceTimersByTime(100));
    expect(nextOnInput).toHaveBeenCalledTimes(2);
  });

  it('forwards the first user input after an external value sync', () => {
    vi.useFakeTimers();
    const editable = createEditable();
    const editableRef = { current: editable };
    const setHasContent = vi.fn();
    const onInput = vi.fn();

    const { result, rerender } = renderHook(
      ({ value }: { value: string | undefined }) => {
        const pipeline = useChatInputTextPipeline({
          editableRef,
          setHasContent,
          onInput,
          currentProvider: 'claude',
        });
        useControlledValueSync({
          value,
          editableRef,
          isComposingRef: pipeline.isComposingRef,
          getTextContent: pipeline.getTextContent,
          setHasContent,
          adjustHeight: pipeline.adjustHeight,
          invalidateCache: pipeline.invalidateCache,
          cancelPendingInput: pipeline.cancelPendingInput,
        });
        return pipeline;
      },
      { initialProps: { value: undefined as string | undefined } }
    );

    rerender({ value: 'hello' });
    editable.innerText = 'hellox';

    act(() => {
      result.current.handleInput();
      result.current.flushPendingInput();
    });

    expect(onInput).toHaveBeenCalledWith('hellox');
    vi.useRealTimers();
  });
});
