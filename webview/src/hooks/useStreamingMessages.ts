import { useCallback, useRef } from 'react';
import type { ClaudeMessage } from '../types';
import { normalizeStreamingNewlines } from './windowCallbacks/messageSync';

export const THROTTLE_INTERVAL = 50; // 50ms throttle interval

/**
 * Base content block types that appear in assistant messages.
 * These are the streaming blocks that get rebuilt during reconciliation.
 */
export type StreamingContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string };

/**
 * Stable backend block types that are preserved during streaming reconciliation.
 * These blocks (tool_use, tool_result, custom) are not rebuilt and serve as anchors.
 *
 * NOTE: The catch-all branch uses `string & Record<never, never>` instead of plain
 * `string` to prevent TypeScript from collapsing the `ContentBlock` union — a plain
 * `string` type field would absorb `StreamingContentBlock`'s literal types ('thinking'
 * | 'text'), defeating compile-time discrimination. Runtime correctness is enforced
 * by `isStreamingBlock` / `isStableBackendBlock` guard functions regardless.
 */
export type StableBackendBlock =
  | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[]; is_error?: boolean }
  | { type: string & Record<never, never>; [key: string]: unknown };

/**
 * Union type for all possible content blocks in an assistant message.
 */
export type ContentBlock = StreamingContentBlock | StableBackendBlock;

/**
 * State object passed to patchAssistantForStreaming for deterministic block rebuilding.
 * All fields are optional - missing fields are derived from current streaming refs.
 */
export interface StreamingPatchState {
  /** Canonical text content (preferred over streamingContentRef.current) */
  canonicalText?: string;
  /** Canonical thinking content (preferred over streamingThinkingSegmentsRef) */
  canonicalThinking?: string;
  /** Existing blocks to preserve stable backend blocks (tool_use, tool_result, etc.) */
  existingBlocks?: ContentBlock[];
}

// ---------------------------------------------------------------------------
// Module-level pure utility functions for block type classification.
// Extracted from the hook to avoid per-render recreation (rerender-use-ref-transient-values)
// and enable independent testing.
// ---------------------------------------------------------------------------

/** Check if a thinking block has meaningful (non-whitespace) content. */
const hasMeaningfulThinking = (thinking: string): boolean => thinking.trim().length > 0;

/** Check if a block is a streaming content block (thinking or text). */
export const isStreamingBlock = (block: unknown): block is StreamingContentBlock => {
  return !!block && typeof block === 'object' && ((block as StreamingContentBlock).type === 'thinking' || (block as StreamingContentBlock).type === 'text');
};

/** Check if a block is a stable backend block (not thinking or text). */
export const isStableBackendBlock = (block: unknown): block is StableBackendBlock => {
  return !!block && typeof block === 'object' && !isStreamingBlock(block);
};

// ---------------------------------------------------------------------------
// Module-level pure block-building functions (S2: split dual-mode logic).
// Hoisted out of the hook body to avoid per-render recreation
// (rerender-use-ref-transient-values, rendering-hoist-jsx).
// ---------------------------------------------------------------------------

/**
 * Simple (non-interleaved) mode: rebuild canonical blocks in the middle.
 * Stable blocks are partitioned into prefix (before any streaming block)
 * and suffix (after any streaming block), with canonical thinking and text
 * blocks placed in between.
 */
const buildSimpleStreamingBlocks = (
  existingBlocks: ContentBlock[],
  canonicalText: string,
  canonicalThinking: string,
): ContentBlock[] => {
  const canonicalBlocks: ContentBlock[] = [];
  if (hasMeaningfulThinking(canonicalThinking)) {
    canonicalBlocks.push({ type: 'thinking', thinking: canonicalThinking });
  }
  if (canonicalText.length > 0) {
    canonicalBlocks.push({ type: 'text', text: canonicalText });
  }

  const stablePrefix: ContentBlock[] = [];
  const stableSuffix: ContentBlock[] = [];
  const existingStreamingBlocks: ContentBlock[] = [];
  let encounteredStreamingBlock = false;
  let existingThinking = '';
  let existingText = '';

  existingBlocks.forEach((block) => {
    if (!block || typeof block !== 'object') return;

    if (isStreamingBlock(block)) {
      encounteredStreamingBlock = true;
      existingStreamingBlocks.push(block);
      if (block.type === 'thinking') {
        existingThinking += block.thinking || '';
      } else if (block.type === 'text') {
        existingText += block.text || '';
      }
      return;
    }

    if (!isStableBackendBlock(block)) return;

    if (encounteredStreamingBlock) {
      stableSuffix.push(block);
    } else {
      stablePrefix.push(block);
    }
  });

  const trailingBlocks: ContentBlock[] = [];
  const canAppendTrailingThinking =
    stableSuffix.length > 0 &&
    hasMeaningfulThinking(canonicalThinking) &&
    existingThinking.length > 0 &&
    canonicalThinking.startsWith(existingThinking) &&
    canonicalThinking.length > existingThinking.length;
  const canAppendTrailingText =
    stableSuffix.length > 0 &&
    canonicalText.length > 0 &&
    existingText.length > 0 &&
    canonicalText.startsWith(existingText) &&
    canonicalText.length > existingText.length;

  if (canAppendTrailingThinking) {
    trailingBlocks.push({
      type: 'thinking',
      thinking: canonicalThinking.slice(existingThinking.length),
    });
  }
  if (canAppendTrailingText) {
    trailingBlocks.push({
      type: 'text',
      text: canonicalText.slice(existingText.length),
    });
  }

  if (trailingBlocks.length > 0) {
    return [...stablePrefix, ...existingStreamingBlocks, ...stableSuffix, ...trailingBlocks];
  }

  return [...stablePrefix, ...canonicalBlocks, ...stableSuffix];
};

/**
 * Interleaved mode: preserve the original block ordering from the backend.
 * Each block keeps its existing content; only the LAST thinking and LAST text
 * block may be extended with newly streamed content that the backend snapshot
 * has not yet reflected.
 */
const buildInterleavedStreamingBlocks = (
  existingBlocks: ContentBlock[],
  canonicalText: string,
  canonicalThinking: string,
  lastThinkingIdx: number,
  lastTextIdx: number,
): ContentBlock[] => {
  // Shallow-copy the array only (not individual elements) — only the two slots
  // at lastThinkingIdx / lastTextIdx are overwritten with new objects below;
  // all other elements are never mutated, so per-element cloning is wasteful.
  const result = [...existingBlocks];

  // Update the last thinking block
  if (lastThinkingIdx >= 0 && hasMeaningfulThinking(canonicalThinking)) {
    let priorThinking = '';
    for (let i = 0; i < lastThinkingIdx; i += 1) {
      const b = result[i];
      if (b && typeof b === 'object' && b.type === 'thinking') {
        // ContentBlock union: thinking blocks have either `thinking` or `text` field.
        const tb = b as StreamingContentBlock & { type: 'thinking'; text?: string };
        priorThinking += tb.thinking || tb.text || '';
      }
    }
    if (canonicalThinking.startsWith(priorThinking) && canonicalThinking.length > priorThinking.length) {
      const trailingThinking = canonicalThinking.slice(priorThinking.length);
      result[lastThinkingIdx] = { type: 'thinking', thinking: trailingThinking } as ContentBlock;
    }
    // else: keep backend value (canonical doesn't extend prior — likely a correction)
  }

  // Update the last text block
  if (lastTextIdx >= 0 && canonicalText.length > 0) {
    let priorText = '';
    for (let i = 0; i < lastTextIdx; i += 1) {
      const b = result[i];
      if (b && typeof b === 'object' && b.type === 'text') {
        priorText += (b as StreamingContentBlock & { type: 'text' }).text || '';
      }
    }
    if (canonicalText.startsWith(priorText) && canonicalText.length > priorText.length) {
      const trailingText = canonicalText.slice(priorText.length);
      result[lastTextIdx] = { type: 'text', text: trailingText } as ContentBlock;
    }
    // else: keep backend value
  }

  return result;
};

// ---------------------------------------------------------------------------
// Shared ref-clearing utility
// ---------------------------------------------------------------------------

/**
 * Refs that hold streaming data (not throttle timing).
 * Used by `clearStreamingDataRefs` to reset refs from multiple call-sites
 * (resetStreamingState, onStreamEnd) without duplicating the reset list.
 */
export interface StreamingDataRefs {
  streamingContentRef: React.MutableRefObject<string>;
  streamingTextSegmentsRef: React.MutableRefObject<string[]>;
  activeTextSegmentIndexRef: React.MutableRefObject<number>;
  streamingThinkingSegmentsRef: React.MutableRefObject<string[]>;
  activeThinkingSegmentIndexRef: React.MutableRefObject<number>;
  seenToolUseCountRef: React.MutableRefObject<number>;
  streamingMessageIndexRef: React.MutableRefObject<number>;
  streamingTurnIdRef: React.MutableRefObject<number>;
  autoExpandedThinkingKeysRef: React.MutableRefObject<Set<string>>;
}

/**
 * Reset all streaming data refs to their initial values.
 * Idempotent — safe under React StrictMode double-invocation.
 * Does NOT clear throttle timing refs (lastContentUpdateRef, etc.) or timeouts;
 * callers that need a full reset should clear those separately.
 */
export const clearStreamingDataRefs = (refs: StreamingDataRefs): void => {
  refs.streamingContentRef.current = '';
  refs.streamingTextSegmentsRef.current = [];
  refs.activeTextSegmentIndexRef.current = -1;
  refs.streamingThinkingSegmentsRef.current = [];
  refs.activeThinkingSegmentIndexRef.current = -1;
  refs.seenToolUseCountRef.current = 0;
  refs.streamingMessageIndexRef.current = -1;
  refs.streamingTurnIdRef.current = -1;
  refs.autoExpandedThinkingKeysRef.current.clear();
};

// ---------------------------------------------------------------------------
// Module-level pure helper functions.
// Extracted from the hook body so they are created once per module load,
// not on every render (rendering-hoist-jsx, rerender-use-ref-transient-values).
// ---------------------------------------------------------------------------

/** Find the index of the last assistant message in a list. */
export const findLastAssistantIndex = (list: ClaudeMessage[]): number => {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === 'assistant') return i;
  }
  return -1;
};

/** Extract content blocks from a raw message object. */
export const extractRawBlocks = (raw: unknown): ContentBlock[] => {
  if (!raw || typeof raw !== 'object') return [];
  const rawObj = raw as Record<string, unknown>;
  const messageObj = rawObj.message as Record<string, unknown> | undefined;
  const blocks = rawObj.content ?? messageObj?.content;
  return Array.isArray(blocks) ? (blocks as ContentBlock[]) : [];
};

interface UseStreamingMessagesReturn {
  // Content refs
  streamingContentRef: React.MutableRefObject<string>;
  isStreamingRef: React.MutableRefObject<boolean>;
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
  buildStreamingBlocks: (existingBlocks: ContentBlock[], patchState?: StreamingPatchState) => ContentBlock[];
  findStreamingAssistantIndex: (list: ClaudeMessage[]) => number;
  patchAssistantForStreaming: (assistant: ClaudeMessage, patchState?: StreamingPatchState) => ClaudeMessage;

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
  const streamingMessageIndexRef = useRef<number>(-1);

  // Text segment refs
  // NOTE: Currently operates in single-element mode — segments[0] always holds the
  // full accumulated text (same value as streamingContentRef.current). The array
  // structure is retained for forward compatibility with future multi-segment support
  // (e.g., text segments separated by tool_use blocks), but callers should not assume
  // actual segmentation semantics today.
  const streamingTextSegmentsRef = useRef<string[]>([]);
  const activeTextSegmentIndexRef = useRef<number>(-1);

  // Thinking segment refs
  // NOTE: Same single-element mode as text segments above. segments[0] holds the
  // full accumulated thinking content. See Decision 3 in design.md — single thinking
  // block per turn until the bridge exposes explicit block lifecycle signals.
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

  /**
   * Build streaming blocks by dispatching to mode-specific module-level functions.
   * Thin wrapper that computes default values from refs when patchState is incomplete.
   * The actual logic lives in `buildSimpleStreamingBlocks` and
   * `buildInterleavedStreamingBlocks` (module level, created once per module load).
   */
  // useCallback: buildStreamingBlocks reads refs (not state), so deps are empty.
  // Prevents reference changes on every render for consumers that may shallow-compare (I1).
  const buildStreamingBlocks = useCallback((existingBlocks: ContentBlock[], patchState?: StreamingPatchState): ContentBlock[] => {
    const canonicalThinking = normalizeStreamingNewlines(
      patchState?.canonicalThinking ?? streamingThinkingSegmentsRef.current.join(''),
    );
    const canonicalText = patchState?.canonicalText ?? streamingContentRef.current;

    // Early exit: arrays with ≤ 2 blocks cannot be interleaved (I2: js-early-exit + js-length-check-first).
    // Interleaving requires at least 3 blocks (e.g. [thinking, tool_use, thinking]).
    if (existingBlocks.length <= 2) {
      return buildSimpleStreamingBlocks(existingBlocks, canonicalText, canonicalThinking);
    }

    // Detect interleaved structure in a strict O(n) single pass using tracking flags
    // instead of nested inner loops (S1: avoids O(n²) worst-case from B1 review).
    let thinkingBlockCount = 0;
    let textBlockCount = 0;
    let hasStableBetweenThinkingBlocks = false;
    let hasStableBetweenTextBlocks = false;
    let sawStableSinceLastThinking = false;
    let sawStableSinceLastText = false;
    let lastThinkingIdx = -1;
    let lastTextIdx = -1;

    for (let i = 0; i < existingBlocks.length; i += 1) {
      const block = existingBlocks[i];
      if (!block || typeof block !== 'object') continue;

      // Check specific streaming types first, then classify everything else as stable.
      // Avoids TypeScript narrowing ContentBlock to `never` after isStableBackendBlock
      // guard (the catch-all StableBackendBlock structurally subsumes StreamingContentBlock).
      if (block.type === 'thinking') {
        thinkingBlockCount += 1;
        if (sawStableSinceLastThinking) hasStableBetweenThinkingBlocks = true;
        sawStableSinceLastThinking = false;
        lastThinkingIdx = i;
      } else if (block.type === 'text') {
        textBlockCount += 1;
        if (sawStableSinceLastText) hasStableBetweenTextBlocks = true;
        sawStableSinceLastText = false;
        lastTextIdx = i;
      } else {
        // Any non-thinking, non-text block is a stable backend block.
        if (lastThinkingIdx >= 0) sawStableSinceLastThinking = true;
        if (lastTextIdx >= 0) sawStableSinceLastText = true;
      }
    }

    const hasInterleavedStructure =
      (thinkingBlockCount > 1 && hasStableBetweenThinkingBlocks) ||
      (textBlockCount > 1 && hasStableBetweenTextBlocks);

    if (hasInterleavedStructure) {
      return buildInterleavedStreamingBlocks(
        existingBlocks, canonicalText, canonicalThinking, lastThinkingIdx, lastTextIdx,
      );
    }

    return buildSimpleStreamingBlocks(existingBlocks, canonicalText, canonicalThinking);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Find the streaming assistant message index in the given list.
   * This is a pure lookup — it does NOT mutate the passed array.
   * Returns -1 if no assistant message is found; callers should handle this
   * via their idx bounds check and return `prev` unchanged.
   *
   * @sideEffect Updates `streamingMessageIndexRef` when the cached index is
   * stale (out-of-range or pointing to a non-assistant slot). This write is
   * idempotent — the same input always produces the same ref value — so it is
   * safe under React StrictMode double-invocation.
   *
   * @param list - Read-only message array (safe to pass React state directly)
   * @returns The index of the assistant message, or -1 if not found
   */
  const findStreamingAssistantIndex = (list: ClaudeMessage[]): number => {
    const currentIdx = streamingMessageIndexRef.current;
    if (currentIdx >= 0 && currentIdx < list.length) {
      const current = list[currentIdx];
      if (
        current?.type === 'assistant' &&
        (
          streamingTurnIdRef.current <= 0 ||
          current.__turnId === streamingTurnIdRef.current
        )
      ) {
        return currentIdx;
      }
    }

    if (streamingTurnIdRef.current > 0) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const message = list[i];
        if (message?.type === 'assistant' && message.__turnId === streamingTurnIdRef.current) {
          streamingMessageIndexRef.current = i;
          return i;
        }
      }
      return -1;
    }

    const lastAssistantIdx = findLastAssistantIndex(list);
    if (lastAssistantIdx >= 0) {
      streamingMessageIndexRef.current = lastAssistantIdx;
      return lastAssistantIdx;
    }
    return -1;
  };

  // Helper: Patch assistant message for streaming
  const patchAssistantForStreaming = (
    assistant: ClaudeMessage,
    patchState?: StreamingPatchState,
  ): ClaudeMessage => {
    const existingRaw = (assistant.raw && typeof assistant.raw === 'object')
      ? (assistant.raw as Record<string, unknown>)
      : { message: { content: [] } } as Record<string, unknown>;
    const existingBlocks: ContentBlock[] = patchState?.existingBlocks ?? extractRawBlocks(existingRaw);
    const canonicalText = patchState?.canonicalText ?? streamingContentRef.current;
    const newBlocks = buildStreamingBlocks(existingBlocks, {
      canonicalText,
      canonicalThinking: patchState?.canonicalThinking,
    });

    const messageField = existingRaw.message as Record<string, unknown> | undefined;
    const rawPatched = messageField
      ? { ...existingRaw, message: { ...messageField, content: newBlocks } }
      : { ...existingRaw, content: newBlocks };

    return {
      ...assistant,
      content: canonicalText,
      raw: rawPatched as ClaudeMessage['raw'],
      isStreaming: true,
    };
  };

  // Reset all streaming state
  const resetStreamingState = () => {
    clearStreamingDataRefs({
      streamingContentRef,
      streamingTextSegmentsRef,
      activeTextSegmentIndexRef,
      streamingThinkingSegmentsRef,
      activeThinkingSegmentIndexRef,
      seenToolUseCountRef,
      streamingMessageIndexRef,
      streamingTurnIdRef,
      autoExpandedThinkingKeysRef,
    });
    lastContentUpdateRef.current = 0;
    lastThinkingUpdateRef.current = 0;

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
    findStreamingAssistantIndex,
    patchAssistantForStreaming,

    // Reset function
    resetStreamingState,
  };
}
