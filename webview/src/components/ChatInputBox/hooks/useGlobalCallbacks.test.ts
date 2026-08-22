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
  const renderQuoteTags = vi.fn();
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
      renderQuoteTags,
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
    renderQuoteTags,
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

  it('inserts external snippet at caret position when caret is inside editable', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('abc'));
    placeCaretInsideFirstTextNode(editable, 1);
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('XYZ');
    vi.runAllTimers();

    expect(getTextContent()).toBe('aXYZ bc');
  });

  it('falls back to appending at end when caret is not inside editable', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('draft question'));
    // Place caret outside editable to simulate external action (e.g. project tree right-click)
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('@/path/to/file');
    vi.runAllTimers();

    expect(getTextContent()).toBe('draft question\n@/path/to/file ');
  });

  it('does not wipe existing content when a stale non-collapsed selection exists (#1700)', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('existing draft'));
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    // Simulate the real repro: user selected text inside the box earlier, then went
    // back to the IDE editor and triggered "Add selection to CC GUI". The webview's
    // stale select-all range is still non-collapsed and still anchored in editable.
    editable.blur();
    const selectAll = document.createRange();
    selectAll.selectNodeContents(editable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selectAll);

    window.insertCodeSnippetAtCursor?.('@src/file.ts#L10-20');
    vi.runAllTimers();

    // The snippet is appended at the end; the pre-existing draft must survive.
    expect(getTextContent()).toBe('existing draft\n@src/file.ts#L10-20 ');
  });

  it('handleFilePathFromJava does not wipe content on stale non-collapsed selection (#1700)', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('existing draft'));
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    editable.blur();
    const selectAll = document.createRange();
    selectAll.selectNodeContents(editable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selectAll);

    window.handleFilePathFromJava?.('/abs/path/Helper.ts');
    vi.runAllTimers();

    expect(getTextContent()).toContain('existing draft');
    expect(getTextContent()).toContain('@/abs/path/Helper.ts ');
  });
});
