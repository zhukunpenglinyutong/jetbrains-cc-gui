import { useImperativeHandle } from 'react';
import type { ForwardedRef } from 'react';
import type { Attachment, ChatInputBoxHandle, FileTagInfo } from '../types.js';

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
  /** Draft attachments currently staged on the input (queue edit restore reads them) */
  getAttachments: () => Attachment[];
  /** Replace the draft attachments (queue edit restore); false when externally controlled */
  setAttachments: (attachments: Attachment[]) => boolean;
  /** Whether attachments are owned by this input; defaults to true when absent */
  canApplyAttachments?: () => boolean;
  /** Whether a pasted image is still landing in the draft; defaults to false when absent */
  hasPendingImagePastes?: () => boolean;
  /**
   * Renders the rich references (@file chips, quote chips) inside the input.
   * A programmatic value write is plain text, so this has to run afterwards to
   * restore the rendered look of the draft.
   */
  renderTags?: () => void;
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
  getAttachments,
  setAttachments,
  canApplyAttachments,
  hasPendingImagePastes,
  renderTags,
}: UseChatInputImperativeHandleOptions): void {
  // Treat a missing probe as "capable": the plain uncontrolled input is the
  // common case, and refusing a restore there would be worse than trying.
  const attachmentsEnabled = canApplyAttachments ?? (() => true);
  const imagePastesPending = hasPendingImagePastes ?? (() => false);
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
        // The text was written as plain text, so the rich references it may
        // contain (@file chips, quote chips) still have to be rendered. Without
        // this a restored draft would show up as raw text instead of the
        // rendered chips the user saw before the message was queued.
        renderTags?.();

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
      getAttachments,
      setAttachments,
      canApplyAttachments: attachmentsEnabled,
      hasPendingImagePastes: imagePastesPending,
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
      getAttachments,
      setAttachments,
      attachmentsEnabled,
      imagePastesPending,
      renderTags,
    ]
  );
}

