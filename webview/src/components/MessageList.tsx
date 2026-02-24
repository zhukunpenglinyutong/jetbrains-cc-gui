import { memo, useState, useEffect, useRef, useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import { getMessageKey } from '../utils/messageUtils';
import { MessageItem } from './MessageItem';
import WaitingIndicator from './WaitingIndicator';

/** Always render at least this many recent messages. Earlier messages are collapsed. */
const VISIBLE_MESSAGE_WINDOW = 15;

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
  onMessageNodeRef?: (id: string, node: HTMLDivElement | null) => void;
  /** Notify parent when the number of collapsed (hidden) messages changes. */
  onCollapsedCountChange?: (count: number) => void;
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
  onMessageNodeRef,
  onCollapsedCountChange,
}: MessageListProps) {
  const [showAll, setShowAll] = useState(false);

  // Reset showAll when a new session starts (first message ID changes)
  const firstMsgIdRef = useRef(messages[0]?.id);
  useEffect(() => {
    const currentFirstId = messages[0]?.id;
    if (currentFirstId !== firstMsgIdRef.current) {
      setShowAll(false);
    }
    firstMsgIdRef.current = currentFirstId;
  }, [messages]);

  const shouldCollapse = !showAll && messages.length > VISIBLE_MESSAGE_WINDOW;
  const collapsedCount = shouldCollapse ? messages.length - VISIBLE_MESSAGE_WINDOW : 0;

  // Notify parent of collapsed count changes (for anchor rail sync)
  useEffect(() => {
    onCollapsedCountChange?.(collapsedCount);
  }, [collapsedCount, onCollapsedCountChange]);
  const visibleMessages = useMemo(
    () => (shouldCollapse ? messages.slice(collapsedCount) : messages),
    [messages, shouldCollapse, collapsedCount]
  );

  return (
    <>
      {shouldCollapse && (
        <div
          className="collapsed-messages-indicator"
          onClick={() => setShowAll(true)}
        >
          {t('chat.showEarlierMessages', { count: collapsedCount })}
        </div>
      )}

      {visibleMessages.map((message, visibleIndex) => {
        const messageIndex = shouldCollapse ? visibleIndex + collapsedCount : visibleIndex;
        const messageKey = getMessageKey(message, messageIndex);

        return (
          <MessageItem
            key={messageKey}
            message={message}
            messageIndex={messageIndex}
            messageKey={messageKey}
            isLast={messageIndex === messages.length - 1}
            streamingActive={streamingActive}
            isThinking={isThinking}
            t={t}
            getMessageText={getMessageText}
            getContentBlocks={getContentBlocks}
            findToolResult={findToolResult}
            extractMarkdownContent={extractMarkdownContent}
            onNodeRef={onMessageNodeRef}
          />
        );
      })}

      {/* Loading indicator */}
      {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
      <div ref={messagesEndRef} />
    </>
  );
});
