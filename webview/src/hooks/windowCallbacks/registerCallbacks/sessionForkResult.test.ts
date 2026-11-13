import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { registerSessionAndSdkCallbacks } from './sessionCallbacks';

/**
 * The fork result callback drives three different outcomes from one payload:
 * auto-open a message-level fork, refresh the list for a history-level fork, and
 * report failures. The pending-title global is the fragile part — it must be
 * claimed by the fork that will actually open, and never left behind.
 */
describe('session fork result', () => {
  const addToast = vi.fn();
  const loadHistorySession = vi.fn();
  const loadHistorySessionRef = { current: loadHistorySession };
  const setCustomSessionTitle = vi.fn();
  const options = {
    currentSessionIdRef: { current: 'root' },
    currentProviderRef: { current: 'claude' },
    customSessionTitleRef: { current: null as string | null },
    setRestoredSessionTitle: vi.fn(),
    setCustomSessionTitle,
    applyHistoryTitleLocal: vi.fn(),
    addToast,
    loadHistorySessionRef,
  } as unknown as UseWindowCallbacksOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    loadHistorySessionRef.current = loadHistorySession;
    options.currentProviderRef.current = 'claude';
    delete window.__pendingForkTitle;
    delete window.__pendingForkTitleRequest;
    delete window.__pendingForkProvider;
    delete window.__pendingSessionTransitionToast;
    delete window.__forkInFlightRequestId;
    delete window.__forkInFlightTimer;
    window.__forkInFlight = true;
    window.sendToJava = vi.fn();
    registerSessionAndSdkCallbacks(
      options,
      { current: ((key: string) => key) as UseWindowCallbacksOptions['t'] },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-opens a message-level fork and keeps its title for the switch', () => {
    window.__pendingForkTitleRequest = 'Chat (fork)';

    window.onForkResult!(
      JSON.stringify({ success: true, newSessionId: 'fork-1', forkPointUuid: 'row-uuid-1' }),
    );

    expect(loadHistorySession).toHaveBeenCalledWith('fork-1');
    expect(window.__pendingForkTitle).toEqual({ sessionId: 'fork-1', title: 'Chat (fork)' });
    expect(window.__pendingSessionTransitionToast).toMatchObject({ type: 'success' });
    expect(window.__pendingForkTitleRequest).toBeUndefined();
    expect(window.__forkInFlight).toBe(false);
  });

  it('auto-opens through the fork row provider, not the panel provider', () => {
    // The author's provider-switch scenario: a Claude fork requested from the
    // message level, the panel switched to codex while it ran. The fork row is
    // absent from historyData until the async reload lands, so falling back to
    // currentProvider would emit load_session with provider "codex" and open
    // the fork through the wrong provider.
    options.currentProviderRef.current = 'codex';
    window.__pendingForkProvider = 'claude';
    window.__pendingForkTitleRequest = 'Chat (fork)';

    window.onForkResult!(
      JSON.stringify({ success: true, newSessionId: 'fork-1', forkPointUuid: 'row-uuid-1' }),
    );

    expect(loadHistorySession).toHaveBeenCalledWith('fork-1', 'claude');
  });

  it('auto-opens through the ref so a re-created loader is the one invoked', () => {
    // loadHistorySession is a useCallback recreated whenever `loading` changes;
    // callbacks register once on mount, so the ref — not the closure — is what
    // keeps a mid-stream auto-open interrupting before it clears the reply.
    const latestLoader = vi.fn();
    loadHistorySessionRef.current = latestLoader;

    window.onForkResult!(
      JSON.stringify({ success: true, newSessionId: 'fork-3', forkPointUuid: 'row-uuid-3' }),
    );

    expect(latestLoader).toHaveBeenCalledWith('fork-3');
    expect(loadHistorySession).not.toHaveBeenCalled();
  });

  it('leaves a history-list fork title to the backend instead of stashing it', () => {
    window.__pendingForkTitleRequest = 'Chat (fork)';

    window.onForkResult!(JSON.stringify({ success: true, newSessionId: 'fork-2' }));

    // No auto-open, so nothing would ever consume a stashed title; the backend has
    // already written it through the custom-title service.
    expect(loadHistorySession).not.toHaveBeenCalled();
    expect(window.__pendingForkTitle).toBeUndefined();
    expect(window.__pendingForkTitleRequest).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith('history.forkSuccess', 'success');
  });

  it('reloads the list with the fork row provider, not the panel provider', () => {
    // The panel switched to codex while the claude list stayed open: reloading
    // through currentProviderRef would replace the list with codex rows and the
    // new fork row would never appear.
    options.currentProviderRef.current = 'codex';
    window.__pendingForkProvider = 'claude';

    window.onForkResult!(JSON.stringify({ success: true, newSessionId: 'fork-4' }));

    const sent = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls
      .map(([payload]) => String(payload));
    expect(sent).toContain('deep_search_history:claude');
    expect(sent).not.toContain('deep_search_history:codex');
    // Consumed on success so a later fork cannot reuse the stale row provider.
    expect(window.__pendingForkProvider).toBeUndefined();
  });

  it('drops the requested title and provider stash when the fork fails', () => {
    window.__pendingForkTitleRequest = 'Chat (fork)';
    window.__pendingForkProvider = 'claude';

    window.onForkResult!(JSON.stringify({ success: false, errorCode: 'FORK_FAILED' }));

    expect(window.__pendingForkTitle).toBeUndefined();
    expect(window.__pendingForkTitleRequest).toBeUndefined();
    expect(window.__pendingForkProvider).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith('history.forkErrors.FORK_FAILED', 'error');
    expect(window.__forkInFlight).toBe(false);
  });

  it('retires the 60s backstop timer when a successful result arrives', () => {
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    window.__forkInFlightTimer = 123;

    window.onForkResult!(JSON.stringify({ success: true, newSessionId: 'fork-5' }));

    expect(clearTimeoutSpy).toHaveBeenCalledWith(123);
    expect(window.__forkInFlightTimer).toBeUndefined();
  });

  it('retires the backstop timer on a failed result too', () => {
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    window.__forkInFlightTimer = 456;

    window.onForkResult!(JSON.stringify({ success: false, errorCode: 'FORK_FAILED' }));

    expect(clearTimeoutSpy).toHaveBeenCalledWith(456);
    expect(window.__forkInFlightTimer).toBeUndefined();
  });

  it('settles the in-flight request when the echoed requestId matches', () => {
    window.__forkInFlightRequestId = 'fork-b';
    window.__pendingForkTitleRequest = 'Chat (fork)';

    window.onForkResult!(JSON.stringify({ requestId: 'fork-b', success: true, newSessionId: 'fork-6' }));

    expect(window.__forkInFlight).toBe(false);
    expect(window.__forkInFlightRequestId).toBeUndefined();
    expect(window.__pendingForkTitleRequest).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith('history.forkSuccess', 'success');
  });

  it('ignores a stale result that settles a different request than the one in flight', () => {
    // Fork A outlived the 60s backstop, fork B started: A's late result must
    // not release B's guard, consume B's pending title/provider or auto-open
    // A's session under B's title.
    window.__forkInFlightRequestId = 'fork-b';
    window.__pendingForkTitleRequest = 'Chat B (fork)';
    window.__pendingForkProvider = 'claude';

    window.onForkResult!(
      JSON.stringify({ requestId: 'fork-a', success: true, newSessionId: 'fork-old', forkPointUuid: 'row-old' }),
    );

    expect(window.__forkInFlight).toBe(true);
    expect(window.__forkInFlightRequestId).toBe('fork-b');
    expect(window.__pendingForkTitleRequest).toBe('Chat B (fork)');
    expect(window.__pendingForkProvider).toBe('claude');
    expect(loadHistorySession).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('ignores a stale failed result for the same reason', () => {
    window.__forkInFlightRequestId = 'fork-b';
    window.__pendingForkTitleRequest = 'Chat B (fork)';

    window.onForkResult!(JSON.stringify({ requestId: 'fork-a', success: false, errorCode: 'FORK_FAILED' }));

    expect(window.__forkInFlight).toBe(true);
    expect(window.__pendingForkTitleRequest).toBe('Chat B (fork)');
    expect(addToast).not.toHaveBeenCalled();
  });

  it('honors a late result after the backstop released the guard', () => {
    // No request is in flight anymore (the 60s backstop fired and dropped the
    // correlation id): the pending state belongs to that same fork, so the
    // result is honored and the fork still lands in the list.
    window.__pendingForkTitleRequest = 'Chat A (fork)';

    window.onForkResult!(JSON.stringify({ requestId: 'fork-a', success: true, newSessionId: 'fork-7' }));

    expect(window.__forkInFlight).toBe(false);
    expect(window.__pendingForkTitleRequest).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith('history.forkSuccess', 'success');
  });
});
