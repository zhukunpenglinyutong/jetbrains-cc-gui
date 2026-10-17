import { useImperativeHandle } from 'react';
import type { ForwardedRef } from 'react';
import type { ChatInputBoxHandle, FileTagInfo } from '../types.js';

export interface UseChatInputImperativeHandleOptions {
  ref: ForwardedRef<ChatInputBoxHandle>;
  editableRef: React.RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  invalidateCache: () => void;
  cancelPendingInput: () => void;
  /** Replacing or clearing a draft also cancels its unfinished clipboard work. */
  invalidateImagePastes?: () => void;
  setHasContent: (hasContent: boolean) => void;
  adjustHeight: () => void;
  focusInput: () => void;
  clearInput: () => void;
  hasContent: boolean;
  extractFileTags: () => FileTagInfo[];
}

/**
 * useChatInputImperativeHandle - Exposes an imperative API for the input box
 *
 * Keeps the parent API stable without forcing additional re-renders.
 */
export function useChatInputImperativeHandle({
  ref,
  editableRef,
  getTextContent,
  invalidateCache,
  cancelPendingInput,
  invalidateImagePastes,
  setHasContent,
  adjustHeight,
  focusInput,
  clearInput,
  hasContent,
  extractFileTags,
}: UseChatInputImperativeHandleOptions): void {
  useImperativeHandle(
    ref,
    () => ({
      getValue: () => {
        invalidateCache();
        return getTextContent();
      },
      setValue: (newValue: string) => {
        if (!editableRef.current) return;
        invalidateImagePastes?.();
        cancelPendingInput();
        editableRef.current.innerText = newValue;
        setHasContent(!!newValue.trim());
        adjustHeight();
        invalidateCache();

        if (newValue) {
          const range = document.createRange();
          const selection = window.getSelection();
          if (!selection) return;

          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      },
      focus: focusInput,
      clear: () => {
        invalidateImagePastes?.();
        clearInput();
      },
      hasContent: () => hasContent,
      getFileTags: extractFileTags,
    }),
    [
      getTextContent,
      invalidateCache,
      cancelPendingInput,
      invalidateImagePastes,
      editableRef,
      setHasContent,
      adjustHeight,
      focusInput,
      clearInput,
      hasContent,
      extractFileTags,
    ]
  );
}

