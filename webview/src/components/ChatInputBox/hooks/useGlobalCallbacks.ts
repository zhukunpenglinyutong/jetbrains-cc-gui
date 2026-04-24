import { useEffect } from 'react';
import { createTextFragment } from '../utils/selectionUtils.js';

interface UseGlobalCallbacksOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  pathMappingRef: React.MutableRefObject<Map<string, string>>;
  getTextContent: () => string;
  adjustHeight: () => void;
  renderFileTags: () => void;
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
        range.deleteContents();
        const textNode = document.createTextNode(pathToInsert);
        range.insertNode(textNode);

        // Move cursor after inserted text
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
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

    window.insertCodeSnippetAtCursor = (selectionInfo: string) => {
      try {
        if (!editableRef.current) return;

        // Ensure input box has focus
        editableRef.current.focus();
        appendExternalSnippetToEnd(selectionInfo);

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

    return () => {
      delete window.insertCodeSnippetAtCursor;
    };
  }, [editableRef, getTextContent, renderFileTags, adjustHeight, onInput, setHasContent]);
}
