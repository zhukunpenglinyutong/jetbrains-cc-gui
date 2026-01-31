import { useCallback } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import type { Attachment } from '../components/ChatInputBox/types';
import type { ClaudeContentBlock } from '../types';

export interface UseMessageSubmitOptions {
  t: TFunction;
  forceCreateNewSession: () => void;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
}

export interface UseMessageSubmitReturn {
  /**
   * Check if the input is a new session command (/new, /clear, /reset)
   * @returns true if handled, false otherwise
   */
  checkNewSessionCommand: (text: string) => boolean;

  /**
   * Check if the input is an unimplemented command
   * @returns true if handled, false otherwise
   */
  checkUnimplementedCommand: (text: string) => boolean;

  /**
   * Build content blocks for user message
   */
  buildUserContentBlocks: (text: string, attachments: Attachment[] | undefined) => ClaudeContentBlock[];

  /**
   * Send message to backend via bridge
   */
  sendMessageToBackend: (
    text: string,
    attachments: Attachment[] | undefined,
    agentInfo: { id: string; name: string; prompt?: string } | null,
    fileTagsInfo: { displayPath: string; absolutePath: string }[] | null
  ) => void;
}

/**
 * Commands that trigger new session creation
 */
const NEW_SESSION_COMMANDS = new Set(['/new', '/clear', '/reset']);

/**
 * Hook for message submission related logic
 */
export function useMessageSubmit({
  t,
  forceCreateNewSession,
  setMessages,
}: UseMessageSubmitOptions): UseMessageSubmitReturn {
  /**
   * Check if input is a new session command
   */
  const checkNewSessionCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;
    const command = text.split(/\s+/)[0].toLowerCase();
    if (NEW_SESSION_COMMANDS.has(command)) {
      forceCreateNewSession();
      return true;
    }
    return false;
  }, [forceCreateNewSession]);

  /**
   * Check if input is an unimplemented command
   */
  const checkUnimplementedCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;

    const command = text.split(/\s+/)[0].toLowerCase();
    const unimplementedCommands = ['/plugin', '/plugins'];

    if (unimplementedCommands.includes(command)) {
      const userMessage = {
        type: 'user' as const,
        content: text,
        timestamp: new Date().toISOString(),
      };
      const assistantMessage = {
        type: 'assistant' as const,
        content: t('chat.commandNotImplemented', { command }),
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      return true;
    }
    return false;
  }, [t, setMessages]);

  /**
   * Build content blocks for user message
   */
  const buildUserContentBlocks = useCallback((
    text: string,
    attachments: Attachment[] | undefined
  ): ClaudeContentBlock[] => {
    const blocks: ClaudeContentBlock[] = [];

    const hasImageAttachments = Array.isArray(attachments) &&
      attachments.some(att => att.mediaType?.startsWith('image/'));

    if (Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        if (att.mediaType?.startsWith('image/')) {
          blocks.push({
            type: 'image',
            src: `data:${att.mediaType};base64,${att.data}`,
            mediaType: att.mediaType,
          });
        } else {
          blocks.push({
            type: 'text',
            text: t('chat.attachmentFile', { fileName: att.fileName }),
          });
        }
      }
    }

    // Filter placeholder text: skip if there are image attachments and text is placeholder
    const isPlaceholderText = text && text.trim().startsWith('[Uploaded ');

    if (text && !(hasImageAttachments && isPlaceholderText)) {
      blocks.push({ type: 'text', text });
    }

    return blocks;
  }, [t]);

  /**
   * Send message to backend via bridge
   */
  const sendMessageToBackend = useCallback((
    text: string,
    attachments: Attachment[] | undefined,
    agentInfo: { id: string; name: string; prompt?: string } | null,
    fileTagsInfo: { displayPath: string; absolutePath: string }[] | null
  ) => {
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (hasAttachments) {
      try {
        const payload = JSON.stringify({
          text,
          attachments: (attachments || []).map(a => ({
            fileName: a.fileName,
            mediaType: a.mediaType,
            data: a.data,
          })),
          agent: agentInfo,
          fileTags: fileTagsInfo,
        });
        sendBridgeEvent('send_message_with_attachments', payload);
      } catch (error) {
        console.error('[Frontend] Failed to serialize attachments payload', error);
        const fallbackPayload = JSON.stringify({ text, agent: agentInfo, fileTags: fileTagsInfo });
        sendBridgeEvent('send_message', fallbackPayload);
      }
    } else {
      const payload = JSON.stringify({ text, agent: agentInfo, fileTags: fileTagsInfo });
      sendBridgeEvent('send_message', payload);
    }
  }, []);

  return {
    checkNewSessionCommand,
    checkUnimplementedCommand,
    buildUserContentBlocks,
    sendMessageToBackend,
  };
}
