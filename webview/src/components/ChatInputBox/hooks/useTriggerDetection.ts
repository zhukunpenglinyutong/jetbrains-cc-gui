import { useCallback } from 'react';
import type { TriggerQuery, DropdownPosition } from '../types';

/**
 * 获取指定字符偏移位置的屏幕坐标
 */
export function getRectAtCharOffset(
  element: HTMLElement,
  charOffset: number
): DOMRect | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = charOffset;
  let node: Text | null = null;

  while ((node = walker.nextNode() as Text | null)) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      const range = document.createRange();
      try {
        range.setStart(node, Math.max(0, remaining));
        range.collapse(true);
        return range.getBoundingClientRect();
      } catch {
        return null;
      }
    }
    remaining -= len;
  }

  // 如果偏移超出文本长度，返回元素末尾位置
  if (element.lastChild) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    return range.getBoundingClientRect();
  }

  return element.getBoundingClientRect();
}

/**
 * 检测 @ 文件引用触发
 */
function detectAtTrigger(text: string, cursorPosition: number): TriggerQuery | null {
  // 从光标位置向前查找 @
  let start = cursorPosition - 1;
  while (start >= 0) {
    const char = text[start];
    // 遇到空格或换行，停止搜索
    if (char === ' ' || char === '\n' || char === '\t') {
      return null;
    }
    // 找到 @
    if (char === '@') {
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
 * 检测 / 斜杠命令触发（仅行首）
 */
function detectSlashTrigger(text: string, cursorPosition: number): TriggerQuery | null {
  // 从光标位置向前查找 /
  let start = cursorPosition - 1;
  while (start >= 0) {
    const char = text[start];
    // 遇到空格或换行，检查是否为行首
    if (char === '\n' || (start === 0 && char === '/')) {
      break;
    }
    if (char === ' ' || char === '\t') {
      return null;
    }
    // 找到 /
    if (char === '/') {
      // 检查 / 前是否为行首
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
 * useTriggerDetection - 触发检测 Hook
 * 检测输入框中的 @ 或 / 触发符号
 */
export function useTriggerDetection() {
  /**
   * 检测触发
   */
  const detectTrigger = useCallback((
    text: string,
    cursorPosition: number
  ): TriggerQuery | null => {
    // 优先检测 @
    const atTrigger = detectAtTrigger(text, cursorPosition);
    if (atTrigger) return atTrigger;

    // 检测 /
    const slashTrigger = detectSlashTrigger(text, cursorPosition);
    if (slashTrigger) return slashTrigger;

    return null;
  }, []);

  /**
   * 获取触发位置
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
   * 获取光标位置
   */
  const getCursorPosition = useCallback((element: HTMLElement): number => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;

    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.endContainer, range.endOffset);

    return preCaretRange.toString().length;
  }, []);

  return {
    detectTrigger,
    getTriggerPosition,
    getCursorPosition,
  };
}

export default useTriggerDetection;
