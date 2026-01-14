/**
 * Selection utilities using modern APIs to replace deprecated document.execCommand
 *
 * These functions manipulate contenteditable elements using Selection/Range APIs
 * while triggering proper input events for state synchronization.
 */

/**
 * Insert text at current cursor position in a contenteditable element
 * Replaces document.execCommand('insertText', false, text)
 *
 * @param text - Text to insert
 * @param element - Optional target contenteditable element (uses active element if not provided)
 * @returns true if insertion was successful
 */
export function insertTextAtCursor(text: string, element?: HTMLElement | null): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);

  // Verify cursor is within the target element if provided
  if (element && !element.contains(range.commonAncestorContainer)) {
    return false;
  }

  // Delete any selected content first
  if (!range.collapsed) {
    range.deleteContents();
  }

  // Create and insert text node
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);

  // Move cursor to after inserted text
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);

  // Trigger input event for state synchronization
  if (element) {
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
  }

  return true;
}

/**
 * Delete selected content in a contenteditable element
 * Replaces document.execCommand('delete', false)
 *
 * @param element - Optional target contenteditable element
 * @returns true if deletion was successful
 */
export function deleteSelection(element?: HTMLElement | null): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);

  // Verify selection is within the target element if provided
  if (element && !element.contains(range.commonAncestorContainer)) {
    return false;
  }

  // Nothing to delete if no selection
  if (range.collapsed) return false;

  // Delete selected content
  range.deleteContents();

  // Collapse range to start
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);

  // Trigger input event for state synchronization
  if (element) {
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
    }));
  }

  return true;
}

/**
 * Delete content from current cursor position to a specified position
 * Used for Cmd+Backspace (delete to line start) functionality
 *
 * @param targetNode - The node containing the target position
 * @param targetOffset - The offset within the node to delete to
 * @param element - Optional target contenteditable element
 * @returns true if deletion was successful
 */
export function deleteToPosition(
  targetNode: Node,
  targetOffset: number,
  element?: HTMLElement | null
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const currentRange = selection.getRangeAt(0);

  // Verify cursor is within the target element if provided
  if (element && !element.contains(currentRange.commonAncestorContainer)) {
    return false;
  }

  // Create range from target position to current cursor
  const deleteRange = document.createRange();
  deleteRange.setStart(targetNode, targetOffset);
  deleteRange.setEnd(currentRange.startContainer, currentRange.startOffset);

  // Check if there's content to delete
  if (deleteRange.collapsed) return false;

  // Delete the content
  deleteRange.deleteContents();

  // Update selection
  selection.removeAllRanges();
  selection.addRange(deleteRange);

  // Trigger input event for state synchronization
  if (element) {
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
    }));
  }

  return true;
}
