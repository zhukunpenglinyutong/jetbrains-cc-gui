import { act, cleanup, renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import { useTextContent } from './useTextContent.js';
import { makeQuoteToken } from '../utils/quoteRegistry.js';
import { useChatInputTextPipeline } from './useChatInputTextPipeline.js';
import { DRAFT_FLUSH_EVENT } from '../../../contexts/draftStorage';

describe('useTextContent', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('flushes unpublished keystrokes before native browser recovery checkpoints the input', () => {
    vi.useFakeTimers();
    const editableRef = { current: document.createElement('div') };
    const onInput = vi.fn();
    const { result } = renderHook(() => useChatInputTextPipeline({
      editableRef, onInput, setHasContent: vi.fn(), currentProvider: 'claude',
    }));
    act(() => {
      editableRef.current.textContent = '尚未经过防抖的输入';
      result.current.handleInput('insertText');
    });
    expect(onInput).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event(DRAFT_FLUSH_EVENT, { cancelable: true })); });
    expect(onInput).toHaveBeenCalledExactlyOnceWith('尚未经过防抖的输入');
  });

  it('vetoes browser replacement during an unfinished IME composition', () => {
    vi.useFakeTimers();
    const editableRef = { current: document.createElement('div') };
    const onInput = vi.fn();
    const { result } = renderHook(() => useChatInputTextPipeline({
      editableRef, onInput, setHasContent: vi.fn(), currentProvider: 'claude',
    }));
    act(() => {
      result.current.handleCompositionStart();
      editableRef.current.textContent = '组合输入';
      result.current.handleInput('insertCompositionText');
    });
    let accepted = true;
    act(() => { accepted = window.dispatchEvent(new Event(DRAFT_FLUSH_EVENT, { cancelable: true })); });
    expect(accepted).toBe(false);
    expect(onInput).not.toHaveBeenCalled();
  });

  it('extracts once per content version without serializing large HTML', () => {
    const editable = document.createElement('div');
    const textNode = document.createTextNode('大段粘贴\n'.repeat(20_000));
    editable.append(textNode);
    const { result } = renderHook(() => useTextContent({ editableRef: { current: editable } }));
    const htmlReads = vi.spyOn(editable, 'innerHTML', 'get');
    const textReads = vi.spyOn(textNode, 'textContent', 'get');

    for (let version = 0; version < 30; version += 1) {
      textNode.data += '字';
      result.current.invalidateCache();
      for (let read = 0; read < 4; read += 1) {
        expect(result.current.getTextContent()).toBe(textNode.data);
      }
    }

    expect(textReads).toHaveBeenCalledTimes(30);
    expect(htmlReads).not.toHaveBeenCalled();
  });

  it('keeps selection and layout-only changes on the same cached version', () => {
    const editable = document.createElement('div');
    const textNode = document.createTextNode('选中文本');
    editable.append(textNode);
    document.body.append(editable);
    const { result } = renderHook(() => useTextContent({ editableRef: { current: editable } }));
    const textReads = vi.spyOn(textNode, 'textContent', 'get');
    expect(result.current.getTextContent()).toBe('选中文本');
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.setEnd(textNode, 3);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    editable.style.height = 'auto';
    expect(result.current.getTextContent()).toBe('选中文本');
    expect(textReads).toHaveBeenCalledTimes(1);
    expect(window.getSelection()!.toString()).toBe('中文');
  });

  it('observes synchronous edits, multiline paste, tags, undo, redo and clearing', () => {
    const editable = document.createElement('div');
    const { result } = renderHook(() => useTextContent({ editableRef: { current: editable } }));
    expect(result.current.getTextContent()).toBe('');
    editable.innerHTML = '首行<div>第二行</div><br>';
    expect(result.current.getTextContent()).toBe('首行\n第二行\n');
    editable.innerHTML = '<span class="file-tag" data-file-path="src/a.ts">a.ts ×</span><span class="quote-tag" data-quote-id="quote-a">preview ×</span>';
    expect(result.current.getTextContent()).toBe(`@src/a.ts${makeQuoteToken('quote-a')}`);
    editable.firstElementChild!.setAttribute('data-file-path', 'src/b.ts');
    editable.lastElementChild!.setAttribute('data-quote-id', 'quote-b');
    expect(result.current.getTextContent()).toBe(`@src/b.ts${makeQuoteToken('quote-b')}`);
    editable.firstElementChild!.remove();
    expect(result.current.getTextContent()).toBe(makeQuoteToken('quote-b'));
    for (const text of ['拼', '拼音', '拼', '拼音', '']) {
      editable.textContent = text;
      expect(result.current.getTextContent()).toBe(text);
    }
  });

  it('does not re-extract after pending mutations were already read', async () => {
    const editable = document.createElement('div');
    const textNode = document.createTextNode('before');
    editable.append(textNode);
    const { result } = renderHook(() => useTextContent({ editableRef: { current: editable } }));
    result.current.getTextContent();
    const textReads = vi.spyOn(textNode, 'textContent', 'get');
    textNode.data = 'after';
    expect(result.current.getTextContent()).toBe('after');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(result.current.getTextContent()).toBe('after');
    expect(textReads).toHaveBeenCalledTimes(1);
  });

  it('refreshes after observer delivery and ref replacement and disconnects on unmount', async () => {
    const editableRef = { current: document.createElement('div') as HTMLDivElement | null };
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { result, unmount } = renderHook(() => useTextContent({ editableRef }));
    result.current.getTextContent();
    editableRef.current!.textContent = 'updated';
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(result.current.getTextContent()).toBe('updated');
    editableRef.current = document.createElement('div');
    editableRef.current.textContent = 'replacement';
    expect(result.current.getTextContent()).toBe('replacement');
    editableRef.current = null;
    expect(result.current.getTextContent()).toBe('');
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not reconnect an observer when the input pipeline reads its draft during unmount', () => {
    const editableRef = { current: document.createElement('div') };
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const flush = vi.fn();
    const { result, unmount } = renderHook(() => {
      const textContent = useTextContent({ editableRef });
      useEffect(() => () => {
        flush(textContent.getTextContent());
      }, [textContent.getTextContent]);
      return textContent;
    });
    expect(result.current.getTextContent()).toBe('');
    editableRef.current.textContent = '未发布的草稿';
    unmount();
    expect(flush).toHaveBeenCalledWith('未发布的草稿');
    expect(observe).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

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

  it('keeps IME publication deferred while refreshing committed text without HTML reads', () => {
    vi.useFakeTimers();
    const editableRef = { current: document.createElement('div') };
    const onInput = vi.fn();
    const { result } = renderHook(() => useChatInputTextPipeline({
      editableRef, onInput, setHasContent: vi.fn(), currentProvider: 'claude',
    }));
    const htmlReads = vi.spyOn(editableRef.current, 'innerHTML', 'get');
    expect(result.current.getTextContent()).toBe('');
    act(() => {
      result.current.handleCompositionStart();
      editableRef.current.textContent = '中文';
      result.current.handleInput('insertCompositionText');
      result.current.flushPendingInput();
    });
    expect(onInput).not.toHaveBeenCalled();
    expect(result.current.getTextContent()).toBe('中文');
    act(() => {
      result.current.handleCompositionEnd();
      result.current.handleInput('insertFromComposition');
      result.current.flushPendingInput();
    });
    expect(onInput).toHaveBeenCalledExactlyOnceWith('中文');
    expect(htmlReads).not.toHaveBeenCalled();
  });

  it('refreshes pipeline reads for paste, delete, undo, redo and programmatic clear', () => {
    vi.useFakeTimers();
    const editableRef = { current: document.createElement('div') };
    const onInput = vi.fn();
    const { result } = renderHook(() => useChatInputTextPipeline({
      editableRef, onInput, setHasContent: vi.fn(), currentProvider: 'claude',
    }));
    result.current.getTextContent();
    for (const [inputType, text] of [
      ['insertFromPaste', '第一行\n第二行'],
      ['deleteContentBackward', '第一行\n第二'],
      ['historyUndo', '第一行\n第二行'],
      ['historyRedo', '第一行\n第二'],
    ]) {
      act(() => {
        editableRef.current.textContent = text;
        result.current.handleInput(inputType);
        result.current.flushPendingInput();
      });
      expect(result.current.getTextContent()).toBe(text);
      expect(onInput).toHaveBeenLastCalledWith(text);
    }
    act(() => result.current.clearInput());
    expect(result.current.getTextContent()).toBe('');
    expect(onInput).toHaveBeenLastCalledWith('');
  });
});
