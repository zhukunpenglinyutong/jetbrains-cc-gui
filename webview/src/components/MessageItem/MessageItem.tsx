import { useState, useCallback, useMemo, memo, useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../../types';

import MarkdownBlock from '../MarkdownBlock';
import {
  EditToolBlock,
  EditToolGroupBlock,
  ReadToolBlock,
  ReadToolGroupBlock,
} from '../toolBlocks';
import { ContentBlockRenderer } from './ContentBlockRenderer';
import { formatTime } from '../../utils/helpers';
import { copyToClipboard } from '../../utils/copyUtils';
import { READ_TOOL_NAMES, EDIT_TOOL_NAMES, isToolName } from '../../utils/toolConstants';

export interface MessageItemProps {
  message: ClaudeMessage;
  messageIndex: number;
  isLast: boolean;
  streamingActive: boolean;
  isThinking: boolean;
  t: TFunction;
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  extractMarkdownContent: (message: ClaudeMessage) => string;
}

type GroupedBlock =
  | { type: 'single'; block: ClaudeContentBlock; originalIndex: number }
  | { type: 'read_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'edit_group'; blocks: ClaudeContentBlock[]; startIndex: number };

function isToolBlockOfType(block: ClaudeContentBlock, toolNames: Set<string>): boolean {
  return block.type === 'tool_use' && isToolName(block.name, toolNames);
}

function groupBlocks(blocks: ClaudeContentBlock[]): GroupedBlock[] {
  const groupedBlocks: GroupedBlock[] = [];
  let currentReadGroup: ClaudeContentBlock[] = [];
  let readGroupStartIndex = -1;
  let currentEditGroup: ClaudeContentBlock[] = [];
  let editGroupStartIndex = -1;

  const flushReadGroup = () => {
    if (currentReadGroup.length > 0) {
      groupedBlocks.push({
        type: 'read_group',
        blocks: [...currentReadGroup],
        startIndex: readGroupStartIndex,
      });
      currentReadGroup = [];
      readGroupStartIndex = -1;
    }
  };

  const flushEditGroup = () => {
    if (currentEditGroup.length > 0) {
      groupedBlocks.push({
        type: 'edit_group',
        blocks: [...currentEditGroup],
        startIndex: editGroupStartIndex,
      });
      currentEditGroup = [];
      editGroupStartIndex = -1;
    }
  };

  blocks.forEach((block, idx) => {
    if (isToolBlockOfType(block, READ_TOOL_NAMES)) {
      flushEditGroup();
      if (currentReadGroup.length === 0) {
        readGroupStartIndex = idx;
      }
      currentReadGroup.push(block);
    } else if (isToolBlockOfType(block, EDIT_TOOL_NAMES)) {
      flushReadGroup();
      if (currentEditGroup.length === 0) {
        editGroupStartIndex = idx;
      }
      currentEditGroup.push(block);
    } else {
      flushReadGroup();
      flushEditGroup();
      groupedBlocks.push({ type: 'single', block, originalIndex: idx });
    }
  });

  flushReadGroup();
  flushEditGroup();

  return groupedBlocks;
}

export const MessageItem = memo(function MessageItem({
  message,
  messageIndex,
  isLast,
  streamingActive,
  isThinking,
  t,
  getMessageText,
  getContentBlocks,
  findToolResult,
  extractMarkdownContent,
}: MessageItemProps): React.ReactElement {
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

  // Manage thinking expansion state locally to avoid prop drilling and unnecessary re-renders
  const [expandedThinking, setExpandedThinking] = useState<Record<number, boolean>>({});

  const toggleThinking = useCallback((blockIndex: number) => {
    setExpandedThinking((prev) => ({
      ...prev,
      [blockIndex]: !prev[blockIndex],
    }));
  }, []);

  const isThinkingExpanded = useCallback(
    (blockIndex: number) => Boolean(expandedThinking[blockIndex]),
    [expandedThinking]
  );

  const isLastAssistantMessage = message.type === 'assistant' && isLast;
  const isMessageStreaming = streamingActive && isLastAssistantMessage;

  const handleCopyMessage = useCallback(async () => {
    const content = extractMarkdownContent(message);
    if (!content.trim()) return;

    const success = await copyToClipboard(content);
    if (success) {
      setCopiedMessageIndex(messageIndex);
      setTimeout(() => setCopiedMessageIndex(null), 1500);
    }
  }, [message, messageIndex, extractMarkdownContent]);

  // Memoize blocks and grouped blocks to avoid recalculation on every render
  const blocks = useMemo(() => getContentBlocks(message), [message, getContentBlocks]);

  // Ref to track the last auto-expanded thinking block index to avoid overriding user interaction
  const lastAutoExpandedIndexRef = useRef<number>(-1);

  // Auto-expand the latest thinking block during streaming
  useEffect(() => {
    if (!isMessageStreaming) return;

    const thinkingIndices = blocks
      .map((block, index) => (block.type === 'thinking' ? index : -1))
      .filter((index) => index !== -1);

    if (thinkingIndices.length === 0) return;

    const lastThinkingIndex = thinkingIndices[thinkingIndices.length - 1];

    if (lastThinkingIndex !== lastAutoExpandedIndexRef.current) {
      setExpandedThinking((prev) => {
        const newState = { ...prev };
        // Collapse all thinking blocks
        thinkingIndices.forEach((idx) => {
          newState[idx] = false;
        });
        // Expand the latest one
        newState[lastThinkingIndex] = true;
        return newState;
      });
      lastAutoExpandedIndexRef.current = lastThinkingIndex;
    }
  }, [blocks, isMessageStreaming]);

  const groupedBlocks = useMemo(() => groupBlocks(blocks), [blocks]);
  const messageStyle = useMemo(
    () => ({ contentVisibility: 'auto', containIntrinsicSize: '0 320px' } as const),
    []
  );

  const renderGroupedBlocks = () => {
    if (message.type === 'error') {
      return <MarkdownBlock content={getMessageText(message)} />;
    }

    return groupedBlocks.map((grouped) => {
      if (grouped.type === 'read_group') {
        const readItems = grouped.blocks.map((b) => {
          const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
          return {
            name: block.name,
            input: block.input,
            result: findToolResult(block.id, messageIndex),
          };
        });

        if (readItems.length === 1) {
          return (
            <div key={`${messageIndex}-readgroup-${grouped.startIndex}`} className="content-block">
              <ReadToolBlock input={readItems[0].input} />
            </div>
          );
        }

        return (
          <div key={`${messageIndex}-readgroup-${grouped.startIndex}`} className="content-block">
            <ReadToolGroupBlock items={readItems} />
          </div>
        );
      }

      if (grouped.type === 'edit_group') {
        const editItems = grouped.blocks.map((b) => {
          const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
          return {
            name: block.name,
            input: block.input,
            result: findToolResult(block.id, messageIndex),
          };
        });

        if (editItems.length === 1) {
          return (
            <div key={`${messageIndex}-editgroup-${grouped.startIndex}`} className="content-block">
              <EditToolBlock
                name={editItems[0].name}
                input={editItems[0].input}
                result={editItems[0].result}
              />
            </div>
          );
        }

        return (
          <div key={`${messageIndex}-editgroup-${grouped.startIndex}`} className="content-block">
            <EditToolGroupBlock items={editItems} />
          </div>
        );
      }

      const { block, originalIndex: blockIndex } = grouped;

      return (
        <div key={`${messageIndex}-${blockIndex}`} className="content-block">
          <ContentBlockRenderer
            block={block}
            messageIndex={messageIndex}
            messageType={message.type}
            isStreaming={isMessageStreaming}
            isThinkingExpanded={isThinkingExpanded(blockIndex)}
            isThinking={isThinking}
            isLastMessage={isLast}
            t={t}
            onToggleThinking={() => toggleThinking(blockIndex)}
            findToolResult={findToolResult}
          />
        </div>
      );
    });
  };

  return (
    <div className={`message ${message.type}`} style={messageStyle}>
      {/* Copy button for assistant messages */}
      {message.type === 'assistant' && !isMessageStreaming && (
        <button
          className={`message-copy-btn ${copiedMessageIndex === messageIndex ? 'copied' : ''}`}
          onClick={handleCopyMessage}
          title={t('markdown.copyMessage')}
          aria-label={t('markdown.copyMessage')}
        >
          <span className="copy-icon">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor" fillOpacity="0.9"/>
              <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fillOpacity="0.6"/>
            </svg>
          </span>
          <span className="copy-tooltip">{t('markdown.copySuccess')}</span>
        </button>
      )}

      {/* Timestamp for user messages */}
      {message.type === 'user' && message.timestamp && (
        <div className="message-header-row">
          <div className="message-timestamp-header">
            {formatTime(message.timestamp)}
          </div>
        </div>
      )}

      {/* Role label for non-user/assistant messages */}
      {message.type !== 'assistant' && message.type !== 'user' && (
        <div className="message-role-label">
          {message.type}
        </div>
      )}

      <div className="message-content">
        {renderGroupedBlocks()}
      </div>
    </div>
  );
});
