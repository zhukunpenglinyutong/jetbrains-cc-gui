import { memo, useState, useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { QueueDisplayState } from '../contexts/MessagesContext';
import { getMessageKey } from '../utils/messageUtils';
import { extractMessageUsage } from '../utils/messageUsage';
import { MessageItem } from './MessageItem';
import { MessageAvatar } from './MessageItem/MessageAvatar';
import { MessageUsageStats } from './MessageItem/MessageUsageStats';
import WaitingIndicator from './WaitingIndicator';
import { ContextMenu } from './ContextMenu';
import { useContextMenu, copySelection } from '../hooks/useContextMenu.js';
import type { MessageListRevealHandle } from './ConversationSearch/types';

/** Always render at least this many recent messages. Earlier messages are collapsed. */
const VISIBLE_MESSAGE_WINDOW = 15;
/** Number of additional earlier messages to reveal per "show earlier" click. */
const REVEAL_PAGE_SIZE = 30;

type VisibleMessageUnit =
  | { kind: 'message'; message: ClaudeMessage; messageIndex: number }
  | { kind: 'assistant_response_group'; responseId: string; items: Array<{ message: ClaudeMessage; messageIndex: number }> };

function extractToolResultPreview(result: ToolResultBlock | null | undefined): string {
  if (!result) return 'pending';

  let text = '';
  if (typeof result.content === 'string') {
    text = result.content;
  } else if (Array.isArray(result.content)) {
    text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }

  const preview = text.length > 200 ? text.slice(0, 200) : text;
  return `${result.is_error === true ? 'error' : 'ok'}:${text.length}:${preview}`;
}

function getMessageToolResultSignature(
  message: ClaudeMessage,
  messageIndex: number,
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined,
): string {
  const toolUses = getContentBlocks(message).filter(
    (block): block is Extract<ClaudeContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
  );
  if (toolUses.length === 0) return '';

  return toolUses
    .map((block) => `${block.id ?? 'unknown'}:${extractToolResultPreview(findToolResult(block.id, messageIndex))}`)
    .join('|');
}

function getGroupedAssistantUsage(items: Array<{ message: ClaudeMessage }>): {
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  durationLabelKey: string;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let hasTokens = false;
  let durationMs: number | null = null;
  let durationLabelKey = 'chat.usageStats.duration';

  for (const { message } of items) {
    const usage = extractMessageUsage(message);
    if (usage) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      hasTokens = true;
    }
    if (typeof message.durationMs === 'number' && message.durationMs > 0) {
      durationMs = message.durationMs;
      durationLabelKey =
        message.streamEndSource === 'watchdog' || message.streamEndReason === 'stalled'
          ? 'chat.waitingTimedOutDuration'
          : 'chat.usageStats.duration';
    }
  }

  return {
    inputTokens: hasTokens ? inputTokens : null,
    outputTokens: hasTokens ? outputTokens : null,
    durationMs,
    durationLabelKey,
  };
}

interface MessageListProps {
  messages: ClaudeMessage[];
  streamingActive: boolean;
  isThinking: boolean;
  loading: boolean;
  loadingStartTime: number | null;
  queueDisplayState: QueueDisplayState;
  queueAheadCount: number;
  t: TFunction;
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  extractMarkdownContent: (message: ClaudeMessage) => string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onMessageNodeRef?: (id: string, node: HTMLDivElement | null) => void;
  /** Notify parent when the number of collapsed (hidden) messages changes. */
  onCollapsedCountChange?: (count: number) => void;
  onNavigateToProviderSettings?: () => void;
  onNavigateToDependencySettings?: () => void;
  /** Current active provider id; forwarded to MessageItem for streaming-connect label. */
  currentProvider?: string;
}

export const MessageList = memo(forwardRef<MessageListRevealHandle, MessageListProps>(function MessageList({
  messages,
  streamingActive,
  isThinking,
  loading,
  loadingStartTime,
  queueDisplayState,
  queueAheadCount,
  t,
  getMessageText,
  getContentBlocks,
  findToolResult,
  extractMarkdownContent,
  messagesEndRef,
  onMessageNodeRef,
  onCollapsedCountChange,
  onNavigateToProviderSettings,
  onNavigateToDependencySettings,
  currentProvider,
}, ref) {
  // Number of earlier messages revealed beyond VISIBLE_MESSAGE_WINDOW. Grows in
  // page-size chunks as the user clicks "show earlier", avoiding a single huge
  // mount when sessions exceed hundreds of messages.
  const [revealedCount, setRevealedCount] = useState(0);

  // Keep WaitingIndicator mounted during exit animation
  const [waitingVisible, setWaitingVisible] = useState(false);

  useEffect(() => {
    if (loading) {
      setWaitingVisible(true);
    }
  }, [loading]);

  const handleWaitingExitComplete = useCallback(() => {
    setWaitingVisible(false);
  }, []);

  // Context menu for message list (copy only, when text selected)
  const ctxMenu = useContextMenu();
  const handleMessageContextMenu = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      ctxMenu.open(e);
    }
  }, [ctxMenu.open]);

  // Reset revealed count when a new session starts (first message ID changes)
  const firstMsgIdRef = useRef(messages[0]?.id);
  useEffect(() => {
    const currentFirstId = messages[0]?.id;
    const isSessionStart = messages.length === 0;

    // Reset on session start OR when first message ID changes
    if (isSessionStart || currentFirstId !== firstMsgIdRef.current) {
      setRevealedCount(0);
    }
    firstMsgIdRef.current = currentFirstId;
  }, [messages]);

  const totalEarlierMessages = Math.max(0, messages.length - VISIBLE_MESSAGE_WINDOW);
  const effectiveRevealed = Math.min(revealedCount, totalEarlierMessages);
  const shouldCollapse = effectiveRevealed < totalEarlierMessages;
  const collapsedCount = totalEarlierMessages - effectiveRevealed;
  const nextChunkSize = Math.min(REVEAL_PAGE_SIZE, collapsedCount);

  const handleRevealMore = useCallback(() => {
    setRevealedCount((prev) => prev + REVEAL_PAGE_SIZE);
  }, []);

  // Imperative API so the in-page search can expand everything before scanning.
  // Returns the number of messages that were just revealed (0 when nothing
  // was collapsed). This lets the search panel surface "Expanded N earlier
  // messages" exactly once per panel-open, per the agreed design.
  useImperativeHandle(ref, (): MessageListRevealHandle => ({
    revealAll: () => {
      if (totalEarlierMessages === 0) return 0;
      const previouslyHidden = collapsedCount;
      if (previouslyHidden === 0) return 0;
      setRevealedCount(totalEarlierMessages);
      return previouslyHidden;
    },
  }), [totalEarlierMessages, collapsedCount]);

  // Notify parent of collapsed count changes (for anchor rail sync)
  useEffect(() => {
    onCollapsedCountChange?.(collapsedCount);
  }, [collapsedCount, onCollapsedCountChange]);
  const visibleMessages = useMemo(
    () => (shouldCollapse ? messages.slice(collapsedCount) : messages),
    [messages, shouldCollapse, collapsedCount]
  );

  const visibleMessageUnits = useMemo((): VisibleMessageUnit[] => {
    const units: VisibleMessageUnit[] = [];
    let visibleIndex = 0;

    while (visibleIndex < visibleMessages.length) {
      const messageIndex = shouldCollapse ? visibleIndex + collapsedCount : visibleIndex;
      const message = visibleMessages[visibleIndex];
      const responseId = message.type === 'assistant' && typeof message.__responseId === 'string'
        ? message.__responseId
        : undefined;

      if (!responseId) {
        units.push({ kind: 'message', message, messageIndex });
        visibleIndex += 1;
        continue;
      }

      const items: Array<{ message: ClaudeMessage; messageIndex: number }> = [];
      let cursor = visibleIndex;
      while (cursor < visibleMessages.length) {
        const candidate = visibleMessages[cursor];
        if (candidate.type !== 'assistant' || candidate.__responseId !== responseId) {
          break;
        }
        items.push({
          message: candidate,
          messageIndex: shouldCollapse ? cursor + collapsedCount : cursor,
        });
        cursor += 1;
      }

      if (items.length > 1) {
        units.push({ kind: 'assistant_response_group', responseId, items });
      } else {
        units.push({ kind: 'message', message, messageIndex });
      }
      visibleIndex = cursor;
    }

    return units;
  }, [visibleMessages, shouldCollapse, collapsedCount]);

  return (
    <div className="message-list" onContextMenu={handleMessageContextMenu}>
      {ctxMenu.visible && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={ctxMenu.close}
          items={[
            { label: t('contextMenu.copy', 'Copy'), action: () => copySelection(ctxMenu.savedRange, ctxMenu.selectedText) },
          ]}
        />
      )}
      {shouldCollapse && (
        <div
          className="collapsed-messages-indicator"
          onClick={handleRevealMore}
        >
          {t('chat.showEarlierMessages', { count: nextChunkSize })}
          {collapsedCount > nextChunkSize ? ` (${collapsedCount})` : ''}
        </div>
      )}

      {visibleMessageUnits.map((unit) => {
        if (unit.kind === 'assistant_response_group') {
          const firstIndex = unit.items[0].messageIndex;
          const lastIndex = unit.items[unit.items.length - 1].messageIndex;
          const usage = getGroupedAssistantUsage(unit.items);
          return (
            <div
              key={`response-${unit.responseId}-${firstIndex}-${lastIndex}`}
              className="message assistant assistant-response-group"
              data-response-id={unit.responseId}
            >
              <div className="message-avatar-row">
                <MessageAvatar type="assistant" />
                <div className="message-content-wrapper">
                  <div className="message-content assistant-response-content">
                    {unit.items.map(({ message, messageIndex }, itemIndex) => {
                      const messageKey = getMessageKey(message, messageIndex);
                      const toolResultSignature = getMessageToolResultSignature(message, messageIndex, getContentBlocks, findToolResult);
                      return (
                        <div
                          key={messageKey}
                          className="assistant-response-segment"
                          data-segment-index={itemIndex}
                        >
                          <MessageItem
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
                            onNavigateToProviderSettings={onNavigateToProviderSettings}
                            onNavigateToDependencySettings={onNavigateToDependencySettings}
                            toolResultSignature={toolResultSignature}
                            currentProvider={currentProvider}
                            withinResponseGroup={true}
                            renderMode="response-segment"
                          />
                        </div>
                      );
                    })}
                  </div>
                  <MessageUsageStats
                    inputTokens={usage.inputTokens}
                    outputTokens={usage.outputTokens}
                    durationMs={usage.durationMs}
                    durationLabelKey={usage.durationLabelKey}
                    t={t}
                  />
                </div>
              </div>
            </div>
          );
        }

        const { message, messageIndex } = unit;
        const messageKey = getMessageKey(message, messageIndex);
        const toolResultSignature = getMessageToolResultSignature(message, messageIndex, getContentBlocks, findToolResult);

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
            onNavigateToProviderSettings={onNavigateToProviderSettings}
            onNavigateToDependencySettings={onNavigateToDependencySettings}
            toolResultSignature={toolResultSignature}
            currentProvider={currentProvider}
          />
        );
      })}

      {/* Loading / queue indicator */}
      {waitingVisible && (
        <WaitingIndicator
          startTime={loadingStartTime ?? undefined}
          queueDisplayState={queueDisplayState}
          queueAheadCount={queueAheadCount}
          loading={loading}
          onExitComplete={handleWaitingExitComplete}
        />
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}));
