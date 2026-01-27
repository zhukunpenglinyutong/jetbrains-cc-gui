import { renderHook } from '@testing-library/react';
import type { ChatInputBoxHandle } from '../types.js';
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
  it('exposes getValue/setValue/hasContent', () => {
    const editable = createEditable();
    const refObj: { current: ChatInputBoxHandle | null } = { current: null };
    const invalidateCache = vi.fn();
    const isExternalUpdateRef = { current: false };
    const setHasContent = vi.fn();
    const adjustHeight = vi.fn();
    const focusInput = vi.fn();
    const clearInput = vi.fn();

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
        isExternalUpdateRef,
        setHasContent,
        adjustHeight,
        focusInput,
        clearInput,
        hasContent: false,
        extractFileTags: () => [],
      })
    );

    expect(refObj.current).not.toBeNull();
    refObj.current!.setValue('abc');
    expect(editable.innerText).toBe('abc');
    expect(isExternalUpdateRef.current).toBe(true);
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
  });
});

