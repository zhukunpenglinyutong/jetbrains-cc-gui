import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeMessage } from '../../../types';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { clearPendingStreamStart, isPendingStreamStartActive, markPendingStreamStart } from '../../../utils/streamLifecycle';
import { registerMessageCallbacks } from './messageCallbacks';
import { registerStreamingCallbacks } from './streamingCallbacks';

const ref = <T,>(current: T) => ({ current });
const user = (id: string): ClaudeMessage => ({
  type: 'user', content: id, timestamp: '2026-10-04T15:01:00Z', raw: { clientMessageId: id },
});
const error: ClaudeMessage = {
  type: 'error', content: 'thread already has an active writer', timestamp: '2026-10-04T15:01:01Z',
};

function createHarness() {
  let messages: ClaudeMessage[] = [];
  let loading = false;
  const options = {
    currentProviderRef: ref('codex'), currentSessionIdRef: ref('thread'),
    streamingContentRef: ref(''), streamingThinkingRef: ref(''), isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false), streamingMessageIndexRef: ref(-1), streamingTurnIdRef: ref(-1),
    turnIdCounterRef: ref(0), autoExpandedThinkingKeysRef: ref(new Set()),
    lastContentUpdateRef: ref(0), lastThinkingUpdateRef: ref(0),
    contentUpdateTimeoutRef: ref(null), thinkingUpdateTimeoutRef: ref(null),
    setMessages: (next: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next;
    },
    setLoading: (next: boolean | ((prev: boolean) => boolean)) => {
      loading = typeof next === 'function' ? next(loading) : next;
    },
    findLastAssistantIndex: (list: ClaudeMessage[]) => list.reduce((last, message, index) => message.type === 'assistant' ? index : last, -1),
    extractRawBlocks: () => [], patchAssistantForStreaming: (message: ClaudeMessage) => message,
    getOrCreateStreamingAssistantIndex: () => -1,
    setStreamingActive: vi.fn(), setLoadingStartTime: vi.fn(), setIsThinking: vi.fn(), setExpandedThinking: vi.fn(),
    addToast: vi.fn(), setStatus: vi.fn(), setHistoryData: vi.fn(),
    suppressNextStatusToastRef: ref(false),
  } as unknown as UseWindowCallbacksOptions;
  registerMessageCallbacks(options, vi.fn(), vi.fn());
  registerStreamingCallbacks(options);
  return { options, getMessages: () => messages, isLoading: () => loading };
}

describe('Codex startup errors across full and tail transports', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPendingStreamStart();
    window.__sessionTransitioning = false;
    window.__minAcceptedUpdateSequence = 0;
    window.__messageBaseIndex = 0;
    window.__prependedHistoryMessageCount = 0;
  });
  afterEach(() => {
    window.__cancelPendingUpdateMessages?.();
    if (window.__stallWatchdogInterval != null) clearInterval(window.__stallWatchdogInterval);
    clearPendingStreamStart();
    vi.useRealTimers();
  });

  it('ends startup waiting when Java transports the current user and error as a tail', () => {
    const state = createHarness();
    window.updateMessages!(JSON.stringify([user('previous')]), 1);
    markPendingStreamStart('current');
    window.showLoading!('true');
    window.onStreamEnd!();
    window.showLoading!('false');
    window.updateMessageTail!(JSON.stringify([user('current'), error]), 1, 2);
    expect(state.getMessages().at(-1)).toMatchObject({ type: 'error' });
    expect(state.isLoading()).toBe(false);
    expect(window.__pendingStreamClientMessageId).toBeUndefined();
  });

  it('ends startup waiting when Java tags an error-only tail with the failed submission identity', () => {
    const state = createHarness();
    markPendingStreamStart('current');
    window.showLoading!('true');
    window.updateMessages!(JSON.stringify([user('previous'), user('current')]), 1);
    window.onStreamEnd!();
    window.showLoading!('false');
    window.updateMessageTail!(JSON.stringify([{ ...error, raw: { clientMessageId: 'current' } }]), 2, 2);
    expect(state.getMessages().at(-1)).toMatchObject({ type: 'error' });
    expect(state.isLoading()).toBe(false);
  });

  it('does not lose the only loading reset when an owned full error arrives after startup immunity expires', () => {
    const state = createHarness();
    markPendingStreamStart('current');
    window.showLoading!('true');
    window.showLoading!('false');
    vi.advanceTimersByTime(8001);
    expect(isPendingStreamStartActive()).toBe(false);
    expect(window.__pendingStreamClientMessageId).toBe('current');
    window.updateMessages!(JSON.stringify([user('current'), error]), 1);
    expect(state.getMessages().at(-1)).toMatchObject({ type: 'error' });
    expect(state.isLoading()).toBe(false);
  });

  it('keeps a newer submission waiting when an old tail arrives before its user was accepted', () => {
    const state = createHarness();
    window.updateMessages!(JSON.stringify([user('previous')]), 1);
    markPendingStreamStart('current');
    window.showLoading!('true');
    window.updateMessageTail!(JSON.stringify([error]), 1, 2);
    expect(state.isLoading()).toBe(true);
    expect(window.__pendingStreamClientMessageId).toBe('current');
  });

  it('rejects an obsolete owned error tail before changing the current waiting state', () => {
    const state = createHarness();
    window.updateMessages!(JSON.stringify([user('previous')]), 3);
    markPendingStreamStart('current');
    window.showLoading!('true');
    window.updateMessageTail!(JSON.stringify([user('current'), error]), 1, 2);
    expect(state.getMessages()).toHaveLength(1);
    expect(state.isLoading()).toBe(true);
    expect(window.__pendingStreamClientMessageId).toBe('current');
  });

  it.each(['full', 'tail'])('does not assign a tagged older error to a current user in the same %s payload', (transport) => {
    const state = createHarness();
    window.updateMessages!(JSON.stringify([user('previous')]), 1);
    markPendingStreamStart('current');
    window.showLoading!('true');
    const payload = JSON.stringify([user('current'), { ...error, raw: { clientMessageId: 'previous' } }]);
    if (transport === 'full') window.updateMessages!(payload, 2);
    else window.updateMessageTail!(payload, 1, 2);
    expect(state.isLoading()).toBe(true);
    expect(window.__pendingStreamClientMessageId).toBe('current');
  });

  it('keeps an older identity from retiring an expired newer submission', () => {
    const state = createHarness();
    markPendingStreamStart('current');
    window.showLoading!('true');
    vi.advanceTimersByTime(8001);
    window.updateMessages!(JSON.stringify([user('previous'), error]), 1);
    expect(state.isLoading()).toBe(true);
    expect(window.__pendingStreamClientMessageId).toBe('current');
  });

  it('retires pending identity when a loading reset is accepted after cleanup immunity expires', () => {
    const state = createHarness();
    markPendingStreamStart('current');
    window.showLoading!('true');
    vi.advanceTimersByTime(8001);
    window.showLoading!('false');
    expect(state.isLoading()).toBe(false);
    expect(window.__pendingStreamClientMessageId).toBeUndefined();
  });
});
