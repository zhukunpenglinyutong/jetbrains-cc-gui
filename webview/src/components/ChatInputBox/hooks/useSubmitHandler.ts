import { useCallback } from 'react';
import type { Attachment } from '../types.js';
import type { Dispatch, SetStateAction } from 'react';

interface CompletionLike {
  close: () => void;
}

export interface UseSubmitHandlerOptions {
  getTextContent: () => string;
  attachments: Attachment[];
  sdkStatusLoading: boolean;
  sdkInstalled: boolean;
  currentProvider: string;
  clearInput: () => void;
  /** Invalidate text content cache to force fresh DOM read on submit */
  invalidateCache: () => void;
  externalAttachments: Attachment[] | undefined;
  setInternalAttachments: Dispatch<SetStateAction<Attachment[]>>;
  /** Clear attachments draft from localStorage */
  clearAttachmentsDraft?: () => void;
  fileCompletion: CompletionLike;
  commandCompletion: CompletionLike;
  agentCompletion: CompletionLike;
  promptCompletion: CompletionLike;
  dollarCommandCompletion: CompletionLike;
  recordInputHistory: (text: string) => void;
  onSubmit?: (content: string, attachmentsToSend?: Attachment[]) => void;
  onInstallSdk?: () => void;
  addToast?: (message: string, type: 'info' | 'warning' | 'error' | 'success') => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * useSubmitHandler - Submit logic for the chat input box
 *
 * - Validates SDK state and empty input
 * - Records input history
 * - Clears input/attachments for responsiveness
 * - Defers onSubmit to allow UI update
 */
export function useSubmitHandler({
  getTextContent,
  attachments,
  sdkStatusLoading,
  sdkInstalled,
  currentProvider,
  clearInput,
  invalidateCache,
  externalAttachments,
  setInternalAttachments,
  clearAttachmentsDraft,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  promptCompletion,
  dollarCommandCompletion,
  recordInputHistory,
  onSubmit,
  onInstallSdk,
  addToast,
  t,
}: UseSubmitHandlerOptions) {
  return useCallback(() => {
    // Force fresh DOM read to avoid stale cache (e.g., after paste)
    invalidateCache();
    const content = getTextContent();
    const cleanContent = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

    // CLI providers are already known-installed. The global npm SDK query can
    // still be in flight; waiting on it only toasts "Checking SDK status...".
    if (sdkStatusLoading && !sdkInstalled) {
      addToast?.(t('chat.sdkStatusLoading'), 'info');
      return;
    }

    if (!sdkInstalled) {
      addToast?.(
        t('chat.sdkNotInstalled', {
          provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code',
        }) +
          ' ' +
          t('chat.goInstallSdk'),
        'warning'
      );
      onInstallSdk?.();
      return;
    }

    if (!cleanContent && attachments.length === 0) return;

    // Close completions
    fileCompletion.close();
    commandCompletion.close();
    agentCompletion.close();
    promptCompletion.close();
    dollarCommandCompletion.close();

    // Record input history
    recordInputHistory(content);

    const attachmentsToSend = attachments.length > 0 ? [...attachments] : undefined;

    // clearInput also drops any queued draft notification, so a stale debounced
    // value cannot refill the input after submit.
    clearInput();
    if (externalAttachments === undefined) {
      setInternalAttachments([]);
      // Clear attachments draft from localStorage
      clearAttachmentsDraft?.();
    }

    // Call onSubmit even when loading - let parent handle queueing
    setTimeout(() => {
      onSubmit?.(content, attachmentsToSend);
    }, 10);
  }, [
    getTextContent,
    invalidateCache,
    attachments,
    sdkStatusLoading,
    sdkInstalled,
    currentProvider,
    clearInput,
    externalAttachments,
    setInternalAttachments,
    clearAttachmentsDraft,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    recordInputHistory,
    onSubmit,
    onInstallSdk,
    addToast,
    t,
  ]);
}
