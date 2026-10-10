import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { registerSessionAndSdkCallbacks } from './sessionCallbacks';

describe('restored session bootstrap', () => {
  const options = () => ({
    currentSessionIdRef: { current: null },
    customSessionTitleRef: { current: null },
    setCurrentSessionId: vi.fn(),
  } as unknown as UseWindowCallbacksOptions);
  const tRef = { current: ((key: string) => key) as UseWindowCallbacksOptions['t'] };

  afterEach(() => { delete window.__pendingSessionId; });

  it('hands the pre-React session identity to the live callback and consumes it once', () => {
    const opts = options();
    window.__pendingSessionId = 'restored-root';
    registerSessionAndSdkCallbacks(opts, tRef);
    expect(opts.currentSessionIdRef.current).toBe('restored-root');
    expect(opts.setCurrentSessionId).toHaveBeenCalledExactlyOnceWith('restored-root');
    expect(window.__pendingSessionId).toBeUndefined();

    window.setSessionId!('next-root');
    registerSessionAndSdkCallbacks(opts, tRef);
    expect(opts.currentSessionIdRef.current).toBe('next-root');
    expect(opts.setCurrentSessionId).toHaveBeenCalledTimes(2);
  });

  it('leaves the live session intact when no identity was buffered', () => {
    const opts = options();
    opts.currentSessionIdRef.current = 'live-root';
    registerSessionAndSdkCallbacks(opts, tRef);
    expect(opts.currentSessionIdRef.current).toBe('live-root');
    expect(opts.setCurrentSessionId).not.toHaveBeenCalled();
  });
});
