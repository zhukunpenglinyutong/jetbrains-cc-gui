import { useCallback } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage } from '../types';
import type { RewindRequest } from '../components/RewindDialog';
import type { RewindableMessage } from '../components/RewindSelectDialog';
import { rewindFiles } from '../utils/bridge';
import { formatTime } from '../utils/helpers';

export interface UseRewindHandlersOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  currentSessionId: string | null;
  mergedMessages: ClaudeMessage[];
  getMessageText: (message: ClaudeMessage) => string;
  setCurrentRewindRequest: (request: RewindRequest | null) => void;
  setRewindDialogOpen: (open: boolean) => void;
  setRewindSelectDialogOpen: (open: boolean) => void;
  setIsRewinding: (loading: boolean) => void;
  isRewinding: boolean;
}

export interface UseRewindHandlersReturn {
  handleRewindClick: (messageIndex: number, message: ClaudeMessage) => void;
  handleRewindConfirm: (sessionId: string, userMessageId: string) => void;
  handleRewindCancel: () => void;
  handleOpenRewindSelectDialog: () => void;
  handleRewindSelect: (item: RewindableMessage) => void;
  handleRewindSelectCancel: () => void;
}

export function useRewindHandlers(options: UseRewindHandlersOptions): UseRewindHandlersReturn {
  const {
    t,
    addToast,
    currentSessionId,
    mergedMessages,
    getMessageText,
    setCurrentRewindRequest,
    setRewindDialogOpen,
    setRewindSelectDialogOpen,
    setIsRewinding,
    isRewinding,
  } = options;

  const handleRewindClick = useCallback((messageIndex: number, message: ClaudeMessage) => {
    if (!currentSessionId) {
      addToast(t('rewind.notAvailable'), 'warning');
      return;
    }

    const isToolResultOnlyUserMessage = (msg: ClaudeMessage): boolean => {
      if (msg.type !== 'user') return false;
      if ((msg.content ?? '').trim() === '[tool_result]') return true;

      const raw = msg.raw;
      if (!raw || typeof raw === 'string') return false;

      const rawObj = raw as { content?: unknown[]; message?: { content?: unknown[] } };
      const content = rawObj.content ?? rawObj.message?.content;
      if (!Array.isArray(content)) return false;

      return content.some((block) =>
        block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result'
      );
    };

    let targetIndex = messageIndex;
    let targetMessage: ClaudeMessage = message;
    if (isToolResultOnlyUserMessage(message)) {
      for (let i = messageIndex - 1; i >= 0; i -= 1) {
        const candidate = mergedMessages[i];
        if (candidate.type !== 'user') continue;
        if (isToolResultOnlyUserMessage(candidate)) continue;
        targetIndex = i;
        targetMessage = candidate;
        break;
      }
    }

    const raw = targetMessage.raw;
    const uuid = typeof raw === 'object' ? (raw as Record<string, unknown>)?.uuid : undefined;
    if (!uuid) {
      addToast(t('rewind.notAvailable'), 'warning');
      console.warn('[Rewind] No UUID found in message:', targetMessage);
      return;
    }

    // Calculate messages after this one
    const messagesAfterCount = mergedMessages.length - targetIndex - 1;

    // Get display content for the dialog
    const content = targetMessage.content || getMessageText(targetMessage);
    const timestamp = targetMessage.timestamp ? formatTime(targetMessage.timestamp) : undefined;

    setCurrentRewindRequest({
      sessionId: currentSessionId,
      userMessageId: uuid as string,
      messageContent: content,
      messageTimestamp: timestamp,
      messagesAfterCount,
    });
    setRewindDialogOpen(true);
  }, [currentSessionId, mergedMessages, getMessageText, setCurrentRewindRequest, setRewindDialogOpen, addToast, t]);

  const handleRewindConfirm = useCallback((sessionId: string, userMessageId: string) => {
    setIsRewinding(true);
    rewindFiles(sessionId, userMessageId);
  }, [setIsRewinding]);

  const handleRewindCancel = useCallback(() => {
    if (isRewinding) {
      setIsRewinding(false);
    }
    setRewindDialogOpen(false);
    setCurrentRewindRequest(null);
  }, [isRewinding, setIsRewinding, setRewindDialogOpen, setCurrentRewindRequest]);

  const handleOpenRewindSelectDialog = useCallback(() => {
    setRewindSelectDialogOpen(true);
  }, [setRewindSelectDialogOpen]);

  const handleRewindSelect = useCallback((item: RewindableMessage) => {
    setRewindSelectDialogOpen(false);
    handleRewindClick(item.messageIndex, item.message);
  }, [setRewindSelectDialogOpen, handleRewindClick]);

  const handleRewindSelectCancel = useCallback(() => {
    setRewindSelectDialogOpen(false);
  }, [setRewindSelectDialogOpen]);

  return {
    handleRewindClick,
    handleRewindConfirm,
    handleRewindCancel,
    handleOpenRewindSelectDialog,
    handleRewindSelect,
    handleRewindSelectCancel,
  };
}
