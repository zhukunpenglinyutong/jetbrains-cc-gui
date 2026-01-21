import { useCallback, useRef } from 'react';
import { sendBridgeEvent } from '../utils/bridge';
import { debugLog, debugError } from '../utils/debugLogger';
import type { ClaudeMessage, ClaudeContentBlock } from '../types';
import type { Attachment, ChatInputBoxHandle, SelectedAgent } from '../components/ChatInputBox/types';
import type { ToastMessage } from '../components/Toast';

interface UseChatSubmitProps {
  t: (key: string, options?: Record<string, string>) => string;
  loading: boolean;
  sdkStatusLoaded: boolean;
  currentSdkInstalled: boolean;
  currentProvider: string;
  selectedAgent: SelectedAgent | null;
  chatInputRef: React.RefObject<ChatInputBoxHandle | null>;
  isUserAtBottomRef: React.MutableRefObject<boolean>;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setSettingsInitialTab: (tab: 'dependencies' | undefined) => void;
  setCurrentView: (view: 'chat' | 'history' | 'settings') => void;
  addToast: (message: string, type?: ToastMessage['type']) => void;
}

interface UseChatSubmitReturn {
  handleSubmit: (content: string, attachments?: Attachment[]) => void;
}

/**
 * Hook for handling chat message submission
 * Extracts the complex submission logic from App.tsx
 */
export function useChatSubmit({
  t,
  loading,
  sdkStatusLoaded,
  currentSdkInstalled,
  currentProvider,
  selectedAgent,
  chatInputRef,
  isUserAtBottomRef,
  messagesContainerRef,
  setMessages,
  setLoading,
  setLoadingStartTime,
  setSettingsInitialTab,
  setCurrentView,
  addToast,
}: UseChatSubmitProps): UseChatSubmitReturn {
  // Use ref to get latest provider value in callbacks
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  const handleSubmit = useCallback(
    (content: string, attachments?: Attachment[]) => {
      // Remove zero-width spaces and other invisible characters
      const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

      if (!text && !hasAttachments) {
        return;
      }
      if (loading) {
        return;
      }

      // Defensive check: prevent sending when SDK status unknown/not installed
      if (!sdkStatusLoaded) {
        addToast(t('chat.sdkStatusLoading'), 'info');
        return;
      }
      if (!currentSdkInstalled) {
        addToast(
          t('chat.sdkNotInstalled', { provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code' }) +
            ' ' +
            t('chat.goInstallSdk'),
          'warning'
        );
        setSettingsInitialTab('dependencies');
        setCurrentView('settings');
        return;
      }

      // Check for unimplemented slash commands
      if (text.startsWith('/')) {
        const command = text.split(/\s+/)[0].toLowerCase();
        const unimplementedCommands = ['/plugin', '/plugins'];
        if (unimplementedCommands.includes(command)) {
          // Add user message
          const userMessage: ClaudeMessage = {
            type: 'user',
            content: text,
            timestamp: new Date().toISOString(),
          };
          // Add prompt message
          const assistantMessage: ClaudeMessage = {
            type: 'assistant',
            content: t('chat.commandNotImplemented', { command }),
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, userMessage, assistantMessage]);
          return;
        }
      }

      // Build user message content blocks (for frontend display)
      const userContentBlocks: ClaudeContentBlock[] = [];

      if (hasAttachments) {
        // Add image blocks
        for (const att of attachments || []) {
          if (att.mediaType?.startsWith('image/')) {
            userContentBlocks.push({
              type: 'image',
              src: `data:${att.mediaType};base64,${att.data}`,
              mediaType: att.mediaType,
            });
          } else {
            // Non-image attachment - display file name
            userContentBlocks.push({
              type: 'text',
              text: t('chat.attachmentFile', { fileName: att.fileName }),
            });
          }
        }
      }

      // Add text block
      if (text) {
        userContentBlocks.push({ type: 'text', text });
      } else if (userContentBlocks.length === 0) {
        // If no attachments and no text, don't send
        return;
      }

      // Add user message immediately on frontend (includes image preview)
      const userMessage: ClaudeMessage = {
        type: 'user',
        content: text || (hasAttachments ? t('chat.attachmentsUploaded') : ''),
        timestamp: new Date().toISOString(),
        isOptimistic: true, // Mark as optimistic update message
        raw: {
          message: {
            content: userContentBlocks,
          },
        },
      };
      setMessages((prev) => [...prev, userMessage]);

      // Set loading state immediately to avoid race condition with backend callback
      setLoading(true);
      setLoadingStartTime(Date.now());

      // Force scroll to bottom after sending message
      isUserAtBottomRef.current = true;
      requestAnimationFrame(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
        }
      });

      // Sync provider setting before sending message
      debugLog('[DEBUG] Current provider before send:', currentProviderRef.current);
      sendBridgeEvent('set_provider', currentProviderRef.current);

      // Build agent info to send with message
      const agentInfo = selectedAgent
        ? {
            id: selectedAgent.id,
            name: selectedAgent.name,
            prompt: selectedAgent.prompt,
          }
        : null;

      // Extract file tags for Codex context injection
      const fileTags = chatInputRef.current?.getFileTags() ?? [];
      const fileTagsInfo =
        fileTags.length > 0
          ? fileTags.map((tag) => ({
              displayPath: tag.displayPath,
              absolutePath: tag.absolutePath,
            }))
          : null;

      // Send message
      if (hasAttachments) {
        try {
          const payload = JSON.stringify({
            text,
            attachments: (attachments || []).map((a) => ({
              fileName: a.fileName,
              mediaType: a.mediaType,
              data: a.data,
            })),
            agent: agentInfo,
            fileTags: fileTagsInfo,
          });
          sendBridgeEvent('send_message_with_attachments', payload);
        } catch (error) {
          debugError('[Frontend] Failed to serialize attachments payload', error);
          // Fallback: send message with agent info and file tags
          const fallbackPayload = JSON.stringify({ text, agent: agentInfo, fileTags: fileTagsInfo });
          sendBridgeEvent('send_message', fallbackPayload);
        }
      } else {
        // Pack message, agent info and file tags into JSON
        const payload = JSON.stringify({ text, agent: agentInfo, fileTags: fileTagsInfo });
        sendBridgeEvent('send_message', payload);
      }
    },
    [
      t,
      loading,
      sdkStatusLoaded,
      currentSdkInstalled,
      currentProvider,
      selectedAgent,
      chatInputRef,
      isUserAtBottomRef,
      messagesContainerRef,
      setMessages,
      setLoading,
      setLoadingStartTime,
      setSettingsInitialTab,
      setCurrentView,
      addToast,
    ]
  );

  return { handleSubmit };
}
