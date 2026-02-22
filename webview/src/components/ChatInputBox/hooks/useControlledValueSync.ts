import { useEffect } from 'react';
import type { MutableRefObject } from 'react';

export interface UseControlledValueSyncOptions {
  value: string | undefined;
  editableRef: React.RefObject<HTMLDivElement | null>;
  isComposingRef: MutableRefObject<boolean>;
  isInputDirtyRef: MutableRefObject<boolean>;
  isExternalUpdateRef: MutableRefObject<boolean>;
  getTextContent: () => string;
  setHasContent: (hasContent: boolean) => void;
  adjustHeight: () => void;
  invalidateCache: () => void;
}

/**
 * useControlledValueSync - Sync external `value` into the contenteditable input
 *
 * Only updates when:
 * - `value` is provided (controlled mode)
 * - Not currently in IME composition
 * - Input is not dirty (user hasn't typed since last debounce)
 * - External value differs from current DOM content
 */
export function useControlledValueSync({
  value,
  editableRef,
  isComposingRef,
  isInputDirtyRef,
  isExternalUpdateRef,
  getTextContent,
  setHasContent,
  adjustHeight,
  invalidateCache,
}: UseControlledValueSyncOptions): void {
  useEffect(() => {
    if (value === undefined) return;
    if (!editableRef.current) return;
    if (isComposingRef.current) return;

    // Skip sync while user is actively typing (between keystroke and debounce fire).
    // The DOM is ahead of the debounced state value — overwriting would lose keystrokes.
    if (isInputDirtyRef.current) return;

    invalidateCache();
    const currentText = getTextContent();

    if (currentText !== value) {
      isExternalUpdateRef.current = true;

      editableRef.current.innerText = value;
      setHasContent(!!value.trim());
      adjustHeight();

      if (value) {
        const range = document.createRange();
        const selection = window.getSelection();
        if (!selection) return;

        range.selectNodeContents(editableRef.current);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      invalidateCache();
    }
  }, [
    value,
    editableRef,
    isComposingRef,
    isInputDirtyRef,
    isExternalUpdateRef,
    getTextContent,
    setHasContent,
    adjustHeight,
    invalidateCache,
  ]);
}
