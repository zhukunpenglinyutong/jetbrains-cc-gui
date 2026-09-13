import { useEffect } from 'react';
import { createTextFragment } from '../utils/selectionUtils.js';
import { makeQuoteToken, registerQuote } from '../utils/quoteRegistry.js';
import {
  registerAbsoluteFileReference,
  registerLineFileReference,
} from '../utils/fileReferences.js';

interface UseGlobalCallbacksOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  pathMappingRef: React.MutableRefObject<Map<string, string>>;
  getTextContent: () => string;
  adjustHeight: () => void;
  renderFileTags: () => void;
  renderQuoteTags: () => void;
  setHasContent: (hasContent: boolean) => void;
  onInput?: (content: string) => void;
  closeAllCompletions: () => void;
  focusInput: () => void;
}

/**
 * useGlobalCallbacks - Register global callback functions for Java interop
 *
 * Registers window functions that Java can call to:
 * - Insert file paths into the input
 * - Insert code snippets at cursor position
 */
export function useGlobalCallbacks({
  editableRef,
  pathMappingRef,
  getTextContent,
  adjustHeight,
  renderFileTags,
  renderQuoteTags,
  setHasContent,
  onInput,
  closeAllCompletions,
  focusInput,
}: UseGlobalCallbacksOptions): void {
  // Register global function to receive file path from Java
  useEffect(() => {
    /**
     * Insert text at the caret, or append at the end when the caret is not a
     * valid insertion point inside the input box.
     */
    const insertTextAtCaretOrEnd = (textToInsert: string) => {
      if (!editableRef.current) return;

      const selection = window.getSelection();
      if (
        selection &&
        selection.rangeCount > 0 &&
        editableRef.current.contains(selection.anchorNode)
      ) {
        // Cursor inside input box, insert at cursor position
        const range = selection.getRangeAt(0);
        // File paths arrive from IDE actions (project tree / right-click), not
        // from typing. A stale non-collapsed selection must not be replaced by
        // deleteContents() - that wiped the existing content (#1700). Only a
        // collapsed caret is a real insertion point; otherwise append at end.
        if (!range.collapsed) {
          const textNode = document.createTextNode(textToInsert);
          editableRef.current.appendChild(textNode);
          const appendRange = document.createRange();
          appendRange.setStartAfter(textNode);
          appendRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(appendRange);
        } else {
          range.deleteContents();
          const textNode = document.createTextNode(textToInsert);
          range.insertNode(textNode);

          // Move cursor after inserted text
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } else {
        // Cursor not inside input box, append to end
        // Use appendChild instead of innerText to avoid breaking existing file tags
        const textNode = document.createTextNode(textToInsert);
        editableRef.current.appendChild(textNode);

        // Move cursor to end
        const range = document.createRange();
        range.setStartAfter(textNode);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    };

    /**
     * Insert a single file path into the input box
     */
    const insertSingleFilePath = (filePath: string): boolean => {
      if (!editableRef.current) return false;

      const absolutePath = registerAbsoluteFileReference(pathMappingRef.current, filePath);
      if (!absolutePath) return false;

      // File identity comes from exact registration, not inferred separators.
      insertTextAtCaretOrEnd(`@${absolutePath} `);
      return true;
    };

    const normalizeFilePathInput = (
      filePathInput: string | string[],
      allowJsonArrayString: boolean,
    ): string[] => {
      if (Array.isArray(filePathInput)) {
        return filePathInput.filter((filePath): filePath is string => typeof filePath === 'string');
      }
      if (typeof filePathInput !== 'string') return [];

      if (allowJsonArrayString) {
        try {
          const parsed: unknown = JSON.parse(filePathInput);
          if (Array.isArray(parsed)) {
            return parsed.filter((filePath): filePath is string => typeof filePath === 'string');
          }
        } catch {
          // Treat the legacy string as one path below.
        }
      }
      return [filePathInput];
    };

    const insertFileReferences = (
      filePathInput: string | string[],
      allowJsonArrayString = false,
    ) => {
      try {
        if (!editableRef.current) return;

        const filePaths = normalizeFilePathInput(filePathInput, allowJsonArrayString);
        let handledCount = 0;
        for (const filePath of filePaths) {
          if (insertSingleFilePath(filePath)) {
            handledCount++;
            continue;
          }
          // Never silently drop content from a Java bridge: a payload that
          // fails strict registration (e.g. a legacy relative path) is kept
          // as ordinary text instead of becoming an unrenderable file tag.
          const plainText = filePath?.trim();
          if (plainText) {
            console.warn(
              '[useGlobalCallbacks] Not an absolute file reference, inserting as plain text:',
              plainText,
            );
            insertTextAtCaretOrEnd(`${plainText} `);
            handledCount++;
          }
        }
        if (handledCount === 0) {
          return;
        }

        // Close all completion menus
        closeAllCompletions();

        // Directly trigger state update, don't call handleInput (avoid re-detecting completion)
        const newText = getTextContent();
        setHasContent(!!newText.trim());
        adjustHeight();
        onInput?.(newText);

        // Render file tags on next frame
        requestAnimationFrame(() => {
          renderFileTags();
        });
      } catch (error) {
        console.error('[useGlobalCallbacks] insertFileReferencesAtCursor failed:', error);
      }
    };

    // Dedicated structured bridge used by the project-tree action. The Java
    // side passes an actual array literal, while the string form supports one
    // legacy path without guessing where spaces should split.
    window.insertFileReferencesAtCursor = (filePathInput: string | string[]) => {
      insertFileReferences(filePathInput);
    };

    // Keep the older callback for compatibility with existing integrations.
    window.handleFilePathFromJava = (filePathInput: string | string[]) => {
      insertFileReferences(filePathInput, true);
    };

    // Initial focus — but only if no other input/editable element is focused (B-013)
    const active = document.activeElement;
    const isOtherInputFocused = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable && active !== editableRef.current);
    if (!isOtherInputFocused) {
      focusInput();
    }

    // Cleanup function
    return () => {
      delete window.insertFileReferencesAtCursor;
      delete window.handleFilePathFromJava;
    };
  }, [
    editableRef,
    pathMappingRef,
    getTextContent,
    adjustHeight,
    renderFileTags,
    setHasContent,
    onInput,
    closeAllCompletions,
    focusInput,
  ]);

  // Register global method: insert code snippet at cursor position
  useEffect(() => {
    const moveCaretAfterNode = (lastChild: ChildNode | null) => {
      if (!lastChild) {
        return;
      }

      const selection = window.getSelection();
      const range = document.createRange();
      range.setStartAfter(lastChild);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    const appendExternalSnippetToEnd = (selectionInfo: string) => {
      if (!editableRef.current) return;

      const existingText = getTextContent();
      const hasExistingContent = !!existingText.trim();
      const needsLeadingNewline = hasExistingContent && !/\n\s*$/.test(existingText);
      const fragment = createTextFragment(
        `${needsLeadingNewline ? '\n' : ''}${selectionInfo} `
      );
      const lastChild = fragment.lastChild;

      editableRef.current.appendChild(fragment);
      moveCaretAfterNode(lastChild);
    };

    const tryInsertExternalSnippetAtCaret = (selectionInfo: string): boolean => {
      if (!editableRef.current) return false;

      const selection = window.getSelection();
      if (
        !selection ||
        selection.rangeCount === 0 ||
        !editableRef.current.contains(selection.anchorNode)
      ) {
        return false;
      }

      const range = selection.getRangeAt(0);
      // External snippets come from IDE actions (editor selection), never from
      // typing inside the input. A stale NON-collapsed selection (user last
      // selected text in the box, then went back to the editor) must not be
      // replaced by deleteContents() - that wiped the existing content (#1700).
      // Only a collapsed caret is a real insertion point; otherwise fall back
      // to appending at the end.
      if (!range.collapsed) {
        return false;
      }
      range.deleteContents();
      const fragment = createTextFragment(`${selectionInfo} `);
      const lastChild = fragment.lastChild;
      range.insertNode(fragment);

      if (lastChild) {
        range.setStartAfter(lastChild);
      }
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    };

    window.insertCodeSnippetAtCursor = (selectionInfo: string) => {
      try {
        if (!editableRef.current) return;

        // The generic bridge remains for selected code. Only the strict
        // single line-number form is registered as a file reference; ordinary
        // code and arbitrary @ text are inserted byte-for-byte as snippets.
        const lineReference = registerLineFileReference(pathMappingRef.current, selectionInfo);
        const normalizedSelectionInfo = lineReference
          ? `@${lineReference}`
          : selectionInfo;

        // Read caret BEFORE focus() to avoid focus side-effects on selection.
        // If caret is inside the editable, insert at caret. Otherwise (e.g. window
        // just regained focus from an external IDE action with no prior caret),
        // fall back to appending at the end with a leading newline separator.
        const insertedAtCaret = tryInsertExternalSnippetAtCaret(normalizedSelectionInfo);

        if (!insertedAtCaret) {
          editableRef.current.focus();
          appendExternalSnippetToEnd(normalizedSelectionInfo);
        }

        // Trigger state update
        const newText = getTextContent();
        setHasContent(!!newText.trim());
        adjustHeight();
        onInput?.(newText);

        // Render file tags on next frame
        requestAnimationFrame(() => {
          renderFileTags();
          // Re-focus after rendering
          editableRef.current?.focus();
        });
      } catch (error) {
        console.error('[useGlobalCallbacks] insertCodeSnippetAtCursor failed:', error);
      }
    };

    window.focusChatInput = () => {
      focusInput();
    };

    // Insert an inline quote chip. Payload: JSON { text }.
    // The chip renders a compact preview; the full Markdown blockquote is
    // expanded from the registry only when the message is sent.
    window.addQuotedSnippet = (payload: string) => {
      try {
        if (!editableRef.current) return;

        let quoteText = '';
        try {
          const parsed = JSON.parse(payload) as { text?: unknown };
          quoteText = typeof parsed.text === 'string' ? parsed.text : '';
        } catch {
          quoteText = payload;
        }
        if (!quoteText.trim()) return;

        const token = makeQuoteToken(registerQuote(quoteText));

        const selection = window.getSelection();
        const insertAtCaret =
          selection &&
          selection.rangeCount > 0 &&
          editableRef.current.contains(selection.anchorNode);

        if (insertAtCaret) {
          const range = selection.getRangeAt(0);
          // Quote chips arrive from external actions, not from typing. A stale
          // non-collapsed selection must not be replaced by deleteContents() -
          // that wiped the existing content (#1700). Fall back to appending.
          if (!range.collapsed) {
            editableRef.current.focus();
            const tokenNode = document.createTextNode(token);
            editableRef.current.appendChild(tokenNode);
            const appendRange = document.createRange();
            appendRange.setStartAfter(tokenNode);
            appendRange.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(appendRange);
          } else {
            range.deleteContents();
            const tokenNode = document.createTextNode(token);
            range.insertNode(tokenNode);
            range.setStartAfter(tokenNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else {
          editableRef.current.focus();
          const tokenNode = document.createTextNode(token);
          editableRef.current.appendChild(tokenNode);
          const range = document.createRange();
          range.setStartAfter(tokenNode);
          range.collapse(true);
          const endSelection = window.getSelection();
          endSelection?.removeAllRanges();
          endSelection?.addRange(range);
        }

        // Turn the freshly inserted token into a chip, then sync input state.
        renderQuoteTags();

        const newText = getTextContent();
        setHasContent(!!newText.trim());
        adjustHeight();
        onInput?.(newText);

        requestAnimationFrame(() => {
          editableRef.current?.focus();
        });
      } catch (error) {
        console.error('[useGlobalCallbacks] addQuotedSnippet failed:', error);
      }
    };

    return () => {
      delete window.insertCodeSnippetAtCursor;
      delete window.focusChatInput;
      delete window.addQuotedSnippet;
    };
  }, [editableRef, pathMappingRef, getTextContent, renderFileTags, renderQuoteTags, adjustHeight, onInput, setHasContent, focusInput]);
}
