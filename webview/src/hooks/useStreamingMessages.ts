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

      // Only update if content actually changed — prevents unnecessary React re-renders
      const currentThinking = lastBlock.thinking ?? lastBlock.text ?? '';
      const currentText = lastBlock.text ?? '';

      if (type === 'thinking') {
        if (merged !== currentThinking || merged !== currentText) {
          output[output.length - 1] = {
            ...lastBlock,
            thinking: merged,
            text: merged,
          };
        }
      } else {
        if (merged !== currentText) {
          output[output.length - 1] = {
            ...lastBlock,
            text: merged,
          };
        }
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

    return deduplicateTextLikeBlocks(output);
  };

  /**
   * Remove text/thinking blocks whose content is fully contained within
   * another block of the same type, then merge the survivors so the
   * longest version wins.  Handles both text and thinking blocks in a
   * single pass.
   *
   * This is the "nuclear" dedup: if buildStreamingBlocks produces N text
   * blocks with overlapping content (e.g. cumulative snapshots), this
   * collapses them into a single block containing the longest variant.
   */
  const deduplicateTextLikeBlocks = (blocks: ContentBlock[]): ContentBlock[] => {
    // Collect indices by type
    const indices: { type: 'text' | 'thinking'; idx: number; content: string }[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking') {
        indices.push({ type: 'thinking', idx: i, content: normalizeThinking(block.thinking ?? block.text ?? '') });
      } else if (block.type === 'text') {
        indices.push({ type: 'text', idx: i, content: block.text ?? '' });
      }
    }

    if (indices.length <= 1) return blocks;

    // Group consecutive same-type blocks that have overlapping content
    const toRemove = new Set<number>();
    let groupStart = 0;
    while (groupStart < indices.length) {
      const groupType = indices[groupStart].type;
      let groupEnd = groupStart;
      while (groupEnd + 1 < indices.length && indices[groupEnd + 1].type === groupType) {
        groupEnd += 1;
      }
      const groupSize = groupEnd - groupStart + 1;
      if (groupSize <= 1) {
        groupStart = groupEnd + 1;
        continue;
      }

      // Find the longest content in this group — that's the one we keep.
      // When lengths are equal, keep the earliest one (groupStart).
      let longestLocalIdx = groupStart;
      for (let i = groupStart + 1; i <= groupEnd; i++) {
        if (indices[i].content.length > indices[longestLocalIdx].content.length) {
          longestLocalIdx = i;
        }
      }
      const longestContent = indices[longestLocalIdx].content;

      // Remove any block whose content is fully contained in the longest.
      // This handles three cases:
      // 1. Empty content (c.length === 0)
      // 2. Identical content (c === longestContent)
      // 3. Shorter content that is a substring (c.length < longestContent.length && longestContent.includes(c))
      for (let i = groupStart; i <= groupEnd; i++) {
        if (i === longestLocalIdx) continue;
        const c = indices[i].content;
        if (c.length === 0 || c === longestContent || (c.length < longestContent.length && longestContent.includes(c))) {
          toRemove.add(indices[i].idx);
        }
      }

      groupStart = groupEnd + 1;
    }

    if (toRemove.size === 0) return blocks;

    // Update surviving blocks to use the longest content
    const longestByGroup = new Map<number, { content: string; type: 'text' | 'thinking' }>();
    let gs2 = 0;
    while (gs2 < indices.length) {
      const gt = indices[gs2].type;
      let ge = gs2;
      while (ge + 1 < indices.length && indices[ge + 1].type === gt) ge += 1;
      if (ge - gs2 + 1 > 1) {
        let longest = indices[gs2];
        for (let i = gs2 + 1; i <= ge; i++) {
          if (indices[i].content.length > longest.content.length) longest = indices[i];
        }
        longestByGroup.set(longest.idx, { content: longest.content, type: gt });
      }
      gs2 = ge + 1;
    }

    const result = blocks.filter((_, idx) => !toRemove.has(idx));
    for (const [idx, info] of longestByGroup) {
      const block = result.find((b) => {
        return b === blocks[idx];
      });
      if (!block) continue;
      if (info.type === 'thinking') {
        (block as any).thinking = info.content;
        (block as any).text = info.content;
      } else {
        (block as any).text = info.content;
      }
    }

    return result;
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
