import { renderHook } from '@testing-library/react';
import { useGlobalCallbacks } from './useGlobalCallbacks.js';

function createEditable(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  document.body.appendChild(el);

  if (typeof (el as HTMLDivElement & { innerText?: string }).innerText === 'undefined') {
    Object.defineProperty(el, 'innerText', {
      get() {
        return readEditableText(this as HTMLDivElement);
      },
      set(value: string) {
        this.textContent = value;
      },
      configurable: true,
    });
  }

  return el;
}

function readEditableText(element: HTMLDivElement): string {
  let text = '';
  element.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (node.nodeName === 'BR') {
      text += '\n';
    }
  });
  return text;
}

function placeCaretInsideFirstTextNode(element: HTMLDivElement, offset: number): void {
  const textNode = element.firstChild;
  if (!textNode) {
    throw new Error('editable has no text node');
  }
  const range = document.createRange();
  range.setStart(textNode, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderUseGlobalCallbacks(editable: HTMLDivElement) {
  const pathMappingRef = { current: new Map<string, string>() };
  const setHasContent = vi.fn();
  const adjustHeight = vi.fn();
  const renderFileTags = vi.fn();
  const onInput = vi.fn();
  const closeAllCompletions = vi.fn();
  const focusInput = vi.fn(() => editable.focus());
  const getTextContent = () => readEditableText(editable);

  renderHook(() =>
    useGlobalCallbacks({
      editableRef: { current: editable },
      pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags,
      setHasContent,
      onInput,
      closeAllCompletions,
      focusInput,
    })
  );

  return {
    getTextContent,
    setHasContent,
    adjustHeight,
    renderFileTags,
    onInput,
  };
}

describe('useGlobalCallbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete window.insertCodeSnippetAtCursor;
    delete window.handleFilePathFromJava;
    document.body.innerHTML = '';
  });

  it('appends external snippet directly when input is empty', () => {
    const editable = createEditable();
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('console payload');
    vi.runAllTimers();

    expect(getTextContent()).toBe('console payload ');
  });

  it('appends external snippet on a new line when input already has content', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('draft question'));
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('console payload');
    vi.runAllTimers();

    expect(getTextContent()).toBe('draft question\nconsole payload ');
  });

  it('ignores caret position and appends external snippet to the end', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('abc'));
    placeCaretInsideFirstTextNode(editable, 1);
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('XYZ');
    vi.runAllTimers();

    expect(getTextContent()).toBe('abc\nXYZ ');
  });
});
