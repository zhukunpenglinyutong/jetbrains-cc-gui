import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    window.__forkInFlight = true;
    window.sendToJava = vi.fn();
    registerSessionAndSdkCallbacks(
      options,
      { current: ((key: string) => key) as UseWindowCallbacksOptions['t'] },
    );
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
});
