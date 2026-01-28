import { useCallback } from 'react';
import type { Attachment } from '../types.js';
import { generateId } from '../utils/generateId.js';
import { insertTextAtCursor } from '../utils/selectionUtils.js';
import { perfTimer } from '../../../utils/debug.js';

declare global {
  interface Window {
    getClipboardFilePath?: () => Promise<string>;
  }
}

interface UsePasteAndDropOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  pathMappingRef: React.MutableRefObject<Map<string, string>>;
  getTextContent: () => string;
  adjustHeight: () => void;
  renderFileTags: () => void;
  setHasContent: (hasContent: boolean) => void;
  setInternalAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onInput?: (content: string) => void;
  fileCompletion: { close: () => void };
  commandCompletion: { close: () => void };
  handleInput: () => void;
}

interface UsePasteAndDropReturn {
  /** Handle paste event - detect images and plain text */
  handlePaste: (e: React.ClipboardEvent) => void;
  /** Handle drag over event */
  handleDragOver: (e: React.DragEvent) => void;
  /** Handle drop event - detect images and file paths */
  handleDrop: (e: React.DragEvent) => void;
}

/**
 * usePasteAndDrop - Handle paste and drag-drop operations
 *
 * Features:
 * - Paste images as attachments (Base64 encoded)
 * - Paste text including file paths
 * - Drag and drop files/images
 * - Auto-create file references from dropped paths
 */
export function usePasteAndDrop({
  editableRef,
  pathMappingRef,
  getTextContent,
  adjustHeight,
  renderFileTags,
  setHasContent,
  setInternalAttachments,
  onInput,
  fileCompletion,
  commandCompletion,
  handleInput,
}: UsePasteAndDropOptions): UsePasteAndDropReturn {
  /**
   * Handle paste event - detect images and plain text
   */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;

      if (!items) {
        return;
      }

      // Check if there's a real image (type is image/*)
      let hasImage = false;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Only process real image types (type starts with image/)
        if (item.type.startsWith('image/')) {
          hasImage = true;
          e.preventDefault();

          const blob = item.getAsFile();

          if (blob) {
            // Read image as Base64
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = (reader.result as string).split(',')[1];
              const mediaType = blob.type || item.type || 'image/png';
              const ext = (() => {
                if (mediaType && mediaType.includes('/')) {
                  return mediaType.split('/')[1];
                }
                const name = blob.name || '';
                const m = name.match(/\.([a-zA-Z0-9]+)$/);
                return m ? m[1] : 'png';
              })();
              const attachment: Attachment = {
                id: generateId(),
                fileName: `pasted-image-${Date.now()}.${ext}`,
                mediaType,
                data: base64,
              };

              setInternalAttachments((prev) => [...prev, attachment]);
            };
            reader.readAsDataURL(blob);
          }

          return;
        }
      }

      // If no image, try to get text or file path
      if (!hasImage) {
        e.preventDefault();

        // Try multiple ways to get text
        let text =
          e.clipboardData.getData('text/plain') ||
          e.clipboardData.getData('text/uri-list') ||
          e.clipboardData.getData('text/html');

        // If still no text, try to get filename/path from file type item
        if (!text) {
          // Check if there's a file type item
          let hasFileItem = false;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
              hasFileItem = true;
              break;
            }
          }

          // If there's a file type item, try to get full path via Java side
          if (hasFileItem && window.getClipboardFilePath) {
            window
              .getClipboardFilePath()
              .then((fullPath: string) => {
                if (fullPath && fullPath.trim()) {
                  // Insert full path using modern Selection API
                  insertTextAtCursor(fullPath, editableRef.current);
                  handleInput();
                }
              })
              .catch(() => {
                // Ignore errors
              });
            return;
          }
        }

        if (text && text.trim()) {
          const timer = perfTimer('handlePaste-text');
          timer.mark(`text-length:${text.length}`);

          // Use modern Selection API to insert plain text (maintains cursor position)
          insertTextAtCursor(text, editableRef.current);
          timer.mark('insertText');

          // Trigger input event to update state
          handleInput();
          timer.mark('handleInput');

          timer.end();
        }
      }
    },
    [setInternalAttachments, handleInput]
  );

  /**
   * Handle drag over event
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Set drop effect to copy
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  /**
   * Handle drop event - detect images and file paths
   */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // First get text content (file path)
      const text = e.dataTransfer?.getData('text/plain');

      // Then check file objects
      const files = e.dataTransfer?.files;

      // Check if there are actual image file objects
      let hasImageFile = false;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];

          // Only process image files
          if (file.type.startsWith('image/')) {
            hasImageFile = true;
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = (reader.result as string).split(',')[1];
              const ext = (() => {
                if (file.type && file.type.includes('/')) {
                  return file.type.split('/')[1];
                }
                const m = file.name.match(/\.([a-zA-Z0-9]+)$/);
                return m ? m[1] : 'png';
              })();
              const attachment: Attachment = {
                id: generateId(),
                fileName: file.name || `dropped-image-${Date.now()}.${ext}`,
                mediaType: file.type || 'image/png',
                data: base64,
              };

              setInternalAttachments((prev) => [...prev, attachment]);
            };
            reader.readAsDataURL(file);
          }
        }
      }

      // If there are image files, don't process text
      if (hasImageFile) {
        return;
      }

      // No image files, process text (file path or other text)
      if (text && text.trim()) {
        // Extract file path and add to path mapping
        const filePath = text.trim();
        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        // Add path to pathMappingRef to make it a "valid reference"
        pathMappingRef.current.set(fileName, filePath);
        pathMappingRef.current.set(filePath, filePath);

        // Auto-add @ prefix (if not already present), and add space to trigger rendering
        const textToInsert = (text.startsWith('@') ? text : `@${text}`) + ' ';

        // Get current cursor position
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0 && editableRef.current) {
          // Ensure cursor is inside input box
          if (editableRef.current.contains(selection.anchorNode)) {
            // Use modern API to insert text
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const textNode = document.createTextNode(textToInsert);
            range.insertNode(textNode);

            // Move cursor after inserted text
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          } else {
            // Cursor not inside input box, append to end
            // Use appendChild instead of innerText to avoid breaking existing file tags
            const textNode = document.createTextNode(textToInsert);
            editableRef.current.appendChild(textNode);

            // Move cursor to end
            const range = document.createRange();
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else {
          // No selection, append to end
          if (editableRef.current) {
            const textNode = document.createTextNode(textToInsert);
            editableRef.current.appendChild(textNode);
          }
        }

        // Close completion menus
        fileCompletion.close();
        commandCompletion.close();

        // Directly trigger state update, don't call handleInput (avoid re-detecting completion)
        const newText = getTextContent();
        setHasContent(!!newText.trim());
        adjustHeight();
        onInput?.(newText);

        // Immediately render file tags (don't wait for space)
        setTimeout(() => {
          renderFileTags();
        }, 50);
      }
    },
    [
      editableRef,
      pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags,
      setHasContent,
      setInternalAttachments,
      onInput,
      fileCompletion,
      commandCompletion,
    ]
  );

  return {
    handlePaste,
    handleDragOver,
    handleDrop,
  };
}
