import { renderHook } from '@testing-library/react';
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
  it('syncs external value into DOM when changed', () => {
    const editable = createEditable();
    const setHasContent = vi.fn();
    const adjustHeight = vi.fn();
    const invalidateCache = vi.fn();
    const isComposingRef = { current: false };
    const isExternalUpdateRef = { current: false };

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
          isExternalUpdateRef,
          getTextContent: () => editable.innerText,
          setHasContent,
          adjustHeight,
          invalidateCache,
        });
      },
      { initialProps: { value: undefined as string | undefined } }
    );

    rerender({ value: 'hello' });
    expect(editable.innerText).toBe('hello');
    expect(setHasContent).toHaveBeenCalledWith(true);
    expect(adjustHeight).toHaveBeenCalled();
    expect(isExternalUpdateRef.current).toBe(true);
  });

  it('does not sync while composing', () => {
    const editable = createEditable();
    editable.innerText = 'old';
    const setHasContent = vi.fn();
    const adjustHeight = vi.fn();
    const invalidateCache = vi.fn();
    const isComposingRef = { current: true };
    const isExternalUpdateRef = { current: false };

    renderHook(() =>
      useControlledValueSync({
        value: 'new',
        editableRef: { current: editable },
        isComposingRef,
        isExternalUpdateRef,
        getTextContent: () => editable.innerText,
        setHasContent,
        adjustHeight,
        invalidateCache,
      })
    );

    expect(editable.innerText).toBe('old');
  });
});
