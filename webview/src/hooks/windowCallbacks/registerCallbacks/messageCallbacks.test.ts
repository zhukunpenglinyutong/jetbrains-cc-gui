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
import type { ClaudeMessage } from '../../../types';

const ref = <T,>(value: T) => ({ current: value });

interface StoredTitle {
  sessionId: string;
  title: string;
}

function createHarness(currentSessionId: string | null) {
  const storedTitles: Array<StoredTitle | null> = [];
  const startupHistoryUpdates: unknown[] = [];
  let messages: ClaudeMessage[] = [];
  const isStreaming = ref(false);

  const options = {
    addToast: () => {},
    setMessages: (updater: ClaudeMessage[] | ((previous: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    },
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
    isStreamingRef: isStreaming,
    useBackendStreamingRenderRef: ref(false),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    turnIdCounterRef: ref(0),
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
  return { storedTitles, startupHistoryUpdates, dispatch, getMessages: () => messages, isStreaming };
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

  it.each(['unloaded', 'loading', 'failed'] as const)('keeps committed history when a same-generation %s arrives', status => {
    const harness = createHarness('s1');
    const committed: StartupHistoryLoadState = {
      status: 'loaded', sessionId: 's1', requestId: 'completed', generation: 2, messageCount: 5, retryable: false,
    };
    window.updateStartupHistoryLoadState?.(JSON.stringify({ ...committed, status, retryable: true }));
    const update = harness.startupHistoryUpdates[0] as (previous: StartupHistoryLoadState | null) => StartupHistoryLoadState | null;
    expect(update(committed)).toBe(committed);
  });

  it('stores the CLI title even when the session id is not synced yet', () => {
    const harness = createHarness(null);
    harness.dispatch(pageInfo());

    expect(harness.storedTitles.at(-1)).toEqual({ sessionId: 's1', title: 'CLI title' });
    // Pagination state still waits for the session to be on screen.
    expect(window.__claudeHistoryPageInfo).toBeUndefined();
  });

  it('keeps manual loading and its cancel action when activation republishes unloaded in the same generation', () => {
    const harness = createHarness('s1');
    const loading: StartupHistoryLoadState = {
      status: 'loading', sessionId: 's1', requestId: 'manual', generation: 2, messageCount: 0, retryable: false,
    };
    window.updateStartupHistoryLoadState?.(JSON.stringify({ ...loading, status: 'unloaded', requestId: '', retryable: true }));
    const update = harness.startupHistoryUpdates[0] as (previous: StartupHistoryLoadState | null) => StartupHistoryLoadState | null;
    expect(update(loading)).toBe(loading);
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

describe('native Codex opaque history pages', () => {
  it('restores the native thread name when the history page commits', () => {
    const harness = createHarness('s1');
    window.beginCodexHistoryPage?.(JSON.stringify({ pageId: 'named', sessionId: 's1', mode: 'replace' }));
    window.completeCodexHistoryPage?.(JSON.stringify({ pageId: 'named', sessionId: 's1', mode: 'replace', source: 'native',
      sessionTitle: 'Saved native title', cursor: null, hasMore: false, loadedMessageCount: 0 }));
    expect(harness.storedTitles.at(-1)).toEqual({ sessionId: 's1', title: 'Saved native title' });
  });
  it('merges overlap by identity and refuses a response for an obsolete cursor', () => {
    const harness = createHarness('s1');
    const row = (uuid: string): ClaudeMessage => ({ type: 'user', content: 'same text', raw: { uuid } });
    const deliver = (pageId: string, mode: 'replace' | 'prepend', ids: string[], requestCursor: string | null, cursor: string | null) => {
      window.beginCodexHistoryPage?.(JSON.stringify({ pageId, sessionId: 's1', mode }));
      window.appendCodexHistoryPageBatch?.(pageId, JSON.stringify(ids.map(row)));
      window.completeCodexHistoryPage?.(JSON.stringify({ pageId, sessionId: 's1', mode, source: 'native',
        requestCursor, cursor, hasMore: cursor !== null, fromTurn: 0, toTurn: 0, totalTurns: 0, loadedMessageCount: ids.length }));
    };
    deliver('first', 'replace', ['two', 'three'], null, 'opaque:next');
    deliver('old', 'prepend', ['one', 'two'], 'opaque:next', 'opaque:older');
    expect(harness.getMessages().map((message) => typeof message.raw === 'object' ? message.raw?.uuid : null)).toEqual(['one', 'two', 'three']);
    deliver('stale', 'prepend', ['stale'], 'opaque:next', null);
    expect(harness.getMessages()).toHaveLength(3);
    expect(window.__codexHistoryPageInfo?.cursor).toBe('opaque:older');
  });
});

describe('onInterTurnMessage', () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__sessionTransitioning;
    delete (window as unknown as Record<string, unknown>).onInterTurnMessage;
  });

  const followUpPayload = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    sessionId: 's1',
    message: {
      type: 'assistant',
      uuid: 'follow-up-uuid',
      timestamp: '2026-11-10T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Task report' }] },
    },
    ...overrides,
  });

  it('appends the follow-up assistant body with a fresh turn id tag', () => {
    const harness = createHarness('s1');
    window.onInterTurnMessage?.(followUpPayload());
    const messages = harness.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('assistant');
    expect(messages[0].content).toBe('Task report');
    // The tag is load-bearing: preserveLatestMessagesOnShrink only keeps a tail
    // assistant that carries isStreaming or __turnId, and it also stops the
    // follow-up report from merging into the previous turn's bubble.
    expect(messages[0].__turnId).toBe(1);
    expect(typeof messages[0].raw === 'object' && (messages[0].raw as { uuid?: string }).uuid).toBe('follow-up-uuid');
  });

  it('drops the event when its session is not the displayed session', () => {
    const harness = createHarness('other-session');
    window.onInterTurnMessage?.(followUpPayload());
    expect(harness.getMessages()).toHaveLength(0);
  });

  it('drops the event while a turn is streaming', () => {
    const harness = createHarness('s1');
    harness.isStreaming.current = true;
    window.onInterTurnMessage?.(followUpPayload());
    expect(harness.getMessages()).toHaveLength(0);
  });

  it('drops the event during a session transition', () => {
    const harness = createHarness('s1');
    (window as unknown as Record<string, unknown>).__sessionTransitioning = true;
    window.onInterTurnMessage?.(followUpPayload());
    expect(harness.getMessages()).toHaveLength(0);
  });

  it('converges duplicate deliveries to one bubble via the raw uuid', () => {
    const harness = createHarness('s1');
    window.onInterTurnMessage?.(followUpPayload());
    window.onInterTurnMessage?.(followUpPayload());
    expect(harness.getMessages()).toHaveLength(1);
  });

  it('ignores malformed payloads', () => {
    const harness = createHarness('s1');
    expect(() => window.onInterTurnMessage?.('not json')).not.toThrow();
    expect(harness.getMessages()).toHaveLength(0);
  });
});

describe('onInterTurnMessage increment folding', () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__sessionTransitioning;
  });

  const increment = (uuid: string, msgId: string, blocks: unknown[]) => JSON.stringify({
    sessionId: 's1',
    message: {
      type: 'assistant',
      uuid,
      message: { id: msgId, role: 'assistant', content: blocks },
    },
  });

  it('folds increments sharing one message id into a single bubble', () => {
    // The CLI emits one assistant record per content block while a follow-up
    // turn streams, so the live forward arrives as several increments with a
    // shared message.id. They must converge to one bubble, not one per block.
    const harness = createHarness('s1');
    window.onInterTurnMessage?.(increment('u1', 'msg-1', [{ type: 'thinking', thinking: 'planning' }]));
    window.onInterTurnMessage?.(increment('u2', 'msg-1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    window.onInterTurnMessage?.(increment('u3', 'msg-1', [{ type: 'text', text: 'report' }]));

    const messages = harness.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('report');
    const blocks = (messages[0].raw as { message: { content: Array<{ type: string }> } }).message.content;
    expect(blocks.map((block) => block.type)).toEqual(['thinking', 'tool_use', 'text']);
  });

  it('keeps distinct message ids as separate bubbles', () => {
    const harness = createHarness('s1');
    window.onInterTurnMessage?.(increment('u1', 'msg-a', [{ type: 'text', text: 'first' }]));
    window.onInterTurnMessage?.(increment('u2', 'msg-b', [{ type: 'text', text: 'second' }]));

    const messages = harness.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.content)).toEqual(['first', 'second']);
  });

  it('does not duplicate a replayed block on the same message', () => {
    const harness = createHarness('s1');
    window.onInterTurnMessage?.(increment('u1', 'msg-c', [{ type: 'text', text: 'same' }]));
    window.onInterTurnMessage?.(increment('u2', 'msg-c', [{ type: 'text', text: 'same' }]));

    const messages = harness.getMessages();
    expect(messages).toHaveLength(1);
    const blocks = (messages[0].raw as { message: { content: unknown[] } }).message.content;
    expect(blocks).toHaveLength(1);
  });
});
