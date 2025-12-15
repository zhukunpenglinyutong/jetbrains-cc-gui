import { useCallback } from 'react';
import type { TriggerQuery, DropdownPosition } from '../types';

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

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (position + len >= charOffset) {
        // 找到目标文本节点
        targetNode = node;
        targetOffset = charOffset - position;
        return true;
      }
      position += len;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;

      // 如果是文件标签，计算其虚拟长度 (@ + 文件路径)
      if (el.classList.contains('file-tag')) {
        const filePath = el.getAttribute('data-file-path') || '';
        const tagLength = filePath.length + 1; // @ + 文件路径

        if (position + tagLength >= charOffset) {
          // 目标位置在文件标签内，返回标签末尾位置
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false); // 折叠到末尾
          targetNode = el;
          targetOffset = 0;
          return true;
        }
        position += tagLength;
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
      return range.getBoundingClientRect();
    } catch {
      return null;
    }
  }

  // 如果偏移超出范围，返回元素末尾位置
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
  // console.log('[detectSlashTrigger] Input:', { text, cursorPosition, textLength: text.length });

  // 从光标位置向前查找 /
  let start = cursorPosition - 1;
  while (start >= 0) {
    const char = text[start];
    // console.log('[detectSlashTrigger] Checking char:', { start, char, charCode: char?.charCodeAt(0) });

    // 遇到空格或换行，停止搜索
    if (char === ' ' || char === '\t') {
      // console.log('[detectSlashTrigger] Found space/tab, returning null');
      return null;
    }
    if (char === '\n') {
      // console.log('[detectSlashTrigger] Found newline, returning null');
      return null;
    }

    // 找到 /
    if (char === '/') {
      // 检查 / 前是否为行首
      const isLineStart = start === 0 || text[start - 1] === '\n';
      // console.log('[detectSlashTrigger] Found /, isLineStart:', isLineStart);
      if (isLineStart) {
        const query = text.slice(start + 1, cursorPosition);
        // console.log('[detectSlashTrigger] Returning trigger:', { trigger: '/', query, start, end: cursorPosition });
        return {
          trigger: '/',
          query,
          start,
          end: cursorPosition,
        };
      }
      // console.log('[detectSlashTrigger] / not at line start, returning null');
      return null;
    }
    start--;
  }
  // console.log('[detectSlashTrigger] Loop ended, returning null');
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
   * 注意：需要与 getTextContent 返回的文本格式一致
   * 文件标签会被转换为 @文件路径 格式
   */
  const getCursorPosition = useCallback((element: HTMLElement): number => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;

    const range = selection.getRangeAt(0);

    // 如果光标容器是 element 本身，使用 endOffset 计算子节点索引
    if (range.endContainer === element) {
      let position = 0;
      const childNodes = Array.from(element.childNodes);
      for (let i = 0; i < range.endOffset && i < childNodes.length; i++) {
        const child = childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
          position += child.textContent?.length || 0;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const el = child as HTMLElement;
          if (el.classList.contains('file-tag')) {
            const filePath = el.getAttribute('data-file-path') || '';
            position += filePath.length + 1; // @ + 文件路径（空格由后面的文本节点提供）
          } else {
            position += el.textContent?.length || 0;
          }
        }
      }
      return position;
    }

    // 遍历 DOM 节点计算光标位置，与 getTextContent 保持一致
    let position = 0;
    let found = false;

    const walk = (node: Node): boolean => {
      if (found) return true;

      if (node.nodeType === Node.TEXT_NODE) {
        // 检查光标是否在这个文本节点中
        if (range.endContainer === node) {
          position += range.endOffset;
          found = true;
          return true;
        }
        position += node.textContent?.length || 0;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;

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
        } else {
          // 检查光标是否在这个元素节点中（但不是文件标签）
          if (range.endContainer === el) {
            // 光标在元素节点中，计算到 endOffset 位置的子节点
            const children = Array.from(el.childNodes);
            for (let i = 0; i < range.endOffset && i < children.length; i++) {
              const child = children[i];
              if (child.nodeType === Node.TEXT_NODE) {
                position += child.textContent?.length || 0;
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
