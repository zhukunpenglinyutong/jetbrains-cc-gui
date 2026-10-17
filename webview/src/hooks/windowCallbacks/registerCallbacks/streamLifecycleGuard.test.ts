/**
 * streamLifecycleGuard.test.ts
 *
 * Regression coverage for the pending-stream-start immunity window
 * (streamLifecycle.ts) wired through the registered window callbacks:
 *
 * After the user interrupts a turn, the backend emits late cleanup echoes
 * (showLoading(false)) once the killed process tree is reaped. If a queued
 * message was dispatched in the meantime, those echoes must NOT reset the
 * loading state — otherwise the queue drain dispatches the next item while
 * the previous send is still booting, overlapping two live turns on one
 * Codex thread.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerMessageCallbacks } from './messageCallbacks';
import { registerStreamingCallbacks } from './streamingCallbacks';
import { releaseSessionTransition } from '../sessionTransition';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import {
  markPendingStreamStart,
  isPendingStreamStartActive,
  clearPendingStreamStart,
} from '../../../utils/streamLifecycle';

const ref = <T,>(value: T) => ({ current: value });

function createHarness(loadingValues: boolean[]) {
  let loadingState = false;
  const options = {
    addToast: () => {},
    setMessages: () => {},
    setStatus: () => {},
    // Mirrors React's functional-update contract: the showLoading handler
    // always passes an updater function.
    setLoading: (value: boolean | ((prev: boolean) => boolean)) => {
      const next = typeof value === 'function' ? (value as (prev: boolean) => boolean)(loadingState) : value;
      loadingState = next;
      loadingValues.push(next);
    },
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
    currentSessionIdRef: ref(null),
    currentProviderRef: ref('codex'),
  } as unknown as UseWindowCallbacksOptions;

  registerMessageCallbacks(options, () => {}, () => {});
  return options;
}

describe('pending-stream-start immunity window', () => {
  beforeEach(() => {
    clearPendingStreamStart();
    window.__sessionTransitioning = false;
    window.__deferredTransitionUpdateMessages = null;
    window.__minAcceptedUpdateSequence = 0;
  });

  it('marks, reports, and clears the pending stream start', () => {
    expect(isPendingStreamStartActive()).toBe(false);
    markPendingStreamStart();
    expect(isPendingStreamStartActive()).toBe(true);
    clearPendingStreamStart();
    expect(isPendingStreamStartActive()).toBe(false);
  });

  it('expires cleanup immunity while retaining the pending submission identity', () => {
    markPendingStreamStart('slow-submission');
    // Simulate the window elapsing without waiting 8 real seconds.
    window.__pendingStreamStartAt = Date.now() - 8001;
    expect(isPendingStreamStartActive()).toBe(false);
    // A delayed terminal snapshot still needs proof that it owns this submission.
    expect(window.__pendingStreamStartAt).toBeDefined();
    expect(window.__pendingStreamClientMessageId).toBe('slow-submission');
  });

  it('suppresses the interrupted turn\'s late showLoading(false) echo', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);

    markPendingStreamStart(); // executeMessage dispatched a queued message

    window.showLoading!('false'); // late echo from the interrupted turn
    expect(loadingValues).not.toContain(false);

    // loading=true from the dispatch path is unaffected.
    window.showLoading!('true');
    expect(loadingValues).toContain(true);
  });

  it('lets a genuine error snapshot release the suppression', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);

    markPendingStreamStart();
    window.showLoading!('false'); // echo — suppressed
    expect(loadingValues).not.toContain(false);

    // Java pushes the error snapshot BEFORE the state-change notification.
    const errorSnapshot = JSON.stringify([
      { type: 'ERROR', content: 'Codex thread is busy: already has an active writer' },
    ]);
    window.updateMessages!(errorSnapshot);

    window.showLoading!('false'); // the genuine failure's loading reset
    expect(loadingValues).toContain(false);
  });

  it('keeps an older error-only snapshot from ending a newly submitted Codex message', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);
    markPendingStreamStart('new-submission');
    window.updateMessages!(JSON.stringify([
      { type: 'USER', raw: { clientMessageId: 'old-submission' }, content: 'old task' },
      { type: 'ERROR', content: 'previous writer exited' },
    ]));
    expect(isPendingStreamStartActive()).toBe(true);
    expect(loadingValues).not.toContain(false);
    window.updateMessages!(JSON.stringify([
      { type: 'USER', raw: { clientMessageId: 'new-submission' }, content: 'new task' },
      { type: 'ERROR', content: 'current startup failed' },
    ]));
    expect(isPendingStreamStartActive()).toBe(false);
    expect(loadingValues).toContain(false);
  });

  it('ends waiting when a current startup error commits after a session transition', () => {
    const loadingValues: boolean[] = [];
    const options = createHarness(loadingValues);
    registerStreamingCallbacks(options);
    window.__sessionTransitioning = true;
    markPendingStreamStart('current-submission');
    window.showLoading!('true');

    // Restored-session callbacks can finish before React releases the transition.
    window.onStreamEnd!();
    window.updateMessages!(JSON.stringify([
      { type: 'user', content: 'new task', raw: { clientMessageId: 'current-submission' } },
      { type: 'error', content: 'thread already has an active writer' },
    ]), 3);
    window.showLoading!('false');
    expect(loadingValues.at(-1)).toBe(true);

    releaseSessionTransition();
    expect(isPendingStreamStartActive()).toBe(false);
    expect(loadingValues.at(-1)).toBe(false);
  });

  it('keeps an older deferred startup error from ending a new submission', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);
    window.__sessionTransitioning = true;
    markPendingStreamStart('current-submission');
    window.showLoading!('true');
    window.updateMessages!(JSON.stringify([
      { type: 'user', content: 'old task', raw: { clientMessageId: 'previous-submission' } },
      { type: 'error', content: 'previous startup failed' },
    ]), 3);

    releaseSessionTransition();
    expect(isPendingStreamStartActive()).toBe(true);
    expect(loadingValues.at(-1)).toBe(true);
  });

  it('rejects an obsolete deferred error before it can release the pending start', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);
    window.__sessionTransitioning = true;
    markPendingStreamStart('current-submission');
    window.showLoading!('true');
    window.updateMessages!(JSON.stringify([
      { type: 'user', content: 'new task', raw: { clientMessageId: 'current-submission' } },
      { type: 'error', content: 'obsolete writer failure' },
    ]), 3);

    window.__minAcceptedUpdateSequence = 4;
    releaseSessionTransition();
    expect(isPendingStreamStartActive()).toBe(true);
    expect(loadingValues.at(-1)).toBe(true);
  });

  it('stops suppressing once the immunity window elapses', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);

    markPendingStreamStart();
    window.__pendingStreamStartAt = Date.now() - 8001; // window elapsed

    window.showLoading!('false');
    expect(loadingValues).toContain(false);
  });

  it('releases startup failures even when stream-end precedes the error snapshot', () => {
    const loadingValues: boolean[] = [];
    const options = createHarness(loadingValues);
    registerStreamingCallbacks(options);
    markPendingStreamStart();
    window.onStreamEnd!();
    window.updateMessages!(JSON.stringify([
      { type: 'USER', content: 'new task' },
      { type: 'ERROR', content: 'thread already has an active writer' },
    ]));
    window.showLoading!('false');
    expect(isPendingStreamStartActive()).toBe(false);
    expect(loadingValues).toContain(false);
  });

  it('does not let an older error in history release a freshly dispatched turn', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);
    markPendingStreamStart();
    window.updateMessages!(JSON.stringify([
      { type: 'ERROR', content: 'an older failed turn' },
      { type: 'USER', content: 'new task' },
    ]));
    window.showLoading!('false');
    expect(isPendingStreamStartActive()).toBe(true);
    expect(loadingValues).not.toContain(false);
  });

  it('ends waiting when the startup error snapshot arrives after the loading reset', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);
    markPendingStreamStart();
    window.showLoading!('false');
    expect(loadingValues).not.toContain(false);
    window.updateMessages!(JSON.stringify([
      { type: 'user', content: 'new task' },
      { type: 'error', content: 'codex app-server exited (code=0, signal=null)' },
    ]));
    expect(isPendingStreamStartActive()).toBe(false);
    expect(loadingValues).toContain(false);
  });

  it('keeps the loading state when an older turn\'s onStreamEnd arrives mid-boot', () => {
    // Simulates the repeat-send chain: a queued message was dispatched (marker
    // armed), then the interrupted turn's late onStreamEnd lands. Its loading
    // reset must not claim the freshly dispatched turn's loading state —
    // otherwise the queue drain fires again and the queued messages resend.
    let loadingResets = 0;
    const options = {
      setMessages: () => {},
      setStreamingActive: () => {},
      setLoading: (value: boolean | ((prev: boolean) => boolean)) => {
        if (value === false || (typeof value === 'function' && value(true) === false)) {
          loadingResets += 1;
        }
      },
      setLoadingStartTime: () => {},
      setIsThinking: () => {},
      setExpandedThinking: () => {},
      streamingContentRef: ref(''),
      streamingThinkingRef: ref(''),
      isStreamingRef: ref(false),
      useBackendStreamingRenderRef: ref(false),
      autoExpandedThinkingKeysRef: ref(new Set<string>()),
      streamingMessageIndexRef: ref(-1),
      streamingTurnIdRef: ref(7),
      turnIdCounterRef: ref(7),
      recordStreamingBlockReset: () => {},
      clearStreamingBlockResets: () => {},
      lastContentUpdateRef: ref(0),
      contentUpdateTimeoutRef: ref<number | null>(null),
      lastThinkingUpdateRef: ref(0),
      thinkingUpdateTimeoutRef: ref<number | null>(null),
      currentProviderRef: ref('codex'),
      getOrCreateStreamingAssistantIndex: () => -1,
      patchAssistantForStreaming: (message: unknown) => message,
      findLastAssistantIndex: () => -1,
    } as unknown as UseWindowCallbacksOptions;

    registerStreamingCallbacks(options);

    markPendingStreamStart();
    // isStreamingRef=false but streamingTurnIdRef=7 → handlingMode 'full':
    // the exact ref state left behind by interruptSession for the old turn.
    window.onStreamEnd!();

    // The dispatched turn's marker and loading state survive the echo.
    expect(isPendingStreamStartActive()).toBe(true);
    expect(loadingResets).toBe(0);

    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  });
});
