import { useCallback } from 'react';
import { deleteSelection, deleteToPosition } from '../utils/selectionUtils.js';

interface UseKeyboardNavigationOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  handleInput: () => void;
}

interface UseKeyboardNavigationReturn {
  /** Handle Mac-style cursor movement, text selection, and delete operations */
  handleMacCursorMovement: (e: React.KeyboardEvent<HTMLDivElement>) => boolean;
}

/**
 * useKeyboardNavigation - Handle Mac-style keyboard navigation
 *
 * Implements Mac keyboard shortcuts for:
 * - Cmd + Left/Right: Move to line start/end
 * - Cmd + Up/Down: Move to text start/end
 * - Cmd + Backspace: Delete to line start
 * - Shift variants for text selection
 */
export function useKeyboardNavigation({
  editableRef,
  handleInput,
}: UseKeyboardNavigationOptions): UseKeyboardNavigationReturn {
  /**
   * Handle Mac-style cursor movement, text selection, and delete operations
   * Returns true if the event was handled
   */
  const handleMacCursorMovement = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
      if (!editableRef.current) return false;

      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return false;

      const range = selection.getRangeAt(0);
      const isShift = e.shiftKey;

      // Cmd + Backspace: Delete from cursor to line start
      if (e.key === 'Backspace' && e.metaKey) {
        e.preventDefault();

        const node = range.startContainer;
        const offset = range.startOffset;

        // If there's selected content, use modern Selection API to delete
        if (!range.collapsed) {
          deleteSelection(editableRef.current);
          handleInput();
          return true;
        }

        // No selected content, first select from cursor to line start, then delete
        // Find current line start position
        let lineStartOffset = 0;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent || '';
          // Search backward from current position for newline
          for (let i = offset - 1; i >= 0; i--) {
            if (text[i] === '\n') {
              lineStartOffset = i + 1;
              break;
            }
          }
        }

        // If cursor is already at line start, do nothing
        if (lineStartOffset === offset) {
          return true;
        }

        // Delete content from line start to current cursor using modern API
        deleteToPosition(node, lineStartOffset, editableRef.current);

        // Trigger input event to update state
        handleInput();
        return true;
      }

      // Cmd + Left Arrow: Move to line start (or select to line start)
      if (e.key === 'ArrowLeft' && e.metaKey) {
        e.preventDefault();

        const node = range.startContainer;
        const offset = range.startOffset;

        // Find current line start position
        let lineStartOffset = 0;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent || '';
          // Search backward from current position for newline
          for (let i = offset - 1; i >= 0; i--) {
            if (text[i] === '\n') {
              lineStartOffset = i + 1;
              break;
            }
          }
        }

        const newRange = document.createRange();
        newRange.setStart(node, lineStartOffset);

        if (isShift) {
          // Shift: Select to line start
          newRange.setEnd(range.endContainer, range.endOffset);
        } else {
          // No Shift: Move cursor to line start
          newRange.collapse(true);
        }

        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
      }

      // Cmd + Right Arrow: Move to line end (or select to line end)
      if (e.key === 'ArrowRight' && e.metaKey) {
        e.preventDefault();

        const node = range.endContainer;
        const offset = range.endOffset;

        // Find current line end position
        let lineEndOffset = node.textContent?.length || 0;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent || '';
          // Search forward from current position for newline
          for (let i = offset; i < text.length; i++) {
            if (text[i] === '\n') {
              lineEndOffset = i;
              break;
            }
          }
        }

        const newRange = document.createRange();

        if (isShift) {
          // Shift: Select to line end
          newRange.setStart(range.startContainer, range.startOffset);
          newRange.setEnd(node, lineEndOffset);
        } else {
          // No Shift: Move cursor to line end
          newRange.setStart(node, lineEndOffset);
          newRange.collapse(true);
        }

        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
      }

      // Cmd + Up Arrow: Move to text start (or select to start)
      if (e.key === 'ArrowUp' && e.metaKey) {
        e.preventDefault();

        const firstNode = editableRef.current.firstChild || editableRef.current;
        const newRange = document.createRange();

        if (isShift) {
          // Shift: Select to start
          newRange.setStart(firstNode, 0);
          newRange.setEnd(range.endContainer, range.endOffset);
        } else {
          // No Shift: Move cursor to start
          newRange.setStart(firstNode, 0);
          newRange.collapse(true);
        }

        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
      }

      // Cmd + Down Arrow: Move to text end (or select to end)
      if (e.key === 'ArrowDown' && e.metaKey) {
        e.preventDefault();

        const lastNode = editableRef.current.lastChild || editableRef.current;
        const lastOffset =
          lastNode.nodeType === Node.TEXT_NODE
            ? lastNode.textContent?.length || 0
            : lastNode.childNodes.length;

        const newRange = document.createRange();

        if (isShift) {
          // Shift: Select to end
          newRange.setStart(range.startContainer, range.startOffset);
          newRange.setEnd(lastNode, lastOffset);
        } else {
          // No Shift: Move cursor to end
          newRange.setStart(lastNode, lastOffset);
          newRange.collapse(true);
        }

        selection.removeAllRanges();
        selection.addRange(newRange);
        return true;
      }

      return false;
    },
    [editableRef, handleInput]
  );

  return {
    handleMacCursorMovement,
  };
}
