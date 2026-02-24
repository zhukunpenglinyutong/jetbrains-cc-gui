import { useEffect } from 'react';
import type { MutableRefObject } from 'react';

export interface UseControlledValueSyncOptions {
  value: string | undefined;
  editableRef: React.RefObject<HTMLDivElement | null>;
  isComposingRef: MutableRefObject<boolean>;
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
 * - The editable element does NOT have focus (user is not actively typing)
 * - External value differs from current DOM content
 *
 * When the element has focus, the DOM is the source of truth and the `value` prop
 * may lag behind due to debounced onInput callbacks. Overwriting innerText while
 * the user types causes characters to disappear.
 */
export function useControlledValueSync({
  value,
  editableRef,
  isComposingRef,
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

    // Skip sync while the user is focused on the editable element.
    // The DOM content is ahead of the `value` prop due to debounced onInput,
    // so overwriting innerText here would lose the most recent keystrokes.
    if (document.activeElement === editableRef.current) return;

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
    isExternalUpdateRef,
    getTextContent,
    setHasContent,
    adjustHeight,
    invalidateCache,
  ]);
}
