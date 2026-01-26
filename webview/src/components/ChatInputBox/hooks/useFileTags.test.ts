import { renderHook } from '@testing-library/react';
import { useFileTags } from './useFileTags.js';

function createEditable() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el as HTMLDivElement;
}

describe('useFileTags', () => {
  it('renders file tags for valid references', () => {
    const editable = createEditable();
    editable.textContent = '@src/a.ts ';

    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
      rangeCount: 0,
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);

    const { result } = renderHook(() =>
      useFileTags({
        editableRef: { current: editable },
        getTextContent: () => editable.textContent ?? '',
        onCloseCompletions: vi.fn(),
      })
    );

    result.current.pathMappingRef.current.set('src/a.ts', 'C:\\src\\a.ts');
    result.current.renderFileTags();

    expect(editable.querySelectorAll('.file-tag').length).toBe(1);
    expect(result.current.extractFileTags()).toEqual([
      { displayPath: 'src/a.ts', absolutePath: 'C:\\src\\a.ts' },
    ]);

    const close = editable.querySelector('.file-tag-close') as HTMLElement;
    close.click();
    expect(editable.querySelectorAll('.file-tag').length).toBe(0);
  });

  it('does not render tags for unknown references', () => {
    const editable = createEditable();
    editable.textContent = '@unknown/file.ts ';

    const { result } = renderHook(() =>
      useFileTags({
        editableRef: { current: editable },
        getTextContent: () => editable.textContent ?? '',
        onCloseCompletions: vi.fn(),
      })
    );

    result.current.renderFileTags();
    expect(editable.querySelectorAll('.file-tag').length).toBe(0);
  });
});

