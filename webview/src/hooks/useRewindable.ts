import { useMemo } from 'react';
import { formatTime } from '../utils/helpers';
import { FILE_MODIFY_TOOL_NAMES, isToolName } from '../utils/toolConstants';
import type { ClaudeMessage, ClaudeContentBlock } from '../types';
import type { RewindableMessage } from '../components/RewindSelectDialog';

interface UseRewindableProps {
  mergedMessages: ClaudeMessage[];
  currentProvider: string;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  getMessageText: (message: ClaudeMessage) => string;
}

interface UseRewindableReturn {
  rewindableIndicesSet: Set<number>;
  rewindableMessages: RewindableMessage[];
}

/**
 * Hook for calculating rewindable message indices and rewindable messages list
 * Optimizes from O(n²) to O(n) by pre-computing in a single pass
 */
export function useRewindable({
  mergedMessages,
  currentProvider,
  getContentBlocks,
  getMessageText,
}: UseRewindableProps): UseRewindableReturn {
  // Pre-compute rewindable user message indices set
  // Performance optimization: O(n²) → O(n) by single-pass pre-computation
  const rewindableIndicesSet = useMemo(() => {
    const indices = new Set<number>();
    if (currentProvider !== 'claude' || mergedMessages.length === 0) {
      return indices;
    }

    // Iterate backwards, mark which user messages have file modify operations after them
    let hasFileModifyAfter = false;
    let lastUserIndex = -1;

    for (let i = mergedMessages.length - 1; i >= 0; i--) {
      const msg = mergedMessages[i];

      if (msg.type === 'user') {
        // When encountering a user message, check if there are file modifications after it
        if (hasFileModifyAfter && lastUserIndex !== i) {
          // Also need to check if this user message is a tool_result
          const content = (msg.content || '').trim();
          if (content !== '[tool_result]') {
            const raw = msg.raw;
            let isToolResult = false;
            if (raw && typeof raw !== 'string') {
              const rawContent = (raw as any).content ?? (raw as any).message?.content;
              if (Array.isArray(rawContent) && rawContent.some((block: any) => block && block.type === 'tool_result')) {
                isToolResult = true;
              }
            }
            if (!isToolResult) {
              indices.add(i);
            }
          }
        }
        // Reset state, start checking the interval before this user message
        hasFileModifyAfter = false;
        lastUserIndex = i;
      } else if (msg.type === 'assistant') {
        // Check if assistant message contains file modify tools
        const blocks = getContentBlocks(msg);
        for (const block of blocks) {
          if (block.type === 'tool_use' && isToolName(block.name, FILE_MODIFY_TOOL_NAMES)) {
            hasFileModifyAfter = true;
            break;
          }
        }
      }
    }

    return indices;
  }, [mergedMessages, currentProvider, getContentBlocks]);

  // Calculate rewindable messages for the select dialog
  // Uses pre-computed indices set to avoid repeated iteration
  const rewindableMessages = useMemo((): RewindableMessage[] => {
    if (currentProvider !== 'claude') {
      return [];
    }

    const result: RewindableMessage[] = [];

    // Only iterate over pre-computed rewindable indices
    for (const i of rewindableIndicesSet) {
      if (i >= mergedMessages.length - 1) continue;

      const message = mergedMessages[i];
      const content = message.content || getMessageText(message);
      const timestamp = message.timestamp ? formatTime(message.timestamp) : undefined;
      const messagesAfterCount = mergedMessages.length - i - 1;

      result.push({
        messageIndex: i,
        message,
        displayContent: content,
        timestamp,
        messagesAfterCount,
      });
    }

    // Sort by index to ensure consistent order
    result.sort((a, b) => a.messageIndex - b.messageIndex);

    return result;
  }, [mergedMessages, currentProvider, rewindableIndicesSet, getMessageText]);

  return {
    rewindableIndicesSet,
    rewindableMessages,
  };
}
