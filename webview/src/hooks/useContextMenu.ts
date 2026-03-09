import { useState, useCallback } from 'react';
import { sendToJava } from '../utils/bridge.js';

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
  savedRange: Range | null;
  selectedText: string;
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
    visible: false, x: 0, y: 0, hasSelection: false, savedRange: null, selectedText: '',
  });

  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sel = window.getSelection();
    const selectedText = sel?.toString() ?? '';
    const hasSelection = selectedText.trim().length > 0;
    const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    setState({ visible: true, x: e.clientX, y: e.clientY, hasSelection, savedRange, selectedText });
  }, []);

  const close = useCallback(() => {
    setState(prev => ({ ...prev, visible: false }));
  }, []);

  return { ...state, open, close };
}

/** Copy saved selection text to clipboard via Java bridge */
export function copySelection(_savedRange: Range | null, text: string): void {
  if (!text) return;
  sendToJava('write_clipboard', text);
}

/** Cut saved selection text via Java bridge (for contenteditable) */
export function cutSelection(savedRange: Range | null, text: string, el?: HTMLElement): void {
  if (!text) return;
  sendToJava('write_clipboard', text);
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
