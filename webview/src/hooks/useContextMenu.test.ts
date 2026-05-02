vi.mock('../utils/bridge.js', () => ({
  sendToJava: vi.fn(),
}));

import { act, renderHook } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { copyImageSelection, cutSelection, useContextMenu } from './useContextMenu.js';
import { sendToJava } from '../utils/bridge.js';

function mockSelection(options?: {
  text?: string;
  rangeCount?: number;
  range?: Range;
}) {
  const selection = {
    toString: vi.fn(() => options?.text ?? ''),
    rangeCount: options?.rangeCount ?? 0,
    getRangeAt: vi.fn(() => options?.range ?? document.createRange()),
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
  return selection;
}

describe('useContextMenu', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses file tag path as copy target when right-clicking a file tag', () => {
    mockSelection({ text: '', rangeCount: 0 });
    const fileTag = document.createElement('span');
    fileTag.className = 'file-tag';
    fileTag.setAttribute('data-file-path', 'D:\\Code\\demo.ts#L3-L9');

    const { result } = renderHook(() => useContextMenu());

    act(() => {
      result.current.open({
        preventDefault: vi.fn(),
        clientX: 12,
        clientY: 24,
        target: fileTag,
      } as unknown as ReactMouseEvent);
    });

    expect(result.current.visible).toBe(true);
    expect(result.current.hasSelection).toBe(true);
    expect(result.current.selectedText).toBe('@D:\\Code\\demo.ts#L3-L9');
  });

  it('prefers actual text selection over file tag fallback', () => {
    const range = document.createRange();
    const selection = mockSelection({ text: 'selected text', rangeCount: 1, range });
    const fileTag = document.createElement('span');
    fileTag.className = 'file-tag';
    fileTag.setAttribute('data-file-path', 'D:\\Code\\demo.ts#L3-L9');

    const { result } = renderHook(() => useContextMenu());

    act(() => {
      result.current.open({
        preventDefault: vi.fn(),
        clientX: 1,
        clientY: 2,
        target: fileTag,
      } as unknown as ReactMouseEvent);
    });

    expect(result.current.hasSelection).toBe(true);
    expect(result.current.selectedText).toBe('selected text');
    expect(selection.getRangeAt).toHaveBeenCalledWith(0);
    expect(result.current.savedRange).not.toBeNull();
  });

  it('cuts a file tag by copying its path and removing the tag', () => {
    const editable = document.createElement('div');
    const fileTag = document.createElement('span');
    const trailingText = document.createTextNode(' ');
    editable.append(fileTag, trailingText);
    document.body.appendChild(editable);

    fileTag.className = 'file-tag';
    fileTag.setAttribute('data-file-path', 'D:\\Code\\demo.ts#L3-L9');

    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
    const focusSpy = vi.spyOn(editable, 'focus').mockImplementation(() => {});

    cutSelection(null, '@D:\\Code\\demo.ts#L3-L9', editable, fileTag);

    expect(sendToJava).toHaveBeenCalledWith('write_clipboard', '@D:\\Code\\demo.ts#L3-L9');
    expect(editable.querySelector('.file-tag')).toBeNull();
    expect(focusSpy).toHaveBeenCalled();
    expect(selection.removeAllRanges).toHaveBeenCalled();
    expect(selection.addRange).toHaveBeenCalledTimes(1);
  });

  it('captures image source when right-clicking on an image', () => {
    mockSelection({ text: '', rangeCount: 0 });
    const image = document.createElement('img');
    image.setAttribute('src', 'data:image/png;base64,AAAA');

    const { result } = renderHook(() => useContextMenu());

    act(() => {
      result.current.open({
        preventDefault: vi.fn(),
        clientX: 8,
        clientY: 16,
        target: image,
      } as unknown as ReactMouseEvent);
    });

    expect(result.current.visible).toBe(true);
    expect(result.current.hasSelection).toBe(false);
    expect(result.current.targetImageSrc).toBe('data:image/png;base64,AAAA');
  });

  it('sends image copy request to Java bridge', () => {
    copyImageSelection('https://example.com/demo.png');

    expect(sendToJava).toHaveBeenCalledWith('write_clipboard_image', { src: 'https://example.com/demo.png' });
  });
});
