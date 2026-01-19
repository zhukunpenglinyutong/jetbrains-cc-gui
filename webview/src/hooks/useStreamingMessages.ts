import { useRef } from 'react';
import type { ClaudeMessage } from '../types';

export const THROTTLE_INTERVAL = 50; // 50ms throttle interval

interface UseStreamingMessagesReturn {
  // Content refs
  streamingContentRef: React.MutableRefObject<string>;
  isStreamingRef: React.MutableRefObject<boolean>;
  useBackendStreamingRenderRef: React.MutableRefObject<boolean>;
  streamingMessageIndexRef: React.MutableRefObject<number>;

  // Text segment refs
  streamingTextSegmentsRef: React.MutableRefObject<string[]>;
  activeTextSegmentIndexRef: React.MutableRefObject<number>;

  // Thinking segment refs
  streamingThinkingSegmentsRef: React.MutableRefObject<string[]>;
  activeThinkingSegmentIndexRef: React.MutableRefObject<number>;

  // Tool use tracking
  seenToolUseCountRef: React.MutableRefObject<number>;

  // Throttle control refs
  contentUpdateTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  thinkingUpdateTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  lastContentUpdateRef: React.MutableRefObject<number>;
  lastThinkingUpdateRef: React.MutableRefObject<number>;

  // Auto-expanded thinking keys
  autoExpandedThinkingKeysRef: React.MutableRefObject<Set<string>>;

  // Helper functions
  findLastAssistantIndex: (list: ClaudeMessage[]) => number;
  extractRawBlocks: (raw: unknown) => any[];
  buildStreamingBlocks: (existingBlocks: any[]) => any[];
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
  const isStreamingRef = useRef(false);
  const useBackendStreamingRenderRef = useRef(false);
  const streamingMessageIndexRef = useRef<number>(-1);

  // Text segment refs
  const streamingTextSegmentsRef = useRef<string[]>([]);
  const activeTextSegmentIndexRef = useRef<number>(-1);

  // Thinking segment refs
  const streamingThinkingSegmentsRef = useRef<string[]>([]);
  const activeThinkingSegmentIndexRef = useRef<number>(-1);

  // Tool use tracking
  const seenToolUseCountRef = useRef(0);

  // Throttle control refs
  const contentUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentUpdateRef = useRef(0);
  const lastThinkingUpdateRef = useRef(0);

  // Auto-expanded thinking keys
  const autoExpandedThinkingKeysRef = useRef<Set<string>>(new Set());

  // Helper: Find last assistant message index
  const findLastAssistantIndex = (list: ClaudeMessage[]): number => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.type === 'assistant') return i;
    }
    return -1;
  };

  // Helper: Extract raw blocks from message
  const extractRawBlocks = (raw: unknown): any[] => {
    if (!raw || typeof raw !== 'object') return [];
    const rawObj: any = raw;
    const blocks = rawObj.content ?? rawObj.message?.content;
    return Array.isArray(blocks) ? blocks : [];
  };

  const normalizeThinking = (thinking: string): string => {
    return thinking
      .replace(/\r\n?/g, '\n')
      .replace(/\n[ \t]*\n+/g, '\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  };

  // Helper: Build streaming blocks from segments
  const buildStreamingBlocks = (existingBlocks: any[]): any[] => {
    const textSegments = streamingTextSegmentsRef.current;
    const thinkingSegments = streamingThinkingSegmentsRef.current;

    const output: any[] = [];
    let thinkingIdx = 0;
    let textIdx = 0;

    for (const block of existingBlocks) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if (block.type === 'thinking') {
        const thinking = thinkingSegments[thinkingIdx];
        thinkingIdx += 1;
        if (typeof thinking === 'string' && thinking.length > 0) {
          const normalized = normalizeThinking(thinking);
          if (normalized.length > 0) {
            output.push({ type: 'thinking', thinking: normalized });
          }
        }
        continue;
      }
      if (block.type === 'text') {
        const text = textSegments[textIdx];
        textIdx += 1;
        if (typeof text === 'string' && text.length > 0) {
          output.push({ type: 'text', text });
        }
        continue;
      }

      output.push(block);
    }

    const phasesCount = Math.max(textSegments.length, thinkingSegments.length);
    const appendFromPhase = Math.max(textIdx, thinkingIdx);
    for (let phase = appendFromPhase; phase < phasesCount; phase += 1) {
      const thinking = thinkingSegments[phase];
      if (typeof thinking === 'string' && thinking.length > 0) {
        const normalized = normalizeThinking(thinking);
        if (normalized.length > 0) {
          output.push({ type: 'thinking', thinking: normalized });
        }
      }
      const text = textSegments[phase];
      if (typeof text === 'string' && text.length > 0) {
        output.push({ type: 'text', text });
      }
    }

    return output;
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

  // Helper: Patch assistant message for streaming
  const patchAssistantForStreaming = (assistant: ClaudeMessage): ClaudeMessage => {
    const existingRaw = (assistant.raw && typeof assistant.raw === 'object') ? (assistant.raw as any) : { message: { content: [] } };
    const existingBlocks = extractRawBlocks(existingRaw);
    const newBlocks = buildStreamingBlocks(existingBlocks);

    const rawPatched = existingRaw.message
      ? { ...existingRaw, message: { ...(existingRaw.message || {}), content: newBlocks } }
      : { ...existingRaw, content: newBlocks };

    return {
      ...assistant,
      content: streamingContentRef.current,
      raw: rawPatched,
      isStreaming: true,
    } as ClaudeMessage;
  };

  // Reset all streaming state
  const resetStreamingState = () => {
    streamingContentRef.current = '';
    streamingTextSegmentsRef.current = [];
    streamingThinkingSegmentsRef.current = [];
    streamingMessageIndexRef.current = -1;
    activeTextSegmentIndexRef.current = -1;
    activeThinkingSegmentIndexRef.current = -1;
    seenToolUseCountRef.current = 0;
    lastContentUpdateRef.current = 0;
    lastThinkingUpdateRef.current = 0;
    autoExpandedThinkingKeysRef.current.clear();

    if (contentUpdateTimeoutRef.current) {
      clearTimeout(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current) {
      clearTimeout(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }
  };

  return {
    // Content refs
    streamingContentRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    streamingMessageIndexRef,

    // Text segment refs
    streamingTextSegmentsRef,
    activeTextSegmentIndexRef,

    // Thinking segment refs
    streamingThinkingSegmentsRef,
    activeThinkingSegmentIndexRef,

    // Tool use tracking
    seenToolUseCountRef,

    // Throttle control refs
    contentUpdateTimeoutRef,
    thinkingUpdateTimeoutRef,
    lastContentUpdateRef,
    lastThinkingUpdateRef,

    // Auto-expanded thinking keys
    autoExpandedThinkingKeysRef,

    // Helper functions
    findLastAssistantIndex,
    extractRawBlocks,
    buildStreamingBlocks,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,

    // Reset function
    resetStreamingState,
  };
}
