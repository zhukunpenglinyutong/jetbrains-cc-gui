import { memo, useCallback, forwardRef, useImperativeHandle, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
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
  // 初始是否在底部
  initialAtBottom?: boolean;
  // 滚动容器 ref 回调（用于 ScrollControl）
  onScrollerRef?: (scroller: HTMLElement | Window | null) => void;
}

// 暴露给父组件的方法
export interface MessageListHandle {
  scrollToBottom: () => void;
  scrollToIndex: (index: number) => void;
}

// 使用 forwardRef 暴露 Virtuoso 的方法
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
  initialAtBottom = true,
  onScrollerRef,
}, ref) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        behavior: 'smooth',
        align: 'end',
      });
    },
    scrollToIndex: (index: number) => {
      virtuosoRef.current?.scrollToIndex({
        index,
        behavior: 'smooth',
        align: 'start',
      });
    },
  }), []);

  // 计算消息的稳定 key
  const computeItemKey = useCallback((index: number, message: ClaudeMessage) => {
    const rawObj = typeof message.raw === 'object' ? message.raw as Record<string, unknown> : null;
    return rawObj?.uuid as string
      || (message.timestamp ? `${message.type}-${message.timestamp}` : `${message.type}-${index}`);
  }, []);

  // 渲染单个消息项
  const itemContent = useCallback((index: number, message: ClaudeMessage) => {
    return (
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
    );
  }, [messages.length, streamingActive, isThinking, t, getMessageText, getContentBlocks, findToolResult, extractMarkdownContent]);

  // 底部状态变化回调
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    onAtBottomStateChange?.(atBottom);
  }, [onAtBottomStateChange]);

  // 滚动容器 ref 回调
  const handleScrollerRef = useCallback((scroller: HTMLElement | Window | null) => {
    onScrollerRef?.(scroller);
  }, [onScrollerRef]);

  // Footer 组件：包含 WaitingIndicator 和 messagesEndRef
  const Footer = useCallback(() => (
    <>
      {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
      <div ref={messagesEndRef} />
    </>
  ), [loading, loadingStartTime, messagesEndRef]);

  // 如果没有消息，不渲染 Virtuoso（由父组件显示 WelcomeScreen）
  if (messages.length === 0) {
    return (
      <>
        {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
        <div ref={messagesEndRef} />
      </>
    );
  }

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={messages}
      computeItemKey={computeItemKey}
      itemContent={itemContent}
      // 自动跟随输出：当用户在底部时，新内容会自动滚动
      followOutput={(isAtBottom) => {
        // 流式输出或加载时，如果用户在底部，平滑滚动
        if (isAtBottom && (streamingActive || loading)) {
          return 'smooth';
        }
        // 新消息到达时，如果用户在底部，自动滚动
        return isAtBottom ? 'auto' : false;
      }}
      // 初始滚动到底部
      initialTopMostItemIndex={initialAtBottom ? messages.length - 1 : 0}
      // 底部状态变化回调
      atBottomStateChange={handleAtBottomStateChange}
      // 底部阈值：距离底部 100px 以内认为是在底部
      atBottomThreshold={100}
      // 预渲染：上下各多渲染一些，避免快速滚动时出现空白
      overscan={200}
      // Footer 组件
      components={{ Footer }}
      // 增量渲染模式：适合聊天场景
      increaseViewportBy={{ top: 200, bottom: 200 }}
      // 滚动容器 ref 回调
      scrollerRef={handleScrollerRef}
      // 样式：占满容器
      style={{ height: '100%', width: '100%' }}
    />
  );
}));
