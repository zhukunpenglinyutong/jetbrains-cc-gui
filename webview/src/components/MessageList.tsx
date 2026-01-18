import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import { MessageItem } from './MessageItem';
import WaitingIndicator from './WaitingIndicator';

interface MessageListProps {
  messages: ClaudeMessage[];
  streamingActive: boolean;
  isThinking: boolean;
  loading: boolean;
  loadingStartTime: number | null;
  t: TFunction;
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  extractMarkdownContent: (message: ClaudeMessage) => string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export const MessageList = memo(function MessageList({
  messages,
  streamingActive,
  isThinking,
  loading,
  loadingStartTime,
  t,
  getMessageText,
  getContentBlocks,
  findToolResult,
  extractMarkdownContent,
  messagesEndRef,
}: MessageListProps) {
  return (
    <>
      {messages.map((message, messageIndex) => {
        // Use stable key: prefer raw.uuid > type-timestamp > fallback to index
        const rawObj = typeof message.raw === 'object' ? message.raw as Record<string, unknown> : null;
        const messageKey = rawObj?.uuid as string
          || (message.timestamp ? `${message.type}-${message.timestamp}` : `${message.type}-${messageIndex}`);

        return (
          <MessageItem
            key={messageKey}
            message={message}
            messageIndex={messageIndex}
            isLast={messageIndex === messages.length - 1}
            streamingActive={streamingActive}
            isThinking={isThinking}
            t={t}
            getMessageText={getMessageText}
            getContentBlocks={getContentBlocks}
            findToolResult={findToolResult}
            extractMarkdownContent={extractMarkdownContent}
          />
        );
      })}

      {/* Loading indicator */}
      {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
      <div ref={messagesEndRef} />
    </>
  );
});
