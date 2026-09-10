import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildResetTransientUiState } from './sessionTransition';
import type { ResetTransientUiStateOptions } from './sessionTransition';

describe('buildResetTransientUiState', () => {
  const buildOptions = (
    overrides: Partial<ResetTransientUiStateOptions> = {}
  ): ResetTransientUiStateOptions => ({
    clearToasts: vi.fn(),
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setIsThinking: vi.fn(),
    setStreamingActive: vi.fn(),
    isStreamingRef: { current: true },
    useBackendStreamingRenderRef: { current: true },
    streamingMessageIndexRef: { current: 3 },
    streamingContentRef: { current: 'partial' },
    streamingThinkingRef: { current: 'thinking' },
    autoExpandedThinkingKeysRef: { current: new Set(['k1']) },
    contentUpdateTimeoutRef: { current: null },
    thinkingUpdateTimeoutRef: { current: null },
    streamingTurnIdRef: { current: 7 },
    ...overrides,
  });

  beforeEach(() => {
    window.__streamEndProcessedTurnId = undefined;
    window.__deferredTransitionUpdateMessages = null;
    window.__cancelPendingUpdateMessages = undefined;
  });

  it('drops queued messages as part of the transient reset', () => {
    // The Java-driven clearMessages callback funnels through this reset, so
    // this is the guard that keeps queued messages from firing into a
    // freshly cleared/replaced session.
    const clearQueuedMessages = vi.fn();
    const reset = buildResetTransientUiState(buildOptions({ clearQueuedMessages }));

    reset();

    expect(clearQueuedMessages).toHaveBeenCalledTimes(1);
  });

  it('resets without a queue clearer when the option is absent', () => {
    const reset = buildResetTransientUiState(buildOptions());

    expect(() => {
      reset();
    }).not.toThrow();
  });
});
