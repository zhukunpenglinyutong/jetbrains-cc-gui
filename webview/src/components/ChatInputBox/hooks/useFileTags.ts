import { useCallback, useEffect, useRef } from 'react';
import { escapeHtmlAttr } from '../utils/htmlEscape.js';
import { getFileIcon } from '../../../utils/fileIcons.js';
import { icon_folder, icon_terminal, icon_server } from '../../../utils/icons.js';
import { perfTimer } from '../../../utils/debug.js';
import {
  TEXT_LENGTH_THRESHOLDS,
  RENDERING_LIMITS,
} from '../../../constants/performance.js';
import type { FileTagInfo } from '../types.js';

interface UseFileTagsOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  onCloseCompletions: () => void;
}

interface UseFileTagsReturn {
  /** Render file tags from @path references */
  renderFileTags: () => void;
  /** Path mapping: filename/relative path -> absolute path (for tooltip display) */
  pathMappingRef: React.MutableRefObject<Map<string, string>>;
  /** Flag indicating file tags were just rendered (skip completion detection) */
  justRenderedTagRef: React.MutableRefObject<boolean>;
  /** Extract all file tags from current input (for sending to backend) */
  extractFileTags: () => FileTagInfo[];
}

/**
 * useFileTags - Handle file tag rendering in contenteditable
 *
 * Converts @filepath text references into styled file tag elements.
 * Only renders tags for paths that exist in pathMappingRef (user selected from dropdown).
 */
export function useFileTags({
  editableRef,
  getTextContent,
  onCloseCompletions,
}: UseFileTagsOptions): UseFileTagsReturn {
  // Path mapping: filename/relative path -> absolute path (for tooltip display)
  const pathMappingRef = useRef<Map<string, string>>(new Map());
  // Flag for just rendered file tags (skip completion detection)
  const justRenderedTagRef = useRef(false);

  const escapeHtmlText = useCallback((str: string): string => {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }, []);

  // Event delegation for closing tags to avoid accumulating per-tag listeners.
  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const closeEl = target?.closest?.('.file-tag-close') as HTMLElement | null;
      if (!closeEl) return;

      e.preventDefault();
      e.stopPropagation();

      const tag = closeEl.closest('.file-tag') as HTMLElement | null;
      if (tag) {
        tag.remove();
      }
    };

    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [editableRef]);

  /**
   * Render file tags
   * Converts @filepath format text into file tag elements
   *
   * Performance optimization:
   * - Uses array + join instead of string concatenation (O(n) vs O(n²))
   * - Limits max file tags per render to avoid expensive DOM operations
   * - Skips processing for very large text to prevent UI freeze
   */
  const renderFileTags = useCallback(() => {
    const timer = perfTimer('renderFileTags');
    if (!editableRef.current) return;

    // Regex: match @filepath (ending with space or string end)
    // Supports files and directories: extension is optional
    // Supports Windows paths (backslash) and Unix paths (forward slash)
    // Matches all characters except space and @ (including backslash, forward slash, colon, etc.)
    const fileRefRegex = /@([^\s@]+?)(\s|$)/g;

    const currentText = getTextContent();
    timer.mark('getText');

    // Performance optimization: Skip for very large text
    // This prevents UI freeze when pasting massive content
    if (currentText.length > TEXT_LENGTH_THRESHOLDS.FILE_TAG_RENDERING) {
      // Log warning in debug mode so developers are aware
      if (import.meta.env.DEV) {
        console.warn(
          `[useFileTags] Skipping file tag rendering for large text (${currentText.length} chars > ${TEXT_LENGTH_THRESHOLDS.FILE_TAG_RENDERING} threshold)`
        );
      }
      timer.mark('skip-large-text');
      timer.end();
      return;
    }

    const matches = Array.from(currentText.matchAll(fileRefRegex));
    timer.mark('regex');

    if (matches.length === 0) {
      // No file references, keep as is
      timer.end();
      return;
    }

    // Performance optimization: Limit max file tags per render
    const limitedMatches =
      matches.length > RENDERING_LIMITS.MAX_FILE_TAGS_PER_RENDER
        ? matches.slice(0, RENDERING_LIMITS.MAX_FILE_TAGS_PER_RENDER)
        : matches;

    // Check if there are plain text @filepath in DOM that need conversion
    // Traverse all text nodes, looking for text containing @
    let hasUnrenderedReferences = false;
    const walk = (node: Node) => {
      if (hasUnrenderedReferences) return; // Early exit if found
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (text.includes('@')) {
          hasUnrenderedReferences = true;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        // Skip already rendered file tags
        if (!element.classList.contains('file-tag')) {
          node.childNodes.forEach(walk);
        }
      }
    };
    editableRef.current.childNodes.forEach(walk);

    // If no unrendered references, no need to re-render
    if (!hasUnrenderedReferences) {
      timer.mark('no-unrendered');
      timer.end();
      return;
    }
    timer.mark('dom-check');

    // Build new HTML content using array + join (O(n) vs O(n²) string concatenation)
    const htmlParts: string[] = [];
    let lastIndex = 0;

    limitedMatches.forEach((match) => {
      const fullMatch = match[0];
      const filePath = match[1];
      const matchIndex = match.index || 0;

      // Add text before match
      if (matchIndex > lastIndex) {
        const textBefore = currentText.substring(lastIndex, matchIndex);
        htmlParts.push(escapeHtmlText(textBefore));
      }

      // Separate path and line number (e.g., src/file.ts#L10-20 -> src/file.ts)
      const hashIndex = filePath.indexOf('#');
      const pureFilePath = hashIndex !== -1 ? filePath.substring(0, hashIndex) : filePath;

      // Get pure filename (no line number, for getting icon)
      const pureFileName = pureFilePath.split(/[/\\]/).pop() || pureFilePath;

      // Validate if path is a valid reference (must exist in pathMappingRef)
      // Only files selected from dropdown list are recorded in pathMappingRef
      // Also allow paths with line numbers (e.g. #L10-20) or absolute paths
      const hasLineNumber = /#L\d+/.test(filePath);
      const isAbsolutePath = /^[a-zA-Z]:[/\\]/.test(filePath) || filePath.startsWith('/');
      const isValidReference =
        pathMappingRef.current.has(pureFilePath) ||
        pathMappingRef.current.has(pureFileName) ||
        pathMappingRef.current.has(filePath) ||
        hasLineNumber ||
        isAbsolutePath;

      // If not a valid reference, keep original text, don't render as tag
      if (!isValidReference) {
        htmlParts.push(escapeHtmlText(fullMatch));
        lastIndex = matchIndex + fullMatch.length;
        return;
      }

      // Get display filename (with line number, for display)
      const displayFileName = filePath.split(/[/\\]/).pop() || filePath;
      const escapedDisplayFileName = escapeHtmlText(displayFileName);

      /**
       * Protocol type detection for special references.
       *
       * Supported protocols:
       * - terminal:// - Terminal session output
       * - service://  - Run/Debug service output
       *
       * To add a new protocol type:
       * 1. Add protocol check here (e.g., const isNewProtocol = pureFilePath.startsWith('newprotocol://'))
       * 2. Add icon selection in the iconSvg logic below
       * 3. Update backend ClaudeSession.java processReferences() method
       * 4. Import the corresponding icon SVG
       *
       * Future protocol candidates:
       * - git://      - Git diff/status output
       * - browser://  - Browser/DevTools context
       * - debug://    - Debug session variables
       */
      const isTerminal = pureFilePath.startsWith('terminal://');
      const isService = pureFilePath.startsWith('service://');

      // Determine if file or directory (only when not terminal/service)
      const isDirectory = !isTerminal && !isService && !pureFileName.includes('.');

      let iconSvg = '';
      if (isTerminal) {
        iconSvg = icon_terminal;
      } else if (isService) {
        iconSvg = icon_server;
      } else if (isDirectory) {
        iconSvg = icon_folder;
      } else {
        const extension = pureFileName.indexOf('.') !== -1 ? pureFileName.split('.').pop() : '';
        iconSvg = getFileIcon(extension, pureFileName);
      }

      // Escape file path for safe HTML attribute
      const escapedPath = escapeHtmlAttr(filePath);

      // Try to get full path from path mapping (for tooltip display)
      const fullPath =
        pathMappingRef.current.get(pureFilePath) ||
        pathMappingRef.current.get(pureFileName) ||
        filePath;
      const escapedFullPath = escapeHtmlAttr(fullPath);

      // Create file tag HTML - use array push instead of string concatenation
      htmlParts.push(
        `<span class="file-tag has-tooltip" contenteditable="false" data-file-path="${escapedPath}" data-tooltip="${escapedFullPath}">`,
        `<span class="file-tag-icon">${iconSvg}</span>`,
        `<span class="file-tag-text">${escapedDisplayFileName}</span>`,
        `<span class="file-tag-close">&times;</span>`,
        `</span>`,
        ' '
      );

      lastIndex = matchIndex + fullMatch.length;
    });

    // Add remaining text
    if (lastIndex < currentText.length) {
      htmlParts.push(escapeHtmlText(currentText.substring(lastIndex)));
    }

    // Join all parts into final HTML
    const newHTML = htmlParts.join('');
    timer.mark('build-html');

    // Set flag before updating innerHTML to prevent triggering completion detection
    justRenderedTagRef.current = true;
    onCloseCompletions();

    // Update content
    editableRef.current.innerHTML = newHTML;
    timer.mark('set-innerHTML');

    // Restore cursor position to end
    const selection = window.getSelection();
    if (selection && editableRef.current.childNodes.length > 0) {
      try {
        const range = document.createRange();
        const lastChild = editableRef.current.lastChild;
        if (lastChild) {
          range.setStartAfter(lastChild);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch {
        // Ignore cursor restore errors
      }
    }

    // After rendering, reset flag to allow subsequent completion detection
    // Use setTimeout 0 to ensure reset after current event loop
    setTimeout(() => {
      justRenderedTagRef.current = false;
    }, 0);

    timer.end();
  }, [editableRef, getTextContent, onCloseCompletions, escapeHtmlText]);

  /**
   * Extract all file tags from current input
   * Returns array of file tag info with display path and absolute path
   * Used for sending to backend for context injection (especially for Codex)
   */
  const extractFileTags = useCallback((): FileTagInfo[] => {
    if (!editableRef.current) return [];

    return Array.from(editableRef.current.querySelectorAll('.file-tag'))
      .map((element) => {
        const displayPath = element.getAttribute('data-file-path') || '';
        if (!displayPath) return null;
        const absolutePath = element.getAttribute('data-tooltip') || displayPath;
        return { displayPath, absolutePath } satisfies FileTagInfo;
      })
      .filter((tag): tag is FileTagInfo => tag !== null);
  }, [editableRef]);

  return {
    renderFileTags,
    pathMappingRef,
    justRenderedTagRef,
    extractFileTags,
  };
}
