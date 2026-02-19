import { useCallback } from 'react';
import type { TriggerQuery, DropdownPosition } from '../types';
import { getVirtualCursorPosition } from '../utils/virtualCursorUtils.js';

/**
 * Helper function: check if text ends with a newline character
 */
function textEndsWithNewline(text: string | null): boolean {
  return text !== null && text.length > 0 && text.endsWith('\n');
}

/**
 * Get screen coordinates at a given character offset
 * Note: Must be consistent with the text format returned by getTextContent
 * File tags are converted to @filepath format, requiring virtual length calculation
 */
export function getRectAtCharOffset(
  element: HTMLElement,
  charOffset: number
): DOMRect | null {
  let position = 0;
  let targetNode: Node | null = null;
  let targetOffset = 0;
  // Track whether current position ends with newline, consistent with getTextContent's text.endsWith('\n') logic
  let endsWithNewline = false;

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const len = text.length;
      if (position + len >= charOffset) {
        // Found the target text node
        targetNode = node;
        targetOffset = charOffset - position;
        return true;
      }
      position += len;
      // Update newline state
      endsWithNewline = textEndsWithNewline(text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      // Handle <br> tags - consistent with getTextContent
      if (tagName === 'br') {
        if (position + 1 >= charOffset) {
          // Target position is at the line break
          targetNode = el;
          targetOffset = 0;
          return true;
        }
        position += 1; // br tag corresponds to one newline character
        endsWithNewline = true;
        return false;
      }

      // Handle block elements (div, p) - consistent with getTextContent
      // getTextContent logic: if (text.length > 0 && !text.endsWith('\n')) { text += '\n'; }
      if (tagName === 'div' || tagName === 'p') {
        // Only add implicit newline when position > 0 and doesn't already end with newline
        if (position > 0 && !endsWithNewline) {
          if (position + 1 >= charOffset) {
            // Target position is at the block element's implicit newline
            targetNode = el;
            targetOffset = 0;
            return true;
          }
          position += 1;
          endsWithNewline = true;
        }

        // Recursively process child nodes
        for (const child of Array.from(el.childNodes)) {
          if (walk(child)) return true;
        }
        return false;
      }

      // If it's a file tag, calculate its virtual length (@ + filepath)
      if (el.classList.contains('file-tag')) {
        const filePath = el.getAttribute('data-file-path') || '';
        const tagLength = filePath.length + 1; // @ + filepath

        if (position + tagLength >= charOffset) {
          // Target position is inside file tag, return tag end position
          targetNode = el;
          targetOffset = 0;
          return true;
        }
        position += tagLength;
        // File paths don't end with newline
        endsWithNewline = false;
      } else {
        // Recursively process child nodes
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
      }
    }
    return false;
  };

  // Traverse all child nodes
  for (const child of Array.from(element.childNodes)) {
    if (walk(child)) break;
  }

  // If target position found, create a range and return its coordinates
  if (targetNode) {
    const range = document.createRange();
    try {
      // Use type assertion to avoid TypeScript's never type inference
      const node: Node = targetNode;
      if (node.nodeType === Node.TEXT_NODE) {
        const textNode = node as Text;
        range.setStart(textNode, Math.max(0, Math.min(targetOffset, textNode.textContent?.length ?? 0)));
        range.collapse(true);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Element node, use the pre-set range
        range.selectNodeContents(node as HTMLElement);
        range.collapse(false);
      }
      const rect = range.getBoundingClientRect();
      // If the coordinates are invalid (all zeros), fall back to the element's own coordinates
      if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) {
        return element.getBoundingClientRect();
      }
      return rect;
    } catch {
      return null;
    }
  }

  // If offset is out of range, return the element's end position
  if (element.lastChild) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) {
      return element.getBoundingClientRect();
    }
    return rect;
  }

  return element.getBoundingClientRect();
}

/**
 * Check if a text position is inside a file tag
 * @param element - contenteditable element
 * @param textPosition - text position (virtual position based on getTextContent)
 * @returns whether the position is inside a file tag
 */
function isPositionInFileTag(element: HTMLElement, textPosition: number): boolean {
  let position = 0;
  let inFileTag = false;
  // Track whether current position ends with newline, consistent with getTextContent's text.endsWith('\n') logic
  let endsWithNewline = false;

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const len = text.length;
      if (position + len > textPosition) {
        // Target position is within this text node, not inside a file tag
        return true;
      }
      position += len;
      endsWithNewline = textEndsWithNewline(text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      // Handle <br> tags - consistent with getTextContent
      if (tagName === 'br') {
        if (position + 1 > textPosition) {
          // Target position is at the line break
          return true;
        }
        position += 1;
        endsWithNewline = true;
        return false;
      }

      // Handle block elements (div, p) - consistent with getTextContent
      if (tagName === 'div' || tagName === 'p') {
        // Only add implicit newline when position > 0 and doesn't already end with newline
        if (position > 0 && !endsWithNewline) {
          if (position + 1 > textPosition) {
            return true;
          }
          position += 1;
          endsWithNewline = true;
        }

        // Recursively process child nodes
        for (const child of Array.from(el.childNodes)) {
          if (walk(child)) return true;
        }
        return false;
      }

      // If it's a file tag, calculate its virtual length (@ + filepath)
      if (el.classList.contains('file-tag')) {
        const filePath = el.getAttribute('data-file-path') || '';
        const tagLength = filePath.length + 1; // @ + filepath

        if (position <= textPosition && textPosition < position + tagLength) {
          // Target position is inside the file tag
          inFileTag = true;
          return true;
        }
        position += tagLength;
        endsWithNewline = false;
      } else {
        // Recursively process child nodes
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
      }
    }
    return false;
  };

  // Traverse all child nodes
  for (const child of Array.from(element.childNodes)) {
    if (walk(child)) break;
  }

  return inFileTag;
}

/**
 * Pre-compiled regex for unicode whitespace detection (performance optimization)
 * Matches: regular whitespace, non-breaking space, zero-width characters, and other unicode whitespace
 */
const UNICODE_WHITESPACE_REGEX = /^[\s\u00A0\u200B-\u200D\uFEFF\u2000-\u200A]$/;

/**
 * Helper function to check if a character is whitespace (including unicode whitespace)
 * Uses pre-compiled regex for better performance in high-frequency calls
 */
function isWhitespace(char: string): boolean {
  return UNICODE_WHITESPACE_REGEX.test(char);
}

/**
 * Detect @ file reference trigger
 * Note: Skip rendered file tags to avoid false triggers after file tags
 */
function detectAtTrigger(text: string, cursorPosition: number, element?: HTMLElement): TriggerQuery | null {
  // Search backward from cursor position for @
  let start = cursorPosition - 1;
  while (start >= 0) {
    const char = text[start];
    // Stop search on whitespace or newline
    if (isWhitespace(char)) {
      return null;
    }
    // Found @
    if (char === '@') {
      // Check if this @ is inside a file tag (already rendered reference)
      if (element && isPositionInFileTag(element, start)) {
        // Inside file tag, skip this @ and continue searching backward
        start--;
        continue;
      }

      const query = text.slice(start + 1, cursorPosition);
      return {
        trigger: '@',
        query,
        start,
        end: cursorPosition,
      };
    }
    start--;
  }
  return null;
}

/**
 * Detect / slash command trigger (only at line start)
 */
function detectSlashTrigger(text: string, cursorPosition: number): TriggerQuery | null {
  // Search backward from cursor position for /
  let start = cursorPosition - 1;
  while (start >= 0) {
    const char = text[start];

    // Stop search on whitespace or newline
    if (char === '\n') {
      return null;
    }
    if (isWhitespace(char)) {
      return null;
    }

    // Found /
    if (char === '/') {
      // Check if / is at line start
      const isLineStart = start === 0 || text[start - 1] === '\n';
      if (isLineStart) {
        const query = text.slice(start + 1, cursorPosition);
        return {
          trigger: '/',
          query,
          start,
          end: cursorPosition,
        };
      }
      return null;
    }
    start--;
  }
  return null;
}

/**
 * Detect # agent trigger (only at line start)
 */
function detectHashTrigger(text: string, cursorPosition: number): TriggerQuery | null {
  // Search backward from cursor position for #
  let start = cursorPosition - 1;
  while (start >= 0) {
    const char = text[start];

    // Stop search on whitespace or newline
    if (char === '\n') {
      return null;
    }
    if (isWhitespace(char)) {
      return null;
    }

    // Found #
    if (char === '#') {
      // Check if # is at line start
      const isLineStart = start === 0 || text[start - 1] === '\n';
      if (isLineStart) {
        const query = text.slice(start + 1, cursorPosition);
        return {
          trigger: '#',
          query,
          start,
          end: cursorPosition,
        };
      }
      return null;
    }
    start--;
  }
  return null;
}

/**
 * Detect ! prompt trigger
 * Requires ! to be at line start or preceded by whitespace to avoid false triggers
 * (e.g., "Hello!" should NOT trigger, but "!prompt" or "text !prompt" should)
 */
function detectExclamationTrigger(text: string, cursorPosition: number): TriggerQuery | null {
  // Search backward from cursor position for !
  let start = cursorPosition - 1;
  while (start >= 0) {
    const char = text[start];

    // Stop search on whitespace or newline
    if (char === '\n') {
      return null;
    }
    if (isWhitespace(char)) {
      return null;
    }

    // Found !
    if (char === '!') {
      // Require ! to be at line start or preceded by whitespace
      const isValidPosition = start === 0 || text[start - 1] === '\n' || isWhitespace(text[start - 1]);
      if (isValidPosition) {
        const query = text.slice(start + 1, cursorPosition);
        return {
          trigger: '!',
          query,
          start,
          end: cursorPosition,
        };
      }
      return null;
    }
    start--;
  }
  return null;
}

/**
 * useTriggerDetection - Trigger detection hook
 * Detects @, /, # or ! trigger symbols in the input box
 */
export function useTriggerDetection() {
  /**
   * Detect trigger
   */
  const detectTrigger = useCallback((
    text: string,
    cursorPosition: number,
    element?: HTMLElement
  ): TriggerQuery | null => {
    // Prioritize @ detection (pass element to skip file tags)
    const atTrigger = detectAtTrigger(text, cursorPosition, element);
    if (atTrigger) return atTrigger;

    // Detect /
    const slashTrigger = detectSlashTrigger(text, cursorPosition);
    if (slashTrigger) return slashTrigger;

    // Detect # (agent trigger)
    const hashTrigger = detectHashTrigger(text, cursorPosition);
    if (hashTrigger) return hashTrigger;

    // Detect ! (prompt trigger)
    const exclamationTrigger = detectExclamationTrigger(text, cursorPosition);
    if (exclamationTrigger) return exclamationTrigger;

    return null;
  }, []);

  /**
   * Get trigger position
   */
  const getTriggerPosition = useCallback((
    element: HTMLElement,
    triggerStart: number
  ): DropdownPosition | null => {
    const rect = getRectAtCharOffset(element, triggerStart);
    if (!rect) return null;

    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  /**
   * Get cursor position (delegates to shared virtual cursor utility)
   * Note: Must be consistent with getTextContent return format
   * File tags are converted to @filepath format
   */
  const getCursorPosition = useCallback((element: HTMLElement): number => {
    return getVirtualCursorPosition(element);
  }, []);

  return {
    detectTrigger,
    getTriggerPosition,
    getCursorPosition,
  };
}

export default useTriggerDetection;
