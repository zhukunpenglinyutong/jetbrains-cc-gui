import { renderHook } from '@testing-library/react';
import { useTextContent } from './useTextContent.js';

describe('useTextContent', () => {
  it('does not reuse cached text when different HTML has the same length', () => {
    const editable = document.createElement('div');
    document.body.appendChild(editable);
    const editableRef = { current: editable };
    const { result } = renderHook(() => useTextContent({ editableRef }));

    editable.innerHTML = '<span>alpha</span>';
    expect(result.current.getTextContent()).toBe('alpha');

    // The two HTML strings have the same length. A length-only cache returns
    // the stale first value here, which made icon-dependent tag rendering flaky.
    editable.innerHTML = '<span>bravo</span>';
    expect(result.current.getTextContent()).toBe('bravo');

    document.body.removeChild(editable);
  });
});
