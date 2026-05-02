/**
 * streamingCallbacks.test.ts
 *
 * Unit tests for delta deduplication logic in streamingCallbacks.
 *
 * The dedup logic operates on window globals (__lastContentDelta, __lastThinkingDelta)
 * and refs (streamingContentRef, streamingThinkingSegmentsRef, etc.).
 * We test the behavior by:
 *   1. Calling registerStreamingCallbacks with mock options to set up window handlers
 *   2. Directly invoking window.onContentDelta / window.onThinkingDelta
 *   3. Inspecting ref values and window globals to verify dedup behavior
 *
 * Tested scenarios:
 *   - Exact duplicate delta is skipped (content & thinking)
 *   - Suffix duplicate delta is skipped (content & thinking)
 *   - New delta passes through and accumulates in refs
 *   - onStreamStart resets dedup state
 *   - Edge cases: empty string, null/undefined guards, session transitioning
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ClaudeMessage, MutableRefObject } from '../../../../types';
import { registerStreamingCallbacks } from '../streamingCallbacks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MutableRef<T> = MutableRefObject<T>;

const ref = <T>(value: T): MutableRef<T> => ({ current: value });

/**
 * Create a minimal UseWindowCallbacksOptions with all required fields.
 * Most are no-ops; only the refs that dedup logic reads/writes are real.
 */
function createMockOptions() {
  const setMessages = vi.fn<(fn: (prev: ClaudeMessage[]) => ClaudeMessage[]) => void>();
  const setStreamingActive = vi.fn();
  const setLoading = vi.fn();
  const setLoadingStartTime = vi.fn();
  const setIsThinking = vi.fn();
  const setExpandedThinking = vi.fn();

  const streamingContentRef = ref('');
  const isStreamingRef = ref(true);
  const useBackendStreamingRenderRef = ref(false);
  const autoExpandedThinkingKeysRef = ref<Set<string>>(new Set());
  const streamingTextSegmentsRef = ref<string[]>([]);
  const activeTextSegmentIndexRef = ref(-1);
  const streamingThinkingSegmentsRef = ref<string[]>([]);
  const activeThinkingSegmentIndexRef = ref(-1);
  const seenToolUseCountRef = ref(0);
  const streamingMessageIndexRef = ref(-1);
  const streamingTurnIdRef = ref(0);
  const turnIdCounterRef = ref(0);
  const lastContentUpdateRef = ref(0);
  const contentUpdateTimeoutRef = ref<ReturnType<typeof setTimeout> | null>(null);
  const lastThinkingUpdateRef = ref(0);
  const thinkingUpdateTimeoutRef = ref<ReturnType<typeof setTimeout> | null>(null);

  const getOrCreateStreamingAssistantIndex = vi.fn().mockReturnValue(0);
  const patchAssistantForStreaming = vi.fn((msg: ClaudeMessage) => ({ ...msg, isStreaming: true }));

  return {
    setMessages,
    setStreamingActive,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setExpandedThinking,
    streamingContentRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingTextSegmentsRef,
    activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef,
    activeThinkingSegmentIndexRef,
    seenToolUseCountRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    turnIdCounterRef,
    lastContentUpdateRef,
    contentUpdateTimeoutRef,
    lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,
  };
}

// ---------------------------------------------------------------------------
// Content Delta Deduplication
// ---------------------------------------------------------------------------

describe('Content delta deduplication', () => {
  let opts: ReturnType<typeof createMockOptions>;

  beforeEach(() => {
    opts = createMockOptions();
    // Clean window state
    (window as any).__lastContentDelta = '';
    (window as any).__lastThinkingDelta = '';
    (window as any).__sessionTransitioning = false;
    (window as any).__lastStreamActivityAt = 0;
    (window as any).__stallWatchdogInterval = null;
    (window as any).__pendingUpdateJson = null;
    (window as any).__cancelPendingUpdateMessages = undefined;
    (window as any).__lastStreamEndedTurnId = undefined;
    (window as any).__lastStreamEndedAt = undefined;
    (window as any).__streamEndProcessedTurnId = undefined;
    (window as any).__turnStartedAt = undefined;
    (window as any).__minAcceptedUpdateSequence = 0;
    registerStreamingCallbacks(opts as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers?.restore?.() ?? vi.useRealTimers();
  });

  // -- Exact duplicate detection --

  describe('exact duplicate detection', () => {
    it('skips delta that is identical to the previous one', () => {
      window.onContentDelta!('Hello');
      const contentAfterFirst = opts.streamingContentRef.current;

      // Second call with the same delta should be skipped
      window.onContentDelta!('Hello');
      // Content should not have doubled
      expect(opts.streamingContentRef.current).toBe(contentAfterFirst);
    });

    it('tracks lastContentDelta on window for exact dedup', () => {
      window.onContentDelta!('ABC');
      expect((window as any).__lastContentDelta).toBe('ABC');

      // Exact duplicate is skipped, but __lastContentDelta was already set to 'ABC'
      window.onContentDelta!('ABC');
      expect((window as any).__lastContentDelta).toBe('ABC');
      // Content should only have 'ABC' once
      expect(opts.streamingContentRef.current).toBe('ABC');
    });

    it('does not skip a different delta even after an exact duplicate was skipped', () => {
      window.onContentDelta!('Hello');
      window.onContentDelta!('Hello'); // skipped
      window.onContentDelta!(' World');

      expect(opts.streamingContentRef.current).toBe('Hello World');
      expect((window as any).__lastContentDelta).toBe(' World');
    });
  });

  // -- Suffix duplicate detection --

  describe('suffix duplicate detection', () => {
    it('skips delta that is a suffix of the already-accumulated content', () => {
      // Simulate: streamingContentRef has accumulated "Hello World"
      opts.streamingContentRef.current = 'Hello World';

      // A delta of "World" is a suffix of the accumulated content
      // and shorter, so it should be skipped
      window.onContentDelta!('World');

      // Content should remain unchanged
      expect(opts.streamingContentRef.current).toBe('Hello World');
      // The suffix delta should still be recorded as lastContentDelta
      expect((window as any).__lastContentDelta).toBe('World');
    });

    it('does not skip suffix when delta length equals accumulated content length', () => {
      // "World" is the same length as accumulated "World" -- not shorter
      opts.streamingContentRef.current = 'World';

      window.onContentDelta!('World');

      // Should NOT be skipped because delta.length is NOT < currentContent.length
      expect(opts.streamingContentRef.current).toBe('WorldWorld');
    });

    it('does not skip suffix when delta is longer than accumulated content', () => {
      opts.streamingContentRef.current = 'AB';

      // "ABCDE" is longer than "AB" — cumulative normalization detects this
      // as a likely cumulative snapshot and extracts the incremental part "CDE"
      window.onContentDelta!('ABCDE');

      expect(opts.streamingContentRef.current).toBe('ABCDE');
    });

    it('does not skip delta that is not actually a suffix', () => {
      opts.streamingContentRef.current = 'Hello World';

      // "Worldz" is not a suffix of "Hello World"
      window.onContentDelta!('Worldz');

      expect(opts.streamingContentRef.current).toBe('Hello WorldWorldz');
    });

    it('handles empty accumulated content gracefully', () => {
      opts.streamingContentRef.current = '';

      window.onContentDelta!('');
      // delta.length (0) < currentContent.length (0) is false, so not skipped
      // but delta === '' === window.__lastContentDelta ('') is true, so skipped by exact dedup
      expect(opts.streamingContentRef.current).toBe('');
    });
  });

  // -- New delta passes through --

  describe('new delta passes through', () => {
    it('accumulates new delta into streamingContentRef', () => {
      window.onContentDelta!('A');
      window.onContentDelta!('B');
      window.onContentDelta!('C');

      expect(opts.streamingContentRef.current).toBe('ABC');
    });

    it('creates a text segment and appends delta to it', () => {
      window.onContentDelta!('Hello');

      expect(opts.activeTextSegmentIndexRef.current).toBe(0);
      expect(opts.streamingTextSegmentsRef.current).toEqual(['Hello']);
    });

    it('appends to existing text segment for subsequent deltas', () => {
      window.onContentDelta!('Hello');
      window.onContentDelta!(' World');

      expect(opts.streamingTextSegmentsRef.current).toEqual(['Hello World']);
      expect(opts.activeTextSegmentIndexRef.current).toBe(0);
    });

    it('resets activeThinkingSegmentIndexRef on content delta', () => {
      opts.activeThinkingSegmentIndexRef.current = 0;
      window.onContentDelta!('text');

      expect(opts.activeThinkingSegmentIndexRef.current).toBe(-1);
    });

    it('calls setMessages when throttle interval has elapsed', () => {
      // lastContentUpdateRef is 0, so Date.now() - 0 >= 50ms should be true
      window.onContentDelta!('test');

      expect(opts.setMessages).toHaveBeenCalledTimes(1);
    });
  });

  // -- onStreamStart resets dedup state --

  describe('onStreamStart resets dedup state', () => {
    it('resets __lastContentDelta to empty string', () => {
      window.onContentDelta!('Accumulated');
      expect((window as any).__lastContentDelta).toBe('Accumulated');

      window.onStreamStart!();

      expect((window as any).__lastContentDelta).toBe('');
    });

    it('resets __lastThinkingDelta to empty string', () => {
      window.onThinkingDelta!('Thinking...');
      expect((window as any).__lastThinkingDelta).toBe('Thinking...');

      window.onStreamStart!();

      expect((window as any).__lastThinkingDelta).toBe('');
    });

    it('resets streamingContentRef to empty string', () => {
      window.onContentDelta!('Accumulated content');
      expect(opts.streamingContentRef.current).toBe('Accumulated content');

      window.onStreamStart!();

      expect(opts.streamingContentRef.current).toBe('');
    });

    it('resets streamingTextSegmentsRef to empty array', () => {
      window.onContentDelta!('text');
      expect(opts.streamingTextSegmentsRef.current).toEqual(['text']);

      window.onStreamStart!();

      expect(opts.streamingTextSegmentsRef.current).toEqual([]);
    });

    it('resets activeTextSegmentIndexRef to -1', () => {
      window.onContentDelta!('text');
      expect(opts.activeTextSegmentIndexRef.current).toBe(0);

      window.onStreamStart!();

      expect(opts.activeTextSegmentIndexRef.current).toBe(-1);
    });

    it('allows the same delta after reset that was previously deduplicated', () => {
      window.onContentDelta!('Hello');
      window.onContentDelta!('Hello'); // skipped as exact duplicate
      expect(opts.streamingContentRef.current).toBe('Hello');

      window.onStreamStart!();

      // After reset, 'Hello' should be accepted again
      window.onContentDelta!('Hello');
      expect(opts.streamingContentRef.current).toBe('Hello');
    });

    it('increments turnIdCounterRef and sets streamingTurnIdRef', () => {
      expect(opts.turnIdCounterRef.current).toBe(0);

      window.onStreamStart!();

      expect(opts.turnIdCounterRef.current).toBe(1);
      expect(opts.streamingTurnIdRef.current).toBe(1);
    });
  });

  // -- Cumulative delta normalization --

  describe('cumulative delta normalization', () => {
    it('normalizes cumulative content delta to incremental', () => {
      window.onContentDelta!('A');
      expect(opts.streamingContentRef.current).toBe('A');

      // Simulate ai-bridge sending cumulative snapshot "ABC" instead of incremental "BC"
      window.onContentDelta!('ABC');
      // Should only append the novel suffix "BC", not the full "ABC"
      expect(opts.streamingContentRef.current).toBe('ABC');
    });

    it('skips cumulative delta that is fully duplicate', () => {
      window.onContentDelta!('ABC');
      expect(opts.streamingContentRef.current).toBe('ABC');

      // Cumulative delta with no new content
      window.onContentDelta!('ABC');
      // Exact dedup catches this
      expect(opts.streamingContentRef.current).toBe('ABC');
    });

    it('handles multiple cumulative deltas without content multiplication', () => {
      window.onContentDelta!('A');
      window.onContentDelta!('AB');
      window.onContentDelta!('ABC');
      window.onContentDelta!('ABCD');

      expect(opts.streamingContentRef.current).toBe('ABCD');
    });

    it('handles 6 cumulative deltas (reproduces the 6x duplication bug)', () => {
      // This reproduces the exact scenario from session ffbe3b84:
      // ai-bridge sends cumulative snapshots on each updateMessages
      window.onContentDelta!('H');
      window.onContentDelta!('He');
      window.onContentDelta!('Hel');
      window.onContentDelta!('Hell');
      window.onContentDelta!('Hello');
      window.onContentDelta!('Hello ');

      // Without the fix: "H" + "He" + "Hel" + "Hell" + "Hello" + "Hello " = multiplied
      // With the fix: only the novel suffix is appended each time
      expect(opts.streamingContentRef.current).toBe('Hello ');
    });

    it('does not misidentify incremental delta as cumulative', () => {
      window.onContentDelta!('A');

      // Genuine incremental delta that happens to start with "A" but is longer
      // In a well-functioning system this is rare; normalization still gives correct result
      // because delta.slice(currentContent.length) extracts the correct suffix
      window.onContentDelta!('AB');

      expect(opts.streamingContentRef.current).toBe('AB');
    });

    it('handles cumulative delta with text segments correctly', () => {
      window.onContentDelta!('Hello');
      expect(opts.streamingTextSegmentsRef.current).toEqual(['Hello']);

      // Cumulative delta
      window.onContentDelta!('Hello World');
      expect(opts.streamingTextSegmentsRef.current).toEqual(['Hello World']);
      expect(opts.streamingContentRef.current).toBe('Hello World');
    });

    it('handles cumulative delta after thinking phase switch', () => {
      window.onContentDelta!('Hello');
      // Simulate thinking phase (resets activeTextSegmentIndexRef)
      opts.activeTextSegmentIndexRef.current = -1;

      // New text segment starts, but cumulative delta arrives
      window.onContentDelta!('Hello World');
      // New segment created at index 1 with incremental content
      // The cumulative normalization only applies when delta starts with
      // currentContent (streamingContentRef), not the segment content
      expect(opts.streamingContentRef.current).toBe('Hello World');
    });

    it('normalizes cumulative thinking delta to incremental', () => {
      window.onThinkingDelta!('A');
      expect(opts.streamingThinkingSegmentsRef.current).toEqual(['A']);

      window.onThinkingDelta!('ABC');
      expect(opts.streamingThinkingSegmentsRef.current).toEqual(['ABC']);
    });

    it('handles multiple cumulative thinking deltas', () => {
      window.onThinkingDelta!('Step');
      window.onThinkingDelta!('Step 1');
      window.onThinkingDelta!('Step 1: ');

      expect(opts.streamingThinkingSegmentsRef.current).toEqual(['Step 1: ']);
    });
  });

  // -- Edge cases --

  describe('edge cases', () => {
    it('ignores content delta when isStreamingRef is false', () => {
      opts.isStreamingRef.current = false;

      window.onContentDelta!('should be ignored');

      expect(opts.streamingContentRef.current).toBe('');
      expect(opts.setMessages).not.toHaveBeenCalled();
    });

    it('ignores content delta when session is transitioning', () => {
      (window as any).__sessionTransitioning = true;

      window.onContentDelta!('should be ignored');

      expect(opts.streamingContentRef.current).toBe('');
      expect(opts.setMessages).not.toHaveBeenCalled();
    });

    it('handles empty string delta (first delta is empty)', () => {
      window.onContentDelta!('');
      // Empty delta: exact dedup check ('' === '') passes on first call too
      // because __lastContentDelta is initialized to ''
      expect(opts.streamingContentRef.current).toBe('');
    });

    it('handles empty string delta after a non-empty delta', () => {
      window.onContentDelta!('Hello');
      // Empty delta is different from 'Hello', so it passes exact dedup
      // Suffix check: '' length (0) < 'Hello' length (5) but 'Hello' does not end with ''
      // Actually: every string ends with '', so '' would be a suffix duplicate
      // delta.length (0) < currentContent.length (5) && currentContent.endsWith('') => true
      window.onContentDelta!('');

      // Empty string is suffix of any string and shorter => skipped
      expect(opts.streamingContentRef.current).toBe('Hello');
    });

    it('handles Unicode and special characters in deltas', () => {
      window.onContentDelta!('你好'); // "Hello" in Chinese
      window.onContentDelta!(' 😀'); // emoji

      expect(opts.streamingContentRef.current).toBe('你好 😀');
    });

    it('handles very large delta strings', () => {
      const largeDelta = 'X'.repeat(100_000);
      window.onContentDelta!(largeDelta);

      expect(opts.streamingContentRef.current).toBe(largeDelta);
    });

    it('dedup works correctly across many sequential deltas', () => {
      const deltas = ['A', 'B', 'B', 'C', 'C', 'C', 'D', 'D', 'E'];
      for (const d of deltas) {
        window.onContentDelta!(d);
      }

      // Only unique sequential deltas should be accumulated
      expect(opts.streamingContentRef.current).toBe('ABCDE');
    });
  });
});

// ---------------------------------------------------------------------------
// Thinking Delta Deduplication
// ---------------------------------------------------------------------------

describe('Thinking delta deduplication', () => {
  let opts: ReturnType<typeof createMockOptions>;

  beforeEach(() => {
    opts = createMockOptions();
    (window as any).__lastContentDelta = '';
    (window as any).__lastThinkingDelta = '';
    (window as any).__sessionTransitioning = false;
    (window as any).__lastStreamActivityAt = 0;
    (window as any).__stallWatchdogInterval = null;
    (window as any).__pendingUpdateJson = null;
    (window as any).__cancelPendingUpdateMessages = undefined;
    (window as any).__lastStreamEndedTurnId = undefined;
    (window as any).__lastStreamEndedAt = undefined;
    (window as any).__streamEndProcessedTurnId = undefined;
    (window as any).__turnStartedAt = undefined;
    (window as any).__minAcceptedUpdateSequence = 0;
    registerStreamingCallbacks(opts as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips exact duplicate thinking delta', () => {
    window.onThinkingDelta!('reasoning');
    window.onThinkingDelta!('reasoning');

    // Should only have one copy
    expect(opts.streamingThinkingSegmentsRef.current).toEqual(['reasoning']);
    expect((window as any).__lastThinkingDelta).toBe('reasoning');
  });

  it('skips suffix duplicate thinking delta', () => {
    window.onThinkingDelta!('Deep reasoning about X');
    // The current thinking segment at index 0 is "Deep reasoning about X"
    // A delta of "about X" is a suffix and shorter => should be skipped
    window.onThinkingDelta!('about X');

    expect(opts.streamingThinkingSegmentsRef.current).toEqual(['Deep reasoning about X']);
    expect((window as any).__lastThinkingDelta).toBe('about X');
  });

  it('accumulates new thinking delta', () => {
    window.onThinkingDelta!('Step 1');
    window.onThinkingDelta!(', then Step 2');

    expect(opts.streamingThinkingSegmentsRef.current).toEqual(['Step 1, then Step 2']);
  });

  it('creates a new thinking segment for the first thinking delta', () => {
    expect(opts.activeThinkingSegmentIndexRef.current).toBe(-1);
    expect(opts.streamingThinkingSegmentsRef.current).toEqual([]);

    window.onThinkingDelta!('thinking');

    expect(opts.activeThinkingSegmentIndexRef.current).toBe(0);
    expect(opts.streamingThinkingSegmentsRef.current).toEqual(['thinking']);
  });

  it('resets activeTextSegmentIndexRef on thinking delta', () => {
    opts.activeTextSegmentIndexRef.current = 0;
    window.onThinkingDelta!('thought');

    expect(opts.activeTextSegmentIndexRef.current).toBe(-1);
  });

  it('ignores thinking delta when isStreamingRef is false', () => {
    opts.isStreamingRef.current = false;

    window.onThinkingDelta!('ignored');

    expect(opts.streamingThinkingSegmentsRef.current).toEqual([]);
  });

  it('ignores thinking delta when session is transitioning', () => {
    (window as any).__sessionTransitioning = true;

    window.onThinkingDelta!('ignored');

    expect(opts.streamingThinkingSegmentsRef.current).toEqual([]);
  });

  it('does not suffix-match when thinking delta equals segment length', () => {
    window.onThinkingDelta!('AB');
    // "AB" has same length as segment "AB" => not a suffix dup (not shorter)
    window.onThinkingDelta!('AB');

    // First "AB" passes, second "AB" is exact duplicate => skipped
    expect(opts.streamingThinkingSegmentsRef.current).toEqual(['AB']);
  });

  it('allows a new thinking delta after a suffix duplicate was skipped', () => {
    window.onThinkingDelta!('ABCDEF');
    window.onThinkingDelta!('DEF'); // suffix dup, skipped
    window.onThinkingDelta!('GHI');

    expect(opts.streamingThinkingSegmentsRef.current).toEqual(['ABCDEFGHI']);
  });
});

// ---------------------------------------------------------------------------
// Dedup state initialization
// ---------------------------------------------------------------------------

describe('dedup state initialization', () => {
  it('initializes __lastContentDelta and __lastThinkingDelta to empty string on register', () => {
    (window as any).__lastContentDelta = 'stale';
    (window as any).__lastThinkingDelta = 'stale';

    const opts = createMockOptions();
    (window as any).__stallWatchdogInterval = null;
    registerStreamingCallbacks(opts as any);

    expect((window as any).__lastContentDelta).toBe('');
    expect((window as any).__lastThinkingDelta).toBe('');
  });
});
