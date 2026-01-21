import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createLocalizeMessage } from '../utils/localizationUtils';
import {
  normalizeBlocks as normalizeBlocksUtil,
  getMessageText as getMessageTextUtil,
  shouldShowMessage as shouldShowMessageUtil,
  getContentBlocks as getContentBlocksUtil,
  mergeConsecutiveAssistantMessages,
} from '../utils/messageUtils';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRawMessage,
  ToolResultBlock,
} from '../types';

interface UseMessageProcessingProps {
  messages: ClaudeMessage[];
  currentSessionId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stableT: any; // TFunction type from react-i18next
}

interface UseMessageProcessingReturn {
  // Memoized functions
  localizeMessage: ReturnType<typeof createLocalizeMessage>;
  normalizeBlocks: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null;
  getMessageText: (message: ClaudeMessage) => string;
  shouldShowMessage: (message: ClaudeMessage) => boolean;
  shouldShowMessageCached: (message: ClaudeMessage) => boolean;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  // Merged messages
  mergedMessages: ClaudeMessage[];
  // Tool result finder
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  // Cache refs (exposed for potential external use)
  normalizeBlocksCache: React.MutableRefObject<WeakMap<object, ClaudeContentBlock[]>>;
  shouldShowMessageCache: React.MutableRefObject<WeakMap<object, boolean>>;
}

// Cache size limit constant
const MERGED_CACHE_MAX_SIZE = 500;

/**
 * Hook for message processing with caching
 * Extracts message utility functions and caching logic from App.tsx
 */
export function useMessageProcessing({
  messages,
  currentSessionId,
  stableT,
}: UseMessageProcessingProps): UseMessageProcessingReturn {
  // Create stable localizeMessage function
  const localizeMessage = useMemo(() => createLocalizeMessage(stableT), [stableT]);

  // Cache for normalizeBlocks to avoid re-parsing unchanged messages
  const normalizeBlocksCache = useRef(new WeakMap<object, ClaudeContentBlock[]>());
  const shouldShowMessageCache = useRef(new WeakMap<object, boolean>());
  const mergedAssistantMessageCache = useRef(
    new Map<string, { source: ClaudeMessage[]; merged: ClaudeMessage }>()
  );

  // Clear cache when dependencies change
  useEffect(() => {
    normalizeBlocksCache.current = new WeakMap();
    shouldShowMessageCache.current = new WeakMap();
    mergedAssistantMessageCache.current = new Map();
  }, [localizeMessage, stableT, currentSessionId]);

  // Cache cleanup: when mergedAssistantMessageCache exceeds 20% over limit, delete oldest entries
  // Uses 20% buffer to reduce cleanup frequency
  const limitMergedCache = useCallback(() => {
    const cache = mergedAssistantMessageCache.current;
    const cleanupThreshold = Math.floor(MERGED_CACHE_MAX_SIZE * 1.2);
    if (cache.size > cleanupThreshold) {
      // Map maintains insertion order, delete oldest entries
      const keysToDelete = Array.from(cache.keys()).slice(0, cache.size - MERGED_CACHE_MAX_SIZE);
      for (const key of keysToDelete) {
        cache.delete(key);
      }
    }
  }, []);

  const normalizeBlocks = useCallback(
    (raw?: ClaudeRawMessage | string) => {
      if (!raw) return null;
      if (typeof raw === 'object') {
        const cache = normalizeBlocksCache.current;
        if (cache.has(raw)) {
          return cache.get(raw)!;
        }
        const result = normalizeBlocksUtil(raw, localizeMessage, stableT);
        if (result) {
          cache.set(raw, result);
        }
        return result;
      }
      return normalizeBlocksUtil(raw, localizeMessage, stableT);
    },
    [localizeMessage, stableT]
  );

  const getMessageText = useCallback(
    (message: ClaudeMessage) => getMessageTextUtil(message, localizeMessage, stableT),
    [localizeMessage, stableT]
  );

  const shouldShowMessage = useCallback(
    (message: ClaudeMessage) => shouldShowMessageUtil(message, getMessageText, normalizeBlocks, stableT),
    [getMessageText, normalizeBlocks, stableT]
  );

  const shouldShowMessageCached = useCallback(
    (message: ClaudeMessage) => {
      const cache = shouldShowMessageCache.current;
      if (cache.has(message)) {
        return cache.get(message)!;
      }
      const result = shouldShowMessage(message);
      cache.set(message, result);
      return result;
    },
    [shouldShowMessage]
  );

  const getContentBlocks = useCallback(
    (message: ClaudeMessage) => getContentBlocksUtil(message, normalizeBlocks, localizeMessage),
    [normalizeBlocks, localizeMessage]
  );

  // Merge consecutive assistant messages to fix style inconsistencies in history
  const mergedMessages = useMemo(() => {
    const visible: ClaudeMessage[] = [];
    for (const message of messages) {
      if (shouldShowMessageCached(message)) {
        visible.push(message);
      }
    }
    const result = mergeConsecutiveAssistantMessages(
      visible,
      normalizeBlocks,
      mergedAssistantMessageCache.current
    );
    // Limit cache size to avoid memory leak
    limitMergedCache();
    return result;
  }, [messages, shouldShowMessageCached, normalizeBlocks, limitMergedCache]);

  // Use ref to store latest messages to avoid findToolResult dependency changes causing child re-renders
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const findToolResult = useCallback((toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') {
      return null;
    }

    const currentMessages = messagesRef.current;
    // Note: search in original messages array, not mergedMessages
    // Because tool_result may be in filtered out messages
    for (let i = 0; i < currentMessages.length; i += 1) {
      const candidate = currentMessages[i];
      const raw = candidate.raw;

      if (!raw || typeof raw === 'string') {
        continue;
      }
      // Compatible with raw.content and raw.message.content
      const content = raw.content ?? raw.message?.content;

      if (!Array.isArray(content)) {
        continue;
      }

      const resultBlock = content.find(
        (block): block is ToolResultBlock =>
          Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId
      );
      if (resultBlock) {
        return resultBlock;
      }
    }

    return null;
  }, []);

  return {
    localizeMessage,
    normalizeBlocks,
    getMessageText,
    shouldShowMessage,
    shouldShowMessageCached,
    getContentBlocks,
    mergedMessages,
    findToolResult,
    normalizeBlocksCache,
    shouldShowMessageCache,
  };
}
