import { useCallback, useRef } from 'react';

interface TextContentCache {
  content: string;
  htmlLength: number;
  timestamp: number;
}

interface UseTextContentOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
}

interface UseTextContentReturn {
  /** Get text content from editable element (with cache optimization) */
  getTextContent: () => string;
  /** Invalidate cache to force fresh content read */
  invalidateCache: () => void;
}

/**
 * useTextContent - Extract plain text from contenteditable element
 *
 * Performance optimization:
 * - Uses cache to avoid repeated DOM traversal
 * - Cache is invalidated when innerHTML length changes
 * - Properly handles file tags by reading data-file-path attribute
 */
export function useTextContent({
  editableRef,
}: UseTextContentOptions): UseTextContentReturn {
  const textCacheRef = useRef<TextContentCache>({
    content: '',
    htmlLength: 0,
    timestamp: 0,
  });

  /**
   * Invalidate cache to force fresh content read
   */
  const invalidateCache = useCallback(() => {
    textCacheRef.current = { content: '', htmlLength: 0, timestamp: 0 };
  }, []);

  /**
   * Get plain text content from editable element
   * Extracts text including file tag references in @path format
   */
  const getTextContent = useCallback((): string => {
    if (!editableRef.current) return '';

    // Performance optimization: Check cache validity
    const currentHtmlLength = editableRef.current.innerHTML.length;
    const cache = textCacheRef.current;

    // Return cached content if HTML hasn't changed (simple dirty check)
    if (currentHtmlLength === cache.htmlLength && cache.content !== '') {
      return cache.content;
    }

    // Extract plain text from DOM, including file tag references
    let text = '';

    // Recursive traversal, but for file-tag only read data-file-path without descending
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        const tagName = element.tagName.toLowerCase();

        // Handle line break elements
        if (tagName === 'br') {
          text += '\n';
        } else if (tagName === 'div' || tagName === 'p') {
          // Add newline before div/p (if not first element)
          if (text.length > 0 && !text.endsWith('\n')) {
            text += '\n';
          }
          node.childNodes.forEach(walk);
        } else if (element.classList.contains('file-tag')) {
          const filePath = element.getAttribute('data-file-path') || '';
          text += `@${filePath}`;
          // Don't traverse file-tag children to avoid duplicate filename and close button text
        } else {
          // Continue traversing child nodes
          node.childNodes.forEach(walk);
        }
      }
    };

    editableRef.current.childNodes.forEach(walk);

    // Only remove trailing newline that JCEF might add (not user-entered newlines)
    // If there are multiple trailing newlines, only remove the last one (JCEF added)
    if (text.endsWith('\n') && editableRef.current.childNodes.length > 0) {
      const lastChild = editableRef.current.lastChild;
      // Only remove if last node is not a br tag (meaning it's JCEF added)
      if (
        lastChild?.nodeType !== Node.ELEMENT_NODE ||
        (lastChild as HTMLElement).tagName?.toLowerCase() !== 'br'
      ) {
        text = text.slice(0, -1);
      }
    }

    // Update cache
    textCacheRef.current = {
      content: text,
      htmlLength: currentHtmlLength,
      timestamp: Date.now(),
    };

    return text;
  }, [editableRef]);

  return {
    getTextContent,
    invalidateCache,
  };
}
