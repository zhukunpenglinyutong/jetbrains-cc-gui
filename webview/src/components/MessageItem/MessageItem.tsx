import { useState, useCallback, useMemo, memo, useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../../types';

import { isProviderNotConfiguredError } from './ProviderNotConfiguredCard';
import { matchErrorPattern } from '../../utils/errorMatcher';
import { UserMessageHeader, AssistantMessageActions, MessageRoleLabel } from './MessageActionButtons';
import { MessageDurationFooter } from './MessageDurationFooter';
import { GroupedBlocksRenderer } from './GroupedBlocksRenderer';
import { copyToClipboard } from '../../utils/copyUtils';
import { quoteToChatInput } from '../../utils/quoteUtils';
import { isNonRenderedToolUse } from '../../utils/toolConstants';
import { groupBlocks } from './groupBlocks';

// Re-exported so existing imports (`groupBlocks.test.ts`) keep working.
export { groupBlocks };

export interface MessageItemProps {
  message: ClaudeMessage;
  messageIndex: number;
  messageKey: string;
  isLast: boolean;
  streamingActive: boolean;
  isThinking: boolean;
  t: TFunction;
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  extractMarkdownContent: (message: ClaudeMessage) => string;
  onNodeRef?: (id: string, node: HTMLDivElement | null) => void;
  onNavigateToProviderSettings?: () => void;
  onNavigateToDependencySettings?: () => void;
  toolResultSignature?: string;
  /** Current active provider id (e.g. 'claude', 'codex'); drives the streaming-connect label. */
  currentProvider?: string;
  /** Show opt-in detailed footer extras such as turn cost and cache-hit ratio. */
  detailedOutputEnabled?: boolean;
}

export const MessageItem = memo(function MessageItem({
  message,
  messageIndex,
  messageKey,
  isLast,
  streamingActive,
  isThinking,
  t,
  getMessageText,
  getContentBlocks,
  findToolResult,
  extractMarkdownContent,
  onNodeRef,
  onNavigateToProviderSettings,
  onNavigateToDependencySettings,
  toolResultSignature: _toolResultSignature,
  currentProvider,
  detailedOutputEnabled = false,
}: MessageItemProps): React.ReactElement {
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [quotedMessageIndex, setQuotedMessageIndex] = useState<number | null>(null);
  const [showStreamingConnectHint, setShowStreamingConnectHint] = useState(false);

  // Track timeout to properly cleanup on unmount
  const copyTimeoutRef = useRef<number | null>(null);
  const quoteTimeoutRef = useRef<number | null>(null);

  // Manage thinking expansion state locally to avoid prop drilling and unnecessary re-renders
  const [expandedThinking, setExpandedThinking] = useState<Record<number, boolean>>({});
  // Track which thinking blocks were manually expanded by the user
  const [manuallyExpandedThinking, setManuallyExpandedThinking] = useState<Record<number, boolean>>({});

  const toggleThinking = useCallback((blockIndex: number) => {
    const newExpanded = !expandedThinking[blockIndex];
    setExpandedThinking((prev) => ({
      ...prev,
      [blockIndex]: !prev[blockIndex],
    }));
    // Mark this block as manually toggled by the user
    setManuallyExpandedThinking((manualPrev) => ({
      ...manualPrev,
      [blockIndex]: newExpanded,
    }));
  }, [expandedThinking]);

  const isThinkingExpanded = useCallback(
    (blockIndex: number) => Boolean(expandedThinking[blockIndex]),
    [expandedThinking]
  );

  const isLastAssistantMessage = message.type === 'assistant' && isLast;
  const isMessageStreaming = streamingActive && isLastAssistantMessage;

  // Cache markdown content extraction for better performance
  const markdownContent = useMemo(() => {
    // Only extract for user and assistant messages that need copy functionality
    if (message.type === 'user' || message.type === 'assistant') {
      return extractMarkdownContent(message);
    }
    return '';
  }, [message, extractMarkdownContent]);
  const hasCopyableText = markdownContent.trim().length > 0;

  const handleCopyMessage = useCallback(async () => {
    // Prevent copying if message is empty or already in "copied" state
    if (!hasCopyableText || copiedMessageIndex === messageIndex) return;

    const success = await copyToClipboard(markdownContent);
    if (success) {
      setCopiedMessageIndex(messageIndex);

      // Clear any existing timeout before setting new one
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }

      // Set new timeout and store ID for cleanup
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedMessageIndex(null);
        copyTimeoutRef.current = null;
      }, 1500);
    }
  }, [hasCopyableText, markdownContent, messageIndex, copiedMessageIndex]);

  const handleQuoteMessage = useCallback(() => {
    if (!hasCopyableText) return;
    if (!quoteToChatInput(markdownContent)) return;
    setQuotedMessageIndex(messageIndex);
    if (quoteTimeoutRef.current !== null) {
      window.clearTimeout(quoteTimeoutRef.current);
    }
    quoteTimeoutRef.current = window.setTimeout(() => {
      setQuotedMessageIndex(null);
      quoteTimeoutRef.current = null;
    }, 1500);
  }, [hasCopyableText, markdownContent, messageIndex]);

  // Cleanup timeout on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
      if (quoteTimeoutRef.current !== null) {
        window.clearTimeout(quoteTimeoutRef.current);
        quoteTimeoutRef.current = null;
      }
    };
  }, []);

  // Memoize blocks and grouped blocks to avoid recalculation on every render
  const blocks = useMemo(() => getContentBlocks(message), [message, getContentBlocks]);
  // Tool calls that render nothing (TodoWrite, TaskCreate, ...) still live in
  // `blocks`, so their arrival re-rendered the message and - worse - flipped
  // the streaming thinking block's last-block status, which switched its
  // MarkdownBlock between the streaming and full-pipeline renderers (they
  // differ in height on single-newline content) and made the thinking block
  // visibly collapse then re-expand. Filter them out of the rendered list so
  // non-rendered tools never disturb the message list. `blocks` is kept whole
  // for the empty-placeholder check below, since a message carrying only a
  // non-rendered tool is not an empty streaming placeholder.
  const renderedBlocks = useMemo(
    () => blocks.filter((block) => !isNonRenderedToolUse(block, isMessageStreaming)),
    [blocks, isMessageStreaming],
  );
  const isEmptyStreamingPlaceholder =
    message.type === 'assistant' &&
    isMessageStreaming &&
    blocks.length === 0 &&
    !(message.content && message.content.trim().length > 0);

  useEffect(() => {
    if (!isEmptyStreamingPlaceholder) {
      setShowStreamingConnectHint(false);
      return;
    }
    const timer = window.setTimeout(() => setShowStreamingConnectHint(true), 350);
    return () => window.clearTimeout(timer);
  }, [isEmptyStreamingPlaceholder]);

  // Ref to track the last auto-expanded thinking block index to avoid overriding user interaction
  const lastAutoExpandedIndexRef = useRef<number>(-1);

  // Auto-expand the latest thinking block during streaming
  useEffect(() => {
    if (!isMessageStreaming) return;

    const thinkingIndices: number[] = [];
    renderedBlocks.forEach((block, index) => {
      if (block.type === 'thinking') thinkingIndices.push(index);
    });

    if (thinkingIndices.length === 0) return;

    const lastThinkingIndex = thinkingIndices[thinkingIndices.length - 1];

    if (lastThinkingIndex !== lastAutoExpandedIndexRef.current) {
      setExpandedThinking((prev) => {
        const newState = { ...prev };
        // Only collapse thinking blocks that were NOT manually expanded by the user
        thinkingIndices.forEach((idx) => {
          // Preserve manually expanded state
          if (!manuallyExpandedThinking[idx]) {
            newState[idx] = false;
          }
        });
        // Auto-expand the latest one (unless user manually collapsed it)
        if (!manuallyExpandedThinking[lastThinkingIndex] || prev[lastThinkingIndex] === undefined) {
          newState[lastThinkingIndex] = true;
        }
        return newState;
      });
      lastAutoExpandedIndexRef.current = lastThinkingIndex;
    }
  }, [renderedBlocks, isMessageStreaming, manuallyExpandedThinking]);

  const groupedBlocks = useMemo(() => groupBlocks(renderedBlocks), [renderedBlocks]);

  // Register user message DOM node for anchor navigation
  // Must be called before any early returns to satisfy React hooks rules
  const anchorRefCallback = useCallback((node: HTMLDivElement | null) => {
    if (message.type === 'user' && onNodeRef) {
      onNodeRef(messageKey, node);
    }
  }, [message.type, messageKey, onNodeRef]);

  const isProviderNotConfigured = message.type === 'error' && isProviderNotConfiguredError(getMessageText(message));
  const errorDiagnosticPattern = useMemo(
    () => (message.type === 'error' && !isProviderNotConfigured
      ? matchErrorPattern(getMessageText(message))
      : null),
    [message, isProviderNotConfigured, getMessageText]
  );

  if (isEmptyStreamingPlaceholder && !showStreamingConnectHint) {
    return <></>;
  }

  return (
    <div
      className={`message ${message.type}${isLast ? ' is-last-message' : ''}${isProviderNotConfigured ? ' provider-not-configured' : ''}`}
      ref={anchorRefCallback}
      data-message-anchor-id={message.type === 'user' ? messageKey : undefined}
    >
      <UserMessageHeader
        messageType={message.type}
        timestamp={message.timestamp}
        hasCopyableText={hasCopyableText}
        isQuoted={quotedMessageIndex === messageIndex}
        isCopied={copiedMessageIndex === messageIndex}
        onQuote={handleQuoteMessage}
        onCopy={handleCopyMessage}
        t={t}
      />

      <AssistantMessageActions
        messageType={message.type}
        isMessageStreaming={isMessageStreaming}
        hasCopyableText={hasCopyableText}
        isQuoted={quotedMessageIndex === messageIndex}
        isCopied={copiedMessageIndex === messageIndex}
        onQuote={handleQuoteMessage}
        onCopy={handleCopyMessage}
        t={t}
      />

      <MessageRoleLabel messageType={message.type} />

      <div className="message-content">
        <GroupedBlocksRenderer
          message={message}
          messageIndex={messageIndex}
          messageKey={messageKey}
          t={t}
          getMessageText={getMessageText}
          findToolResult={findToolResult}
          isProviderNotConfigured={isProviderNotConfigured}
          errorDiagnosticPattern={errorDiagnosticPattern}
          isEmptyStreamingPlaceholder={isEmptyStreamingPlaceholder}
          currentProvider={currentProvider}
          groupedBlocks={groupedBlocks}
          renderedBlockCount={renderedBlocks.length}
          isMessageStreaming={isMessageStreaming}
          isThinking={isThinking}
          isLast={isLast}
          isThinkingExpanded={isThinkingExpanded}
          onToggleThinking={toggleThinking}
          onNavigateToProviderSettings={onNavigateToProviderSettings}
          onNavigateToDependencySettings={onNavigateToDependencySettings}
        />
      </div>

      <MessageDurationFooter
        message={message}
        isMessageStreaming={isMessageStreaming}
        detailedOutputEnabled={detailedOutputEnabled}
        t={t}
      />
    </div>
  );
});
