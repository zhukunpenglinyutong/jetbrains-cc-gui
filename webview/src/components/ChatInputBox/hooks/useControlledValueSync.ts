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
 * - External value differs from current DOM content
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

