import { useEffect } from 'react';
import { createTextFragment } from '../utils/selectionUtils.js';
import { makeQuoteToken, registerQuote } from '../utils/quoteRegistry.js';

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
     * Insert a single file path into the input box
     */
    const insertSingleFilePath = (filePath: string) => {
      if (!editableRef.current) return;

      const absolutePath = filePath.trim();
      if (!absolutePath) return;

      // Add path to path mapping
      const fileName = absolutePath.split(/[/\\]/).pop() || absolutePath;

      // Add path to pathMappingRef to make it a "valid reference"
      pathMappingRef.current.set(fileName, absolutePath);
      pathMappingRef.current.set(absolutePath, absolutePath);

      // Insert file path into input box (auto-add @ prefix), add space to trigger rendering
      const pathToInsert = (filePath.startsWith('@') ? filePath : `@${filePath}`) + ' ';

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
          const textNode = document.createTextNode(pathToInsert);
          editableRef.current.appendChild(textNode);
          const appendRange = document.createRange();
          appendRange.setStartAfter(textNode);
          appendRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(appendRange);
        } else {
          range.deleteContents();
          const textNode = document.createTextNode(pathToInsert);
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
        const textNode = document.createTextNode(pathToInsert);
        editableRef.current.appendChild(textNode);

        // Move cursor to end
        const range = document.createRange();
        range.setStartAfter(textNode);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    };

    window.handleFilePathFromJava = (filePathInput: string | string[]) => {
      try {
        if (!editableRef.current) return;

        // Normalize input to string array.
        // Java side (v0.1.9+) passes a JS array directly via executeJavaScript,
        // so Array.isArray branch is the primary path.
        // The string branch is kept for backward compatibility with older Java
        // versions that passed a single string. It can be removed once v0.1.8
        // support is no longer needed.
        let filePaths: string[];
        if (Array.isArray(filePathInput)) {
          filePaths = filePathInput;
        } else if (typeof filePathInput === 'string') {
          try {
            const parsed: unknown = JSON.parse(filePathInput);
            filePaths = Array.isArray(parsed) ? parsed : [filePathInput];
          } catch {
            filePaths = [filePathInput];
          }
        } else {
          return;
        }

        // Insert all file paths
        for (const filePath of filePaths) {
          if (filePath && filePath.trim()) {
            insertSingleFilePath(filePath.trim());
          }
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
        console.error('[useGlobalCallbacks] handleFilePathFromJava failed:', error);
      }
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

        // Read caret BEFORE focus() to avoid focus side-effects on selection.
        // If caret is inside the editable, insert at caret. Otherwise (e.g. window
        // just regained focus from an external IDE action with no prior caret),
        // fall back to appending at the end with a leading newline separator.
        const insertedAtCaret = tryInsertExternalSnippetAtCaret(selectionInfo);

        if (!insertedAtCaret) {
          editableRef.current.focus();
          appendExternalSnippetToEnd(selectionInfo);
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
  }, [editableRef, getTextContent, renderFileTags, renderQuoteTags, adjustHeight, onInput, setHasContent, focusInput]);
}
