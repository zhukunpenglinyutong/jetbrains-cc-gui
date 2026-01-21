import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, TodoItem } from '../types';

interface UseTodoExtractionProps {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
}

interface UseTodoExtractionReturn {
  globalTodos: TodoItem[];
}

// Scan limit for finding todowrite - only scan last N messages
const SCAN_LIMIT = 50;

/**
 * Hook for extracting global todos from messages
 * Extracts todo panel data from the latest todowrite tool call
 */
export function useTodoExtraction({
  messages,
  getContentBlocks,
}: UseTodoExtractionProps): UseTodoExtractionReturn {
  // Extract the latest todos from messages for global TodoPanel display
  // Performance optimization: only scan last 50 messages, since todowrite usually appears in recent conversation
  const globalTodos = useMemo(() => {
    const startIndex = Math.max(0, messages.length - SCAN_LIMIT);

    // Iterate backwards to find the latest todowrite tool call
    for (let i = messages.length - 1; i >= startIndex; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant') continue;

      const blocks = getContentBlocks(msg);
      // Iterate blocks backwards to find the latest todowrite
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j];
        if (
          block.type === 'tool_use' &&
          block.name?.toLowerCase() === 'todowrite' &&
          Array.isArray((block.input as { todos?: TodoItem[] })?.todos)
        ) {
          return (block.input as { todos: TodoItem[] }).todos;
        }
      }
    }
    return [];
  }, [messages, getContentBlocks]);

  return {
    globalTodos,
  };
}
