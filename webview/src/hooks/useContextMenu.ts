import { useState, useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { sendToJava } from '../utils/bridge.js';

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
  savedRange: Range | null;
  selectedText: string;
  targetImageSrc: string;
}

function placeCursorAfterRemoval(
  editable: HTMLElement,
  nextSibling: ChildNode | null,
  previousSibling: ChildNode | null
): void {
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  if (nextSibling?.isConnected) {
    if (nextSibling.nodeType === Node.TEXT_NODE) {
      range.setStart(nextSibling, 0);
    } else {
      range.setStartBefore(nextSibling);
    }
  } else if (previousSibling?.isConnected) {
    if (previousSibling.nodeType === Node.TEXT_NODE) {
      const textLength = previousSibling.textContent?.length ?? 0;
      range.setStart(previousSibling, textLength);
    } else {
      range.setStartAfter(previousSibling);
    }
  } else {
    range.selectNodeContents(editable);
  }
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function restoreRange(range: Range | null): void {
  if (!range) return;
  try {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    // Range may reference detached DOM nodes after re-render
  }
}

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>({
    visible: false, x: 0, y: 0, hasSelection: false, savedRange: null, selectedText: '', targetImageSrc: '',
  });
  const targetFileTagRef = useRef<HTMLElement | null>(null);

  const open = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const sel = window.getSelection();
    const textSelection = sel?.toString() ?? '';
    const target = e.target as HTMLElement | null;
    const fileTag = target?.closest('.file-tag') as HTMLElement | null;
    const image = target?.closest('img') as HTMLImageElement | null;
    const targetImageSrc = image?.getAttribute('src')?.trim() ?? '';
    const fileTagPath = fileTag?.getAttribute('data-file-path')?.trim() ?? '';
    // When right-clicking on a file tag, copy its full @path reference instead of misjudging as "no selection".
    const selectedText = textSelection.trim().length > 0
      ? textSelection
      : (fileTagPath ? `@${fileTagPath}` : '');
    const hasSelection = selectedText.trim().length > 0;
    const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    targetFileTagRef.current = fileTag;
    setState({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      hasSelection,
      savedRange,
      selectedText,
      targetImageSrc,
    });
  }, []);

  const close = useCallback(() => {
    setState(prev => ({ ...prev, visible: false }));
  }, []);

  return { ...state, open, close, targetFileTag: targetFileTagRef.current };
}

/** Copy saved selection text to clipboard via Java bridge */
export function copySelection(_savedRange: Range | null, text: string): void {
  if (!text) return;
  sendToJava('write_clipboard', text);
}

/** Copy image from message area to system clipboard via Java bridge */
export function copyImageSelection(imageSrc: string): void {
  if (!imageSrc) return;
  sendToJava('write_clipboard_image', { src: imageSrc });
}

/** Cut saved selection text via Java bridge (for contenteditable) */
export function cutSelection(
  savedRange: Range | null,
  text: string,
  el?: HTMLElement,
  targetFileTag?: HTMLElement | null
): void {
  if (!text) return;
  sendToJava('write_clipboard', text);
  if (targetFileTag?.isConnected && el?.contains(targetFileTag)) {
    const nextSibling = targetFileTag.nextSibling;
    const previousSibling = targetFileTag.previousSibling;
    targetFileTag.remove();
    el.focus();
    placeCursorAfterRemoval(el, nextSibling, previousSibling);
    return;
  }
  if (el) el.focus();
  restoreRange(savedRange);
  document.execCommand('delete');
}

/** Paste clipboard text at saved range via Java bridge */
export function pasteAtCursor(savedRange: Range | null, el: HTMLElement, onComplete?: () => void): void {
  // Capture handler reference so timeout only clears its own registration,
  // preventing accidental cancellation of a concurrent paste call.
  const handler = (text: string) => {
    clearTimeout(timeoutId);
    if (window.onClipboardRead === handler) {
      window.onClipboardRead = undefined;
    }
    if (!text || !el.isConnected) return;
    el.focus();
    restoreRange(savedRange);
    document.execCommand('insertText', false, text);
    onComplete?.();
  };

  const timeoutId = setTimeout(() => {
    if (window.onClipboardRead === handler) {
      window.onClipboardRead = undefined;
    }
  }, 3000);

  window.onClipboardRead = handler;
  sendToJava('read_clipboard', '');
}

/**
 * Insert a newline at the current cursor position using insertLineBreak
 * with a manual <br> fallback. Works without requiring a saved range.
 */
export function insertNewlineAtCursor(): void {
  if (!document.execCommand('insertLineBreak')) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const br = document.createElement('br');
      range.insertNode(br);
      range.setStartAfter(br);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

/** Insert a newline at saved range in a contenteditable element */
export function insertNewline(savedRange: Range | null, el: HTMLElement): void {
  el.focus();
  restoreRange(savedRange);
  insertNewlineAtCursor();
}
