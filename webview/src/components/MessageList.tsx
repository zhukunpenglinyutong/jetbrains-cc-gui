import { memo, forwardRef, useImperativeHandle, useRef, useEffect, useCallback } from 'react';
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
  // 滚动状态回调
  onAtBottomStateChange?: (atBottom: boolean) => void;
  // 滚动容器 ref 回调（用于 ScrollControl）
  onScrollerRef?: (scroller: HTMLElement | null) => void;
}

// 暴露给父组件的方法
export interface MessageListHandle {
  scrollToBottom: () => void;
  scrollToIndex: (index: number) => void;
}

// 使用 forwardRef 暴露滚动方法
export const MessageList = memo(forwardRef<MessageListHandle, MessageListProps>(function MessageList({
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
  onAtBottomStateChange,
  onScrollerRef,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isUserAtBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      if (containerRef.current) {
        containerRef.current.scrollTo({
          top: containerRef.current.scrollHeight,
          behavior: 'smooth',
        });
      }
    },
    scrollToIndex: (index: number) => {
      if (!containerRef.current) return;
      const messageElement = containerRef.current.querySelector(`[data-message-index="${index}"]`);
      if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
  }), []);

  // 通知父组件 scroller ref（只在 mount 时执行一次）
  useEffect(() => {
    onScrollerRef?.(containerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 检测是否在底部
  const checkIfAtBottom = useCallback(() => {
    if (!containerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return distanceFromBottom < 100; // 100px 阈值
  }, []);

  // 滚动事件处理
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const { scrollTop } = containerRef.current;
    const isScrollingUp = scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    const atBottom = checkIfAtBottom();

    // 用户向上滚动时，标记为不在底部
    if (isScrollingUp && !atBottom) {
      isUserAtBottomRef.current = false;
    }

    // 用户滚回底部时，恢复标记
    if (atBottom) {
      isUserAtBottomRef.current = true;
    }

    onAtBottomStateChange?.(atBottom);
  }, [checkIfAtBottom, onAtBottomStateChange]);

  // 流式输出时自动滚动到底部
  useEffect(() => {
    if (!streamingActive && !loading) return;
    if (!isUserAtBottomRef.current) return;
    if (!containerRef.current) return;

    // 滚动到底部
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [messages.length, streamingActive, loading]);

  // 计算消息的稳定 key
  const getMessageKey = useCallback((message: ClaudeMessage, index: number) => {
    const rawObj = typeof message.raw === 'object' ? message.raw as Record<string, unknown> : null;
    return rawObj?.uuid as string
      || (message.timestamp ? `${message.type}-${message.timestamp}` : `${message.type}-${index}`);
  }, []);

  return (
    <div
      ref={containerRef}
      className="message-list-container"
      onScroll={handleScroll}
      style={{
        height: '100%',
        width: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {messages.map((message, index) => (
        <div key={getMessageKey(message, index)} data-message-index={index}>
          <MessageItem
            message={message}
            messageIndex={index}
            isLast={index === messages.length - 1}
            streamingActive={streamingActive}
            isThinking={isThinking}
            t={t}
            getMessageText={getMessageText}
            getContentBlocks={getContentBlocks}
            findToolResult={findToolResult}
            extractMarkdownContent={extractMarkdownContent}
          />
        </div>
      ))}
      {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
      <div ref={messagesEndRef} />
    </div>
  );
}));
