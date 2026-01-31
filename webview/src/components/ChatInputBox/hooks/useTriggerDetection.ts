import { useCallback } from 'react';
import type { TriggerQuery, DropdownPosition } from '../types';

/**
 * 辅助函数：检查文本是否以换行符结尾
 */
function textEndsWithNewline(text: string | null): boolean {
  return text !== null && text.length > 0 && text.endsWith('\n');
}

/**
 * 获取指定字符偏移位置的屏幕坐标
 * 注意：需要与 getTextContent 返回的文本格式一致
 * 文件标签会被转换为 @文件路径 格式，需要计算其虚拟长度
 */
export function getRectAtCharOffset(
  element: HTMLElement,
  charOffset: number
): DOMRect | null {
  let position = 0;
  let targetNode: Node | null = null;
  let targetOffset = 0;
  // 跟踪当前是否以换行结尾，与 getTextContent 的 text.endsWith('\n') 逻辑一致
  let endsWithNewline = false;

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const len = text.length;
      if (position + len >= charOffset) {
        // 找到目标文本节点
        targetNode = node;
        targetOffset = charOffset - position;
        return true;
      }
      position += len;
      // 更新换行状态
      endsWithNewline = textEndsWithNewline(text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      // 处理 <br> 标签 - 与 getTextContent 保持一致
      if (tagName === 'br') {
        if (position + 1 >= charOffset) {
          // 目标位置在换行符处
          targetNode = el;
          targetOffset = 0;
          return true;
        }
        position += 1; // br 标签对应一个换行符
        endsWithNewline = true;
        return false;
      }

      // 处理块级元素 (div, p) - 与 getTextContent 保持一致
      // getTextContent 逻辑: if (text.length > 0 && !text.endsWith('\n')) { text += '\n'; }
      if (tagName === 'div' || tagName === 'p') {
        // 只有在 position > 0 且不以换行结尾时才添加隐式换行
        if (position > 0 && !endsWithNewline) {
          if (position + 1 >= charOffset) {
            // 目标位置在块级元素的隐式换行处
            targetNode = el;
            targetOffset = 0;
            return true;
          }
          position += 1;
          endsWithNewline = true;
        }

        // 递归处理子节点
        for (const child of Array.from(el.childNodes)) {
          if (walk(child)) return true;
        }
        return false;
      }

      // 如果是文件标签，计算其虚拟长度 (@ + 文件路径)
      if (el.classList.contains('file-tag')) {
        const filePath = el.getAttribute('data-file-path') || '';
        const tagLength = filePath.length + 1; // @ + 文件路径

        if (position + tagLength >= charOffset) {
          // 目标位置在文件标签内，返回标签末尾位置
          targetNode = el;
          targetOffset = 0;
          return true;
        }
        position += tagLength;
        // 文件路径不以换行结尾
        endsWithNewline = false;
      } else {
        // 递归处理子节点
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
      }
    }
    return false;
  };

  // 遍历所有子节点
  for (const child of Array.from(element.childNodes)) {
    if (walk(child)) break;
  }

  // 如果找到目标位置，创建 range 并返回其坐标
  if (targetNode) {
    const range = document.createRange();
    try {
      // 使用类型断言来避免TypeScript的never类型推断
      const node: Node = targetNode;
      if (node.nodeType === Node.TEXT_NODE) {
        const textNode = node as Text;
        range.setStart(textNode, Math.max(0, Math.min(targetOffset, textNode.textContent?.length ?? 0)));
        range.collapse(true);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 元素节点，使用已设置的范围
        range.selectNodeContents(node as HTMLElement);
        range.collapse(false);
      }
      const rect = range.getBoundingClientRect();
      // 如果获取的坐标无效（全为0），回退到元素自身的坐标
      if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) {
        return element.getBoundingClientRect();
      }
      return rect;
    } catch {
      return null;
    }
  }

  // 如果偏移超出范围，返回元素末尾位置
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
 * 检查文本位置是否在文件标签内
 * @param element - contenteditable 元素
 * @param textPosition - 文本位置（基于 getTextContent 的虚拟位置）
 * @returns 是否在文件标签内
 */
function isPositionInFileTag(element: HTMLElement, textPosition: number): boolean {
  let position = 0;
  let inFileTag = false;
  // 跟踪当前是否以换行结尾，与 getTextContent 的 text.endsWith('\n') 逻辑一致
  let endsWithNewline = false;

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const len = text.length;
      if (position + len > textPosition) {
        // 目标位置在这个文本节点内，不在文件标签内
        return true;
      }
      position += len;
      endsWithNewline = textEndsWithNewline(text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      // 处理 <br> 标签 - 与 getTextContent 保持一致
      if (tagName === 'br') {
        if (position + 1 > textPosition) {
          // 目标位置在换行符处
          return true;
        }
        position += 1;
        endsWithNewline = true;
        return false;
      }

      // 处理块级元素 (div, p) - 与 getTextContent 保持一致
      if (tagName === 'div' || tagName === 'p') {
        // 只有在 position > 0 且不以换行结尾时才添加隐式换行
        if (position > 0 && !endsWithNewline) {
          if (position + 1 > textPosition) {
            return true;
          }
          position += 1;
          endsWithNewline = true;
        }

        // 递归处理子节点
        for (const child of Array.from(el.childNodes)) {
          if (walk(child)) return true;
        }
        return false;
      }

      // 如果是文件标签，计算其虚拟长度 (@ + 文件路径)
      if (el.classList.contains('file-tag')) {
        const filePath = el.getAttribute('data-file-path') || '';
        const tagLength = filePath.length + 1; // @ + 文件路径

        if (position <= textPosition && textPosition < position + tagLength) {
          // 目标位置在文件标签内
          inFileTag = true;
          return true;
        }
        position += tagLength;
        endsWithNewline = false;
      } else {
        // 递归处理子节点
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
      }
    }
    return false;
  };

  // 遍历所有子节点
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
 * useTriggerDetection - Trigger detection hook
 * Detects @, / or # trigger symbols in the input box
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
   * Get cursor position
   * Note: Must be consistent with getTextContent return format
   * File tags are converted to @filepath format
   */
  const getCursorPosition = useCallback((element: HTMLElement): number => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;

    const range = selection.getRangeAt(0);

    // 遍历 DOM 节点计算光标位置，与 getTextContent 保持一致
    let position = 0;
    let found = false;
    // 跟踪当前是否以换行结尾，与 getTextContent 的 text.endsWith('\n') 逻辑一致
    let endsWithNewline = false;

    const walk = (node: Node): boolean => {
      if (found) return true;

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        // 检查光标是否在这个文本节点中
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

        // 处理 <br> 标签 - 与 getTextContent 保持一致
        if (tagName === 'br') {
          // 检查光标是否在 br 元素上
          if (range.endContainer === el || (range.endContainer === element && el === element.childNodes[range.endOffset - 1])) {
            found = true;
            return true;
          }
          position += 1;
          endsWithNewline = true;
          return false;
        }

        // 处理块级元素 (div, p) - 与 getTextContent 保持一致
        if (tagName === 'div' || tagName === 'p') {
          // 只有在 position > 0 且不以换行结尾时才添加隐式换行
          if (position > 0 && !endsWithNewline) {
            position += 1; // 块级元素前的隐式换行
            endsWithNewline = true;
          }

          // 检查光标是否直接在这个元素上
          if (range.endContainer === el) {
            // 光标在元素节点中，计算到 endOffset 位置的子节点
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

          // 递归处理子节点
          for (const child of Array.from(el.childNodes)) {
            if (walk(child)) return true;
          }
          return false;
        }

        // 如果是文件标签，计算其转换后的长度 (@ + 文件路径)
        if (el.classList.contains('file-tag')) {
          const filePath = el.getAttribute('data-file-path') || '';
          const tagLength = filePath.length + 1; // @ + 文件路径（空格由后面的文本节点提供）

          // 检查光标是否在文件标签内部或之后
          if (el.contains(range.endContainer)) {
            // 光标在文件标签内部，视为在标签末尾
            position += tagLength;
            found = true;
            return true;
          }
          position += tagLength;
          endsWithNewline = false;
        } else {
          // 检查光标是否在这个元素节点中（但不是文件标签）
          if (range.endContainer === el) {
            // 光标在元素节点中，计算到 endOffset 位置的子节点
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
          // 递归处理子节点
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
  }, []);

  return {
    detectTrigger,
    getTriggerPosition,
    getCursorPosition,
  };
}

export default useTriggerDetection;
