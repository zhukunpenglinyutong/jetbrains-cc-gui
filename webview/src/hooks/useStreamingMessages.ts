import { useRef } from 'react';
import type { ClaudeMessage } from '../types';

/** A single block inside `raw.message.content`. */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

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

  // Turn tracking
  streamingTurnIdRef: React.MutableRefObject<number>;
  turnIdCounterRef: React.MutableRefObject<number>;

  // Helper functions
  findLastAssistantIndex: (list: ClaudeMessage[]) => number;
  extractRawBlocks: (raw: unknown) => ContentBlock[];
  buildStreamingBlocks: (existingBlocks: ContentBlock[]) => ContentBlock[];
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

  const normalizeThinking = (thinking: string): string => {
    return thinking
      .replace(/\r\n?/g, '\n')
      .replace(/\n[ \t]*\n+/g, '\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  };

  const isDoubledContent = (candidate: string, base: string): boolean => {
    if (!base || !candidate || base.length >= candidate.length) return false;
    // Check if candidate is base repeated 2+ times (e.g., "ABCABC" from "ABC")
    const repeated = base + base;
    return candidate.startsWith(repeated);
  };

  const preferMoreCompleteText = (segmentText: unknown, existingText: unknown): string => {
    const streamed = typeof segmentText === 'string' ? segmentText : '';
    const existing = typeof existingText === 'string' ? existingText : '';

    if (!streamed) return existing;
    if (!existing) return streamed;
    if (isDoubledContent(existing, streamed)) return streamed;
    return existing.length > streamed.length ? existing : streamed;
  };

  const preferMoreCompleteThinking = (segmentThinking: unknown, existingThinking: unknown): string => {
    const streamed = typeof segmentThinking === 'string' ? normalizeThinking(segmentThinking) : '';
    const existing = typeof existingThinking === 'string' ? normalizeThinking(existingThinking) : '';

    if (!streamed) return existing;
    if (!existing) return streamed;
    if (isDoubledContent(existing, streamed)) return streamed;
    return existing.length > streamed.length ? existing : streamed;
  };

  const getBlockTextContent = (block: ContentBlock, type: 'text' | 'thinking'): string => {
    if (!block || typeof block !== 'object') return '';
    if (type === 'thinking') {
      return normalizeThinking(
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : '',
      );
    }
    return typeof block.text === 'string' ? block.text : '';
  };

  const mergeStreamingTextLikeContent = (left: string, right: string): string => {
    if (!left) return right;
    if (!right) return left;
    if (left.includes(right)) return left;
    if (right.includes(left)) return right;

    const MAX_OVERLAP_SEARCH = 200;
    const maxOverlap = Math.min(left.length, right.length, MAX_OVERLAP_SEARCH);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      if (left.slice(-overlap) === right.slice(0, overlap)) {
        return left + right.slice(overlap);
      }
    }

    return left + right;
  };

  const trimDuplicateTextLikeContent = (
    candidate: string,
    output: ContentBlock[],
    type: 'text' | 'thinking',
  ): string => {
    let remaining = candidate;
    if (!remaining) return '';

    for (const block of output) {
      if (!block || typeof block !== 'object' || block.type !== type) {
        continue;
      }

      const existing = getBlockTextContent(block, type);
      if (!existing) continue;

      if (existing.includes(remaining)) {
        return '';
      }

      if (remaining.startsWith(existing)) {
        remaining = remaining.slice(existing.length);
        if (!remaining) {
          return '';
        }
      } else {
        // Suffix-prefix overlap detection for markdown fences/code blocks that
        // the earlier startsWith/includes checks miss (e.g. trailing "```"
        // repeated in the next segment).
        //
        // MIN_OVERLAP=10: shorter matches (e.g. "```python") are ambiguous and
        //   frequently appear as legitimate repeated tokens inside prose. Ten
        //   characters is long enough to make an accidental collision unlikely
        //   while still catching a closing fence followed by a newline.
        // MAX_OVERLAP=200: the overlap only arises from the tail of one flush
        //   reappearing at the head of the next; in practice this spans a few
        //   lines of code. Capping the probe keeps the scan O(n) on short
        //   strings and bounds worst-case work on large buffers.
        const MIN_OVERLAP = 10;
        const MAX_OVERLAP = 200;
        const maxLen = Math.min(existing.length, remaining.length, MAX_OVERLAP);
        for (let n = maxLen; n >= MIN_OVERLAP; n -= 1) {
          if (existing.slice(-n) === remaining.slice(0, n)) {
            remaining = remaining.slice(n);
            break;
          }
        }
        if (!remaining) {
          return '';
        }
      }
    }

    return remaining;
  };

  /** Appends a de-duplicated text/thinking block. Mutates the `output` array in place. */
  const appendNovelTextLikeBlock = (
    output: ContentBlock[],
    type: 'text' | 'thinking',
    rawContent: string,
  ): void => {
    const normalized = type === 'thinking' ? normalizeThinking(rawContent) : rawContent;
    const novel = trimDuplicateTextLikeContent(normalized, output, type);
    if (!novel) {
      return;
    }

    const lastBlock = output[output.length - 1];
    if (lastBlock && typeof lastBlock === 'object' && lastBlock.type === type) {
      const existing = getBlockTextContent(lastBlock, type);
      const merged = mergeStreamingTextLikeContent(existing, novel);
      if (type === 'thinking') {
        output[output.length - 1] = {
          ...lastBlock,
          thinking: merged,
          text: merged,
        };
      } else {
        output[output.length - 1] = {
          ...lastBlock,
          text: merged,
        };
      }
      return;
    }

    if (type === 'thinking') {
      output.push({ type: 'thinking', thinking: novel, text: novel });
      return;
    }

    output.push({ type: 'text', text: novel });
  };

  // Helper: Build streaming blocks from segments.
  // Thinking blocks use index-based matching to preserve positions (multi-phase thinking).
  // After building, adjacent thinking blocks with overlapping content are merged
  // to prevent duplication while preserving distinct thinking phases.
  const buildStreamingBlocks = (existingBlocks: ContentBlock[]): ContentBlock[] => {
    const textSegments = streamingTextSegmentsRef.current;
    const thinkingSegments = streamingThinkingSegmentsRef.current;

    const output: ContentBlock[] = [];
    let thinkingIdx = 0;
    let textIdx = 0;

    // Process existing blocks in order, matching segments by position
    for (const block of existingBlocks) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'thinking') {
        const segmentContent = thinkingSegments[thinkingIdx];
        const backendContent = block.thinking ?? block.text ?? '';
        const thinking = preferMoreCompleteThinking(segmentContent, backendContent);
        thinkingIdx += 1;
        if (thinking.length > 0) {
          appendNovelTextLikeBlock(output, 'thinking', thinking);
        }
        continue;
      }

      if (block.type === 'text') {
        const segmentContent = textSegments[textIdx];
        const backendContent = block.text ?? '';
        const text = preferMoreCompleteText(segmentContent, backendContent);
        textIdx += 1;
        if (text.length > 0) {
          appendNovelTextLikeBlock(output, 'text', text);
        }
        continue;
      }

      // Non-text/thinking blocks (tool_use, image, etc.) - keep as-is
      output.push(block);
    }

    // Append remaining segments that weren't matched to existing blocks
    const phasesCount = Math.max(textSegments.length, thinkingSegments.length);
    const appendFromPhase = Math.max(textIdx, thinkingIdx);
    for (let phase = appendFromPhase; phase < phasesCount; phase += 1) {
      const thinking = thinkingSegments[phase];
      if (typeof thinking === 'string' && thinking.length > 0) {
        appendNovelTextLikeBlock(output, 'thinking', thinking);
      }
      const text = textSegments[phase];
      if (typeof text === 'string' && text.length > 0) {
        appendNovelTextLikeBlock(output, 'text', text);
      }
    }

    return mergeOverlappingThinkingBlocks(output);
  };

  /**
   * Merge thinking blocks with overlapping content to prevent duplication.
   * Preserves distinct thinking phases that have no content overlap.
   * Uses mark-and-filter approach to avoid splice index corruption.
   */
  const mergeOverlappingThinkingBlocks = (blocks: ContentBlock[]): ContentBlock[] => {
    const thinkingIndices: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i]?.type === 'thinking') thinkingIndices.push(i);
    }

    if (thinkingIndices.length <= 1) return blocks;

    const thinkingContents = thinkingIndices.map((i) =>
      normalizeThinking(blocks[i]?.thinking ?? blocks[i]?.text ?? ''),
    );

    // Group thinking blocks that have overlapping content
    const mergeGroups: number[][] = [];
    const assigned = new Set<number>();

    for (let i = 0; i < thinkingContents.length; i++) {
      if (assigned.has(i)) continue;
      const group = [i];
      assigned.add(i);

      for (let j = i + 1; j < thinkingContents.length; j++) {
        if (assigned.has(j)) continue;
        const a = thinkingContents[i];
        const b = thinkingContents[j];
        // Overlap: one contains the other (covers prefix/suffix cases too)
        if (a.includes(b) || b.includes(a)) {
          group.push(j);
          assigned.add(j);
        }
      }
      mergeGroups.push(group);
    }

    // Mark indices to remove, update first block with merged content
    const toRemove = new Set<number>();
    for (const group of mergeGroups) {
      if (group.length === 1) continue;

      let merged = '';
      for (const idx of group) {
        const content = thinkingContents[idx];
        if (content.includes(merged)) {
          merged = content;
        } else if (!merged.includes(content)) {
          merged = mergeStreamingTextLikeContent(merged, content);
        }
      }

      const firstIdx = thinkingIndices[group[0]];
      blocks[firstIdx] = { type: 'thinking', thinking: merged, text: merged };

      // Mark other blocks in group for removal
      for (let k = 1; k < group.length; k++) {
        toRemove.add(thinkingIndices[group[k]]);
      }
    }

    // Filter out marked blocks (single pass, no index corruption)
    return toRemove.size === 0 ? blocks : blocks.filter((_, idx) => !toRemove.has(idx));
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
    const existingRaw = (assistant.raw && typeof assistant.raw === 'object') ? (assistant.raw as Record<string, unknown>) : { message: { content: [] } };
    const existingBlocks = extractRawBlocks(existingRaw);
    const newBlocks = buildStreamingBlocks(existingBlocks);

    const msg = existingRaw.message as Record<string, unknown> | undefined;
    const rawPatched = msg
      ? { ...existingRaw, message: { ...msg, content: newBlocks } }
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
    streamingTurnIdRef.current = -1;

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

    // Turn tracking
    streamingTurnIdRef,
    turnIdCounterRef,

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
