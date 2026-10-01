/**
 * messageCallbacks.test.ts
 *
 * Claude history page info routing:
 * - the CLI-derived title is stored even when the page info arrives before the
 *   webview learns its session id (Java-driven auto-restore), because the entry
 *   is keyed by session and re-validated when read;
 * - the pagination cache and the dispatched event stay scoped to the session on
 *   screen, so a stale page info cannot drive the earlier-page loader.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerMessageCallbacks } from './messageCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { StartupHistoryLoadState } from '../../../types/startupHistory';

const ref = <T,>(value: T) => ({ current: value });

interface StoredTitle {
  sessionId: string;
  title: string;
}

function createHarness(currentSessionId: string | null) {
  const storedTitles: Array<StoredTitle | null> = [];
  const startupHistoryUpdates: unknown[] = [];

  const options = {
    addToast: () => {},
    setMessages: () => {},
    setStatus: () => {},
    setLoading: () => {},
    setLoadingStartTime: () => {},
    setIsThinking: () => {},
    setHistoryData: () => {},
    userPausedRef: ref(false),
    isUserAtBottomRef: ref(true),
    messagesContainerRef: ref(null),
    suppressNextStatusToastRef: ref(false),
    streamingContentRef: ref(''),
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    findLastAssistantIndex: () => -1,
    extractRawBlocks: () => [],
    patchAssistantForStreaming: (message: unknown) => message,
    updateContextUsageData: () => {},
    closeContextUsageDialog: () => {},
    currentSessionIdRef: ref(currentSessionId),
    setStartupHistoryLoadState: (updater: unknown) => startupHistoryUpdates.push(updater),
    // Mirrors React's functional-update contract so the no-op identity branch
    // can be asserted through reference equality.
    setRestoredSessionTitle: (updater: unknown) => {
      const prev = storedTitles.length > 0 ? storedTitles[storedTitles.length - 1] : null;
      const next = typeof updater === 'function'
        ? (updater as (previous: StoredTitle | null) => StoredTitle | null)(prev)
        : updater;
      storedTitles.push(next as StoredTitle | null);
    },
  } as unknown as UseWindowCallbacksOptions;

  registerMessageCallbacks(options, () => {}, () => {});
  const dispatch = window.claudeHistoryPageInfo;
  if (!dispatch) throw new Error('claudeHistoryPageInfo was not registered');
  return { storedTitles, startupHistoryUpdates, dispatch };
}

const pageInfo = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  sessionId: 's1',
  fromTurn: 0,
  totalTurns: 4,
  hasMore: true,
  cursorReset: false,
  sessionTitle: 'CLI title',
  ...overrides,
});

describe('claudeHistoryPageInfo', () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__claudeHistoryPageInfo;
    delete (window as unknown as Record<string, unknown>).__pendingStartupHistoryLoadState;
    delete (window as unknown as Record<string, unknown>).updateStartupHistoryLoadState;
  });

  it('drains a startup history state received before callbacks are registered', () => {
    const pending: StartupHistoryLoadState = {
      status: 'unloaded',
      sessionId: 's1',
      requestId: '',
      generation: 1,
      messageCount: 0,
      retryable: true,
    };
    window.__pendingStartupHistoryLoadState = JSON.stringify(pending);

    const harness = createHarness('s1');

    expect(window.__pendingStartupHistoryLoadState).toBeUndefined();
    expect(harness.startupHistoryUpdates).toHaveLength(1);
    const update = harness.startupHistoryUpdates[0] as (
      previous: StartupHistoryLoadState | null
    ) => StartupHistoryLoadState | null;
    expect(update(null)).toEqual(pending);
  });

  it('stores the CLI title even when the session id is not synced yet', () => {
    const harness = createHarness(null);
    harness.dispatch(pageInfo());

    expect(harness.storedTitles.at(-1)).toEqual({ sessionId: 's1', title: 'CLI title' });
    // Pagination state still waits for the session to be on screen.
    expect(window.__claudeHistoryPageInfo).toBeUndefined();
  });

  it('caches pagination state and notifies listeners for the on-screen session', () => {
    const harness = createHarness('s1');
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener('claude-history-page-info', listener);
    harness.dispatch(pageInfo({ fromTurn: 2, totalTurns: 8 }));
    window.removeEventListener('claude-history-page-info', listener);

    expect(harness.storedTitles.at(-1)).toEqual({ sessionId: 's1', title: 'CLI title' });
    expect(window.__claudeHistoryPageInfo?.sessionId).toBe('s1');
    expect(seen).toHaveLength(1);
  });

  it('keeps the stored title stable when an earlier page repeats the same title', () => {
    const harness = createHarness('s1');
    harness.dispatch(pageInfo());
    const first = harness.storedTitles.at(-1);
    harness.dispatch(pageInfo({ fromTurn: 0, toTurn: 2, totalTurns: 8 }));
    const second = harness.storedTitles.at(-1);

    // Same session and title must keep the previous object so SessionContext
    // consumers do not re-render on every earlier-page load.
    expect(second).toBe(first);
  });

  it('drops pagination state for a session that is not on screen', () => {
    const harness = createHarness('other');
    harness.dispatch(pageInfo({ hasMore: false }));
    expect(window.__claudeHistoryPageInfo).toBeUndefined();
  });
});
