/**
 * Selection utilities using modern APIs to replace deprecated document.execCommand
 *
 * These functions manipulate contenteditable elements using Selection/Range APIs
 * while triggering proper input events for state synchronization.
 */

/**
 * Insert text at current cursor position in a contenteditable element
 *
 * Uses document.execCommand('insertText') as primary method to preserve
 * browser's native undo/redo history. Falls back to Range API if execCommand fails.
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

  // Try execCommand first - this preserves browser's native undo/redo history
  // Although deprecated, it's still widely supported and essential for undo functionality
  const execCommandSuccess = document.execCommand('insertText', false, text);

  if (execCommandSuccess) {
    // execCommand handles everything including input event dispatch
    return true;
  }

  // Fallback to Range API if execCommand fails (e.g., in some strict CSP environments)
  // Note: This fallback does NOT support browser's native undo

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
 * Get cursor offset (character position) in a contenteditable element
 * Used to preserve cursor position across DOM updates
 *
 * @param element - The contenteditable element
 * @returns The character offset from the start, or -1 if cursor is not in element
 */
export function getCursorOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return -1;

  const range = selection.getRangeAt(0);

  // Verify cursor is within the element
  if (!element.contains(range.startContainer)) {
    return -1;
  }

  // Create a range from start of element to cursor position
  const preCaretRange = document.createRange();
  preCaretRange.selectNodeContents(element);
  preCaretRange.setEnd(range.startContainer, range.startOffset);

  // Get text content length of the range (this is the character offset)
  return preCaretRange.toString().length;
}

/**
 * Set cursor position by character offset in a contenteditable element
 * Walks through text nodes to find the correct position
 *
 * @param element - The contenteditable element
 * @param offset - The character offset to set cursor at
 * @returns true if cursor was set successfully
 */
export function setCursorOffset(element: HTMLElement, offset: number): boolean {
  if (offset < 0) return false;

  const selection = window.getSelection();
  if (!selection) return false;

  // Walk through all text nodes to find the position
  let currentOffset = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);

  let node: Text | null = walker.nextNode() as Text | null;
  while (node) {
    const nodeLength = node.textContent?.length || 0;

    if (currentOffset + nodeLength >= offset) {
      // Found the target node
      const range = document.createRange();
      const nodeOffset = offset - currentOffset;
      range.setStart(node, Math.min(nodeOffset, nodeLength));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }

    currentOffset += nodeLength;
    node = walker.nextNode() as Text | null;
  }

  // If offset is beyond content, set cursor at end
  if (element.lastChild) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  return false;
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
