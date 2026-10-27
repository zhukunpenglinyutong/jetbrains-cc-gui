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
  const setCustomSessionTitle = vi.fn();
  const options = {
    currentSessionIdRef: { current: 'root' },
    currentProviderRef: { current: 'claude' },
    customSessionTitleRef: { current: null as string | null },
    setRestoredSessionTitle: vi.fn(),
    setCustomSessionTitle,
    applyHistoryTitleLocal: vi.fn(),
    addToast,
    loadHistorySession,
  } as unknown as UseWindowCallbacksOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__pendingForkTitle;
    delete window.__pendingForkTitleRequest;
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

  it('drops the requested title when the fork fails', () => {
    window.__pendingForkTitleRequest = 'Chat (fork)';

    window.onForkResult!(JSON.stringify({ success: false, errorCode: 'FORK_FAILED' }));

    expect(window.__pendingForkTitle).toBeUndefined();
    expect(window.__pendingForkTitleRequest).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith('history.forkErrors.FORK_FAILED', 'error');
    expect(window.__forkInFlight).toBe(false);
  });
});
