/**
 * Virtual cursor position utilities for contenteditable elements with file tags.
 *
 * File tags (<span class="file-tag" data-file-path="...">) are represented as
 * "@filepath" in virtual text (getTextContent). These utilities handle the mapping
 * between DOM cursor positions and virtual text offsets.
 *
 * Extracted from useTriggerDetection.ts for reuse in useFileTags.ts and other hooks.
 */

/**
 * Helper: check if text ends with a newline
 */
function textEndsWithNewline(text: string | null): boolean {
  return text !== null && text.length > 0 && text.endsWith('\n');
}

/**
 * Get the virtual cursor position in a contenteditable element.
 *
 * "Virtual position" means the character offset in the text returned by getTextContent(),
 * where file tags are counted as "@" + filepath length (not their visible DOM text).
 *
 * @param element - The contenteditable element
 * @returns The virtual character offset, or 0 if cursor is not found
 */
export function getVirtualCursorPosition(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;

  const range = selection.getRangeAt(0);

  let position = 0;
  let found = false;
  let endsWithNewline = false;

  const walk = (node: Node): boolean => {
    if (found) return true;

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (range.endContainer === node) {
        position += range.endOffset;
        found = true;
        return true;
      }
      position += text.length;
      endsWithNewline = textEndsWithNewline(text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      if (tagName === 'br') {
        if (
          range.endContainer === el ||
          (range.endContainer === element &&
            el === element.childNodes[range.endOffset - 1])
        ) {
          found = true;
          return true;
        }
        position += 1;
        endsWithNewline = true;
        return false;
      }

      if (tagName === 'div' || tagName === 'p') {
        if (position > 0 && !endsWithNewline) {
          position += 1;
          endsWithNewline = true;
        }

        if (range.endContainer === el) {
          const children = Array.from(el.childNodes);
          for (let i = 0; i < range.endOffset && i < children.length; i++) {
            const child = children[i];
            if (child.nodeType === Node.TEXT_NODE) {
              position += child.textContent?.length || 0;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              const childEl = child as HTMLElement;
              const childTag = childEl.tagName.toLowerCase();
              if (childTag === 'br') {
                position += 1;
              } else if (childEl.classList.contains('file-tag')) {
                const filePath = childEl.getAttribute('data-file-path') || '';
                position += filePath.length + 1;
              } else {
                position += childEl.textContent?.length || 0;
              }
            }
          }
          found = true;
          return true;
        }

        for (const child of Array.from(el.childNodes)) {
          if (walk(child)) return true;
        }
        return false;
      }

      if (el.classList.contains('file-tag')) {
        const filePath = el.getAttribute('data-file-path') || '';
        const tagLength = filePath.length + 1;

        if (el.contains(range.endContainer)) {
          position += tagLength;
          found = true;
          return true;
        }
        position += tagLength;
        endsWithNewline = false;
      } else {
        if (range.endContainer === el) {
          const children = Array.from(el.childNodes);
          for (let i = 0; i < range.endOffset && i < children.length; i++) {
            const child = children[i];
            if (child.nodeType === Node.TEXT_NODE) {
              position += child.textContent?.length || 0;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              const childEl = child as HTMLElement;
              const childTag = childEl.tagName.toLowerCase();
              if (childTag === 'br') {
                position += 1;
              } else if (childEl.classList.contains('file-tag')) {
                const filePath = childEl.getAttribute('data-file-path') || '';
                position += filePath.length + 1;
              } else {
                position += childEl.textContent?.length || 0;
              }
            }
          }
          found = true;
          return true;
        }
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
      }
    }
    return false;
  };

  for (const child of Array.from(element.childNodes)) {
    if (walk(child)) break;
  }

  return position;
}

/**
 * Set the cursor at a virtual character offset in a contenteditable element.
 *
 * Walks the DOM tree, counting virtual positions (file tags = "@" + filepath length),
 * and places the cursor at the correct DOM node/offset corresponding to the virtual offset.
 *
 * @param element - The contenteditable element
 * @param virtualOffset - The target virtual character offset
 * @returns true if cursor was set successfully
 */
export function setVirtualCursorPosition(
  element: HTMLElement,
  virtualOffset: number
): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  let position = 0;
  let targetNode: Node | null = null;
  let targetOffset = 0;
  let endsWithNewline = false;

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const len = text.length;
      if (position + len >= virtualOffset) {
        targetNode = node;
        targetOffset = virtualOffset - position;
        return true;
      }
      position += len;
      endsWithNewline = textEndsWithNewline(text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      if (tagName === 'br') {
        if (position + 1 >= virtualOffset) {
          targetNode = el;
          targetOffset = 0;
          return true;
        }
        position += 1;
        endsWithNewline = true;
        return false;
      }

      if (tagName === 'div' || tagName === 'p') {
        if (position > 0 && !endsWithNewline) {
          if (position + 1 >= virtualOffset) {
            targetNode = el;
            targetOffset = 0;
            return true;
          }
          position += 1;
          endsWithNewline = true;
        }

        for (const child of Array.from(el.childNodes)) {
          if (walk(child)) return true;
        }
        return false;
      }

      if (el.classList.contains('file-tag')) {
        const filePath = el.getAttribute('data-file-path') || '';
        const tagLength = filePath.length + 1;

        if (position + tagLength >= virtualOffset) {
          // Target is inside file tag; place cursor after the tag
          targetNode = el;
          targetOffset = -1; // sentinel: means "after this element"
          return true;
        }
        position += tagLength;
        endsWithNewline = false;
      } else {
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
      }
    }
    return false;
  };

  for (const child of Array.from(element.childNodes)) {
    if (walk(child)) break;
  }

  if (!targetNode) {
    // Offset beyond content: place cursor at end
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

  try {
    const range = document.createRange();
    const node: Node = targetNode;

    if (targetOffset === -1) {
      // Sentinel: place cursor after this element (file tag)
      range.setStartAfter(node);
      range.collapse(true);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      const maxOffset = textNode.textContent?.length ?? 0;
      range.setStart(textNode, Math.min(targetOffset, maxOffset));
      range.collapse(true);
    } else {
      // Element node (br, div, etc.)
      range.selectNodeContents(node as HTMLElement);
      range.collapse(false);
    }

    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}
