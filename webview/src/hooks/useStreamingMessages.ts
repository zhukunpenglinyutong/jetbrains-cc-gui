import { useRef } from 'react';
import type { ClaudeMessage } from '../types';

/** A single block inside `raw.message.content`. */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

// Match backend StreamDeltaThrottler interval (33ms) so frontend renders
// each backend flush batch without extra accumulation lag.
export const THROTTLE_INTERVAL = 33;

interface UseStreamingMessagesReturn {
  // Content refs
  streamingContentRef: React.MutableRefObject<string>;
  streamingThinkingRef: React.MutableRefObject<string>;
  isStreamingRef: React.MutableRefObject<boolean>;
  useBackendStreamingRenderRef: React.MutableRefObject<boolean>;
  streamingMessageIndexRef: React.MutableRefObject<number>;

  // Throttle control refs (stores rAF IDs)
  contentUpdateTimeoutRef: React.MutableRefObject<number | null>;
  thinkingUpdateTimeoutRef: React.MutableRefObject<number | null>;
  lastContentUpdateRef: React.MutableRefObject<number>;
  lastThinkingUpdateRef: React.MutableRefObject<number>;

  // Auto-expanded thinking keys
  autoExpandedThinkingKeysRef: React.MutableRefObject<Set<string>>;

  // Turn tracking
  streamingTurnIdRef: React.MutableRefObject<number>;
  turnIdCounterRef: React.MutableRefObject<number>;

  // Helper functions
  findLastAssistantIndex: (list: ClaudeMessage[]) => number;
  extractRawBlocks: (raw: unknown) => ContentBlock[];
  getOrCreateStreamingAssistantIndex: (list: ClaudeMessage[]) => number;
  patchAssistantForStreaming: (assistant: ClaudeMessage) => ClaudeMessage;

  // Reset function
  resetStreamingState: () => void;
}

/**
 * Hook for managing streaming message state and helper functions
 */
export function useStreamingMessages(): UseStreamingMessagesReturn {
  // Content refs
  const streamingContentRef = useRef('');
  const streamingThinkingRef = useRef('');
  const isStreamingRef = useRef(false);
  const useBackendStreamingRenderRef = useRef(false);
  const streamingMessageIndexRef = useRef<number>(-1);

  // Throttle control refs
  const contentUpdateTimeoutRef = useRef<number | null>(null);
  const thinkingUpdateTimeoutRef = useRef<number | null>(null);
  const lastContentUpdateRef = useRef(0);
  const lastThinkingUpdateRef = useRef(0);

  // Auto-expanded thinking keys
  const autoExpandedThinkingKeysRef = useRef<Set<string>>(new Set());

  // Turn tracking
  const streamingTurnIdRef = useRef(-1);
  const turnIdCounterRef = useRef(0);

  // Helper: Find last assistant message index
  const findLastAssistantIndex = (list: ClaudeMessage[]): number => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.type === 'assistant') return i;
    }
    return -1;
  };

  // Helper: Extract raw blocks from message
  const extractRawBlocks = (raw: unknown): ContentBlock[] => {
    if (!raw || typeof raw !== 'object') return [];
    const rawObj = raw as Record<string, unknown>;
    const msg = rawObj.message as Record<string, unknown> | undefined;
    const blocks = rawObj.content ?? msg?.content;
    return Array.isArray(blocks) ? blocks : [];
  };

  const syncTextBlocksWithContent = (blocks: ContentBlock[], content: string): ContentBlock[] => {
    if (!content) return blocks;

    const textIndices = blocks
      .map((block, index) => (block?.type === 'text' ? index : -1))
      .filter((index) => index >= 0);

    if (textIndices.length === 0) {
      return [...blocks, { type: 'text', text: content }];
    }

    const lastTextIdx = textIndices[textIndices.length - 1];
    const prefixText = textIndices
      .slice(0, -1)
      .map((index) => (typeof blocks[index]?.text === 'string' ? blocks[index].text : ''))
      .join('');

    if (!content.startsWith(prefixText)) {
      if (textIndices.length !== 1) {
        return blocks;
      }
      const currentText = typeof blocks[lastTextIdx]?.text === 'string' ? blocks[lastTextIdx].text : '';
      if (currentText === content) {
        return blocks;
      }
      const nextBlocks = [...blocks];
      nextBlocks[lastTextIdx] = { ...nextBlocks[lastTextIdx], text: content };
      return nextBlocks;
    }

    const desiredLastText = content.slice(prefixText.length);
    if (!desiredLastText) {
      return blocks;
    }

    const currentLastText = typeof blocks[lastTextIdx]?.text === 'string' ? blocks[lastTextIdx].text : '';
    if (currentLastText === desiredLastText) {
      return blocks;
    }

    const nextBlocks = [...blocks];
    nextBlocks[lastTextIdx] = { ...nextBlocks[lastTextIdx], text: desiredLastText };
    return nextBlocks;
  };

  const getThinkingText = (block: ContentBlock | undefined): string => {
    if (!block) return '';
    if (typeof block.thinking === 'string') return block.thinking;
    if (typeof block.text === 'string') return block.text;
    return '';
  };

  // Mirror of syncTextBlocksWithContent for thinking blocks.
  // streamingThinkingRef accumulates ALL thinking deltas in the current turn,
  // including segments separated by tool_use blocks (extended thinking can
  // resume after a tool call).  We must therefore strip the prefix carried by
  // earlier thinking blocks before assigning the remainder to the last block,
  // otherwise the last block would receive the concatenation of every segment
  // and duplicate earlier content.
  const syncThinkingBlocksWithContent = (blocks: ContentBlock[], thinking: string): ContentBlock[] => {
    if (!thinking) return blocks;

    const thinkingIndices = blocks
      .map((block, index) => (block?.type === 'thinking' ? index : -1))
      .filter((index) => index >= 0);

    if (thinkingIndices.length === 0) {
      return [{ type: 'thinking', thinking, text: thinking }, ...blocks];
    }

    const lastThinkingIdx = thinkingIndices[thinkingIndices.length - 1];
    const prefixThinking = thinkingIndices
      .slice(0, -1)
      .map((index) => getThinkingText(blocks[index]))
      .join('');

    if (!thinking.startsWith(prefixThinking)) {
      // Cannot reconcile cumulative buffer with split blocks (e.g., backend
      // dedup rewrote earlier blocks).  For a single block we still try to
      // overwrite directly; otherwise leave structure untouched.
      if (thinkingIndices.length !== 1) {
        return blocks;
      }
      const currentThinking = getThinkingText(blocks[lastThinkingIdx]);
      if (currentThinking === thinking) {
        return blocks;
      }
      const nextBlocks = [...blocks];
      nextBlocks[lastThinkingIdx] = {
        ...nextBlocks[lastThinkingIdx],
        thinking,
        text: thinking,
      };
      return nextBlocks;
    }

    const desiredLastThinking = thinking.slice(prefixThinking.length);
    if (!desiredLastThinking) {
      return blocks;
    }

    const currentLastThinking = getThinkingText(blocks[lastThinkingIdx]);
    if (currentLastThinking === desiredLastThinking) {
      return blocks;
    }

    const nextBlocks = [...blocks];
    nextBlocks[lastThinkingIdx] = {
      ...nextBlocks[lastThinkingIdx],
      thinking: desiredLastThinking,
      text: desiredLastThinking,
    };
    return nextBlocks;
  };

  /**
   * Get or create streaming assistant message index.
   * NOTE: This function MUTATES the passed list array by pushing a new message
   * if no assistant message exists. Call this only with a copied array (e.g., [...prev]).
   * @param list - Mutable message array (should be a copy, not the original state)
   * @returns The index of the assistant message
   */
  const getOrCreateStreamingAssistantIndex = (list: ClaudeMessage[]): number => {
    const currentIdx = streamingMessageIndexRef.current;
    if (currentIdx >= 0 && currentIdx < list.length && list[currentIdx]?.type === 'assistant') {
      return currentIdx;
    }
    const lastAssistantIdx = findLastAssistantIndex(list);
    if (lastAssistantIdx >= 0) {
      streamingMessageIndexRef.current = lastAssistantIdx;
      return lastAssistantIdx;
    }
    // No assistant: append a placeholder (mutates the list)
    streamingMessageIndexRef.current = list.length;
    list.push({
      type: 'assistant',
      content: '',
      isStreaming: true,
      timestamp: new Date().toISOString(),
      raw: { message: { content: [] } } as ClaudeMessage['raw'],
    });
    return streamingMessageIndexRef.current;
  };

  // Helper: Patch assistant message for streaming.
  // Backend snapshots remain the source of truth for structure, but the currently
  // growing text/thinking blocks must stay aligned with the delta buffers because
  // the UI renders primarily from raw blocks. For the top-level .content string,
  // use the longer of streamingContentRef (delta-accumulated) and assistant.content
  // (backend snapshot). This prevents content from "jumping back" when updateMessages
  // arrives before the delta throttler flushes.
  const patchAssistantForStreaming = (assistant: ClaudeMessage): ClaudeMessage => {
    const deltaContent = streamingContentRef.current || '';
    const backendContent = assistant.content || '';
    const bestContent = deltaContent.length >= backendContent.length ? deltaContent : backendContent;

    const deltaThinking = streamingThinkingRef.current || '';
    let patchedRaw = assistant.raw;

    if (patchedRaw && typeof patchedRaw === 'object') {
      const rawObj = patchedRaw as Record<string, unknown>;
      const msg = rawObj.message as Record<string, unknown> | undefined;
      const rawContent = Array.isArray(rawObj.content)
        ? rawObj.content
        : Array.isArray(msg?.content) ? msg.content : [];

      let blocks = [...rawContent] as ContentBlock[];
      blocks = syncThinkingBlocksWithContent(blocks, deltaThinking);
      blocks = syncTextBlocksWithContent(blocks, bestContent);

      patchedRaw = (msg
        ? { ...rawObj, message: { ...msg, content: blocks } }
        : { ...rawObj, content: blocks }) as ClaudeMessage['raw'];
    } else if (deltaThinking) {
      let blocks: ContentBlock[] = [];
      blocks = syncThinkingBlocksWithContent(blocks, deltaThinking);
      blocks = syncTextBlocksWithContent(blocks, bestContent);
      patchedRaw = { message: { content: blocks } } as ClaudeMessage['raw'];
    }

    return {
      ...assistant,
      content: bestContent,
      raw: patchedRaw,
      isStreaming: true,
    } as ClaudeMessage;
  };

  // Reset all streaming state
  const resetStreamingState = () => {
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    streamingMessageIndexRef.current = -1;
    lastContentUpdateRef.current = 0;
    lastThinkingUpdateRef.current = 0;
    autoExpandedThinkingKeysRef.current.clear();
    streamingTurnIdRef.current = -1;

    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }
  };

  return {
    // Content refs
    streamingContentRef,
    streamingThinkingRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    streamingMessageIndexRef,

    // Throttle control refs
    contentUpdateTimeoutRef,
    thinkingUpdateTimeoutRef,
    lastContentUpdateRef,
    lastThinkingUpdateRef,

    // Auto-expanded thinking keys
    autoExpandedThinkingKeysRef,

    // Turn tracking
    streamingTurnIdRef,
    turnIdCounterRef,

    // Helper functions
    findLastAssistantIndex,
    extractRawBlocks,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,

    // Reset function
    resetStreamingState,
  };
}
