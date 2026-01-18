import { useEffect } from 'react';

interface UseGlobalCallbacksOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  pathMappingRef: React.MutableRefObject<Map<string, string>>;
  getTextContent: () => string;
  adjustHeight: () => void;
  renderFileTags: () => void;
  setHasContent: (hasContent: boolean) => void;
  onInput?: (content: string) => void;
  fileCompletion: { close: () => void };
  commandCompletion: { close: () => void };
  focusInput: () => void;
}

declare global {
  interface Window {
    handleFilePathFromJava?: (filePath: string) => void;
    insertCodeSnippetAtCursor?: (selectionInfo: string) => void;
  }
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
  fileCompletion,
  commandCompletion,
  focusInput,
}: UseGlobalCallbacksOptions): void {
  // Register global function to receive file path from Java
  useEffect(() => {
    window.handleFilePathFromJava = (filePath: string) => {
      if (!editableRef.current) return;

      // Extract file path and add to path mapping
      const absolutePath = filePath.trim();
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

      // Close completion menus
      fileCompletion.close();
      commandCompletion.close();

      // Directly trigger state update, don't call handleInput (avoid re-detecting completion)
      const newText = getTextContent();
      setHasContent(!!newText.trim());
      adjustHeight();
      onInput?.(newText);

      // Immediately render file tags
      setTimeout(() => {
        renderFileTags();
      }, 50);
    };

    // Initial focus
    focusInput();

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
    fileCompletion,
    commandCompletion,
    focusInput,
  ]);

  // Register global method: insert code snippet at cursor position
  useEffect(() => {
    window.insertCodeSnippetAtCursor = (selectionInfo: string) => {
      if (!editableRef.current) return;

      // Ensure input box has focus
      editableRef.current.focus();

      // Insert text at cursor position
      const selection = window.getSelection();
      if (
        selection &&
        selection.rangeCount > 0 &&
        editableRef.current.contains(selection.anchorNode)
      ) {
        // Cursor inside input box, insert at cursor position
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(selectionInfo + ' ');
        range.insertNode(textNode);

        // Move cursor after inserted text
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        // Cursor not inside input box, append to end
        const textNode = document.createTextNode(selectionInfo + ' ');
        editableRef.current.appendChild(textNode);

        // Move cursor to end
        const range = document.createRange();
        range.setStartAfter(textNode);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }

      // Trigger state update
      const newText = getTextContent();
      setHasContent(!!newText.trim());
      adjustHeight();
      onInput?.(newText);

      // Immediately render file tags
      setTimeout(() => {
        renderFileTags();
        // Re-focus after rendering
        editableRef.current?.focus();
      }, 50);
    };

    return () => {
      delete window.insertCodeSnippetAtCursor;
    };
  }, [editableRef, getTextContent, renderFileTags, adjustHeight, onInput, setHasContent]);
}
