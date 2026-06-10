import { memo, useState, useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { QueueDisplayState } from '../contexts/MessagesContext';
import { getMessageKey } from '../utils/messageUtils';
import { extractMessageUsage } from '../utils/messageUsage';
import { MessageItem, CopyButton } from './MessageItem';
import { MessageAvatar } from './MessageItem/MessageAvatar';
import { MessageUsageStats } from './MessageItem/MessageUsageStats';
import WaitingIndicator from './WaitingIndicator';
import { ContextMenu } from './ContextMenu';
import { useContextMenu, copySelection } from '../hooks/useContextMenu.js';
import { copyToClipboard } from '../utils/copyUtils';
import type { MessageListRevealHandle } from './ConversationSearch/types';

/** Always render at least this many recent messages. Earlier messages are collapsed. */
const VISIBLE_MESSAGE_WINDOW = 15;
/** Number of additional earlier messages to reveal per "show earlier" click. */
const REVEAL_PAGE_SIZE = 30;

/**
 * Tracks card keys (group responseId / single message key) that have already
 * played their messageFadeIn entry animation. A card animates ONLY on its first
 * logical appearance; subsequent re-renders — including any React remount from
 * streaming structural changes — do NOT replay the animation. This is what
 * removes the streaming "flicker" while keeping the full entry animation.
 * Cleared on session switch so a freshly loaded conversation animates in.
 */
const animatedEntryKeys = new Set<string>();

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

  // Whole-response copy state. The grouped card hosts one copy button per turn
  // (segments themselves carry no copy button), so this state lives at the list.
  const [copiedResponseId, setCopiedResponseId] = useState<string | null>(null);
  const copyResponseTimeoutRef = useRef<number | null>(null);

  const handleCopyResponse = useCallback(async (responseId: string, text: string) => {
    if (copiedResponseId === responseId) return;
    const success = await copyToClipboard(text);
    if (success) {
      setCopiedResponseId(responseId);
      if (copyResponseTimeoutRef.current !== null) {
        window.clearTimeout(copyResponseTimeoutRef.current);
      }
      copyResponseTimeoutRef.current = window.setTimeout(() => {
        setCopiedResponseId(null);
        copyResponseTimeoutRef.current = null;
      }, 1500);
    }
  }, [copiedResponseId]);

  useEffect(() => {
    return () => {
      if (copyResponseTimeoutRef.current !== null) {
        window.clearTimeout(copyResponseTimeoutRef.current);
        copyResponseTimeoutRef.current = null;
      }
    };
  }, []);

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
      // Clear entry-animation memory so the newly loaded conversation animates in.
      animatedEntryKeys.clear();
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

      // Any assistant carrying a __responseId renders as a group container —
      // even a single segment. Keeping the structure independent of segment
      // count keeps the top-level React key stable as segments are added or
      // removed during streaming, so the card never remounts (a remount would
      // replay the entry animation = the flicker we are fixing).
      units.push({ kind: 'assistant_response_group', responseId, items });
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
          const usage = getGroupedAssistantUsage(unit.items);
          const groupKey = `response-${unit.responseId}`;
          // Animate ONLY on the card's first appearance; never replay on remount.
          const groupFirstAppearance = !animatedEntryKeys.has(groupKey);
          if (groupFirstAppearance) {
            animatedEntryKeys.add(groupKey);
          }
          // A group is "streaming" while its last segment is still the active
          // streaming tail — copy is hidden then to avoid copying partial text.
          const isStreamingGroup = streamingActive
            && unit.items[unit.items.length - 1].messageIndex === messages.length - 1;
          const groupCopyableText = unit.items
            .map(({ message }) => extractMarkdownContent(message))
            .map((text) => text.trim())
            .filter((text) => text.length > 0)
            .join('\n\n');
          const groupHasCopyable = groupCopyableText.length > 0;
          return (
            <div
              key={groupKey}
              className={`message assistant assistant-response-group${groupFirstAppearance ? ' animate-in' : ''}`}
              data-response-id={unit.responseId}
            >
              <div className="message-avatar-row">
                <MessageAvatar type="assistant" />
                <div className="message-content-wrapper">
                  {!isStreamingGroup && groupHasCopyable && (
                    <CopyButton
                      isCopied={copiedResponseId === unit.responseId}
                      onClick={() => handleCopyResponse(unit.responseId, groupCopyableText)}
                      copyLabel={t('markdown.copyMessage')}
                      copySuccessText={t('markdown.copySuccess')}
                    />
                  )}
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
        const singleFirstAppearance = !animatedEntryKeys.has(messageKey);
        if (singleFirstAppearance) {
          animatedEntryKeys.add(messageKey);
        }

        return (
          <MessageItem
            key={messageKey}
            message={message}
            messageIndex={messageIndex}
            messageKey={messageKey}
            shouldAnimateIn={singleFirstAppearance}
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
